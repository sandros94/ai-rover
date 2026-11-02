import type { H3Event } from 'nitro/h3'
import { HTTPError } from 'nitro/h3'
import type { SessionDefinition, SessionManager } from 'unjwt/session'
import { defineJWESession } from 'unjwt/session'
import type { SessionData, SessionUser } from '#shared/types/session'
import type { SecretKey } from './app-secret'
import { appSecretKey } from './app-secret'

/** How long a session token lasts. */
export const SESSION_MAX_AGE = '7D'

/** 75% of {@link SESSION_MAX_AGE}: a token read at least this old is re-issued for 7 more days. */
export const SESSION_ROLLING = '126h'

/** Clock skew between server instances that a token's `iat` and `exp` are allowed. */
const CLOCK_TOLERANCE = '5s'

/** The session of one request: `id` unset and `data` empty while signed out. */
export type AuthSession = SessionManager<SessionData, typeof SESSION_MAX_AGE>

export type SignedInAuthSession = AuthSession & { id: string }

export interface AuthSessions {
  /** The request's session, read once per request and shared by every later call. */
  use(event: H3Event): Promise<AuthSession>
  /** The request's signed-in session, or a 401. */
  require(event: H3Event): Promise<SignedInAuthSession>
}

export interface AuthSessionsOptions {
  /** The key sealing the cookie, asked for on first use; a failure is asked again next time. */
  key: SecretKey
  /** Under `nuxt dev` the cookie is `rover-session` without `Secure`, for plain-http loopback. */
  dev: boolean
}

/**
 * Cookie sessions sealed as JWE (`dir`, `A256GCM`) in `__Host-rover-session`: `HttpOnly`,
 * `SameSite=Lax`, path `/`, lasting {@link SESSION_MAX_AGE} and re-issued once
 * {@link SESSION_ROLLING} old. Tokens carry the `session+jwt` type; any other cookie under the
 * name, expired or sealed with another key, reads as signed out and is expired.
 */
export function createAuthSessions(options: AuthSessionsOptions): AuthSessions {
  const { key, dev } = options
  let defined: Promise<SessionDefinition<SessionData, typeof SESSION_MAX_AGE>> | undefined
  const define = () =>
    (defined ??= key().then(
      (jwk) =>
        defineJWESession<SessionData, typeof SESSION_MAX_AGE>({
          key: jwk,
          name: dev ? 'rover-session' : '__Host-rover-session',
          maxAge: SESSION_MAX_AGE,
          rolling: SESSION_ROLLING,
          cookie: { httpOnly: true, secure: !dev, sameSite: 'lax', path: '/' },
          jwe: { decryptOptions: { clockTolerance: CLOCK_TOLERANCE } },
        }),
      (error: unknown) => {
        defined = undefined
        throw error
      },
    ))

  const use = async (event: H3Event) => (await define()).use(event)
  return {
    use,
    async require(event) {
      const session = await use(event)
      if (!session.id) throw new HTTPError({ status: 401, message: 'Sign in first.' })
      return session as SignedInAuthSession
    },
  }
}

let platform: AuthSessions | undefined

/** The server's sessions, sealed with the key Nuxt derives from `NUXT_APP_SECRET`. */
export function useAuthSessions(): AuthSessions {
  return (platform ??= createAuthSessions({
    key: appSecretKey('ai-rover:session'),
    dev: Boolean(import.meta.dev),
  }))
}

export function useAuthSession(event: H3Event): Promise<AuthSession> {
  return useAuthSessions().use(event)
}

/** The signed-in session, or a 401. */
export function requireAuthSession(event: H3Event): Promise<SignedInAuthSession> {
  return useAuthSessions().require(event)
}

/** The user `session` is signed in as, if any. */
export function signedInUser(session: Pick<AuthSession, 'id' | 'data'>): SessionUser | undefined {
  return session.id ? session.data.user : undefined
}

/**
 * Signs `user` in on `session`, replacing whatever it held. `loggedInAt` carries over when the
 * same user signs in again and starts now for anyone else.
 */
export async function signInSession(session: AuthSession, user: SessionUser): Promise<void> {
  const previous = session.id ? session.data : undefined
  const loggedInAt = previous?.user.id === user.id ? previous.loggedInAt : Date.now()
  await session.clear()
  await session.update({ user, loggedInAt })
}
