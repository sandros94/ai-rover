import type { H3Event } from 'nitro/h3'
import { HTTPError } from 'nitro/h3'
import { defineSession } from 'unauth/base/h3v2'
import type { AuthProvider, SignedInSession, User, UserSession } from '../../types'
import type { SessionKey } from './key'
import { sessionKey } from './key'

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/** The session token's payload: the user's fields flat, `id` as `sub`, never a token. */
interface Claims {
  sub: string
  providers: AuthProvider[]
  displayName: string
  avatarUrl?: string
  handle?: string
  loggedInAt: number
  [claim: string]: unknown
}

type UseSession = ReturnType<typeof defineSession<Claims>>

export interface UserSessionsOptions {
  /** `NUXT_SESSION_KEY`; empty is accepted only in dev. */
  key: string
  dev: boolean
}

export interface UserSessions {
  /** The session, or `{}` when signed out. */
  get(event: H3Event): Promise<UserSession>
  /** Merges `data.user` into the signed-in user; `loggedInAt` resets only when the user changes. */
  set(event: H3Event, data: UserSession): Promise<UserSession>
  /** Replaces the whole session; `loggedInAt` resets only when the user changes. */
  replace(event: H3Event, data: UserSession): Promise<UserSession>
  clear(event: H3Event): Promise<void>
  /** The signed-in session, or a 401. */
  require(event: H3Event): Promise<SignedInSession>
}

/** Cookie names carry `__Host-` outside dev, which binds them to https, this host and path `/`. */
export function cookieName(base: string, dev: boolean): string {
  return dev ? base : `__Host-${base}`
}

export function sealingOptions() {
  return { encryptOptions: { alg: 'dir', enc: 'A256GCM' } as const }
}

/**
 * Cookie sessions sealed as JWE with `dir` + `A256GCM`, lasting 7 days and re-issued with the
 * same claims once 75% of that has passed. Throws at definition when the key is missing or
 * malformed outside dev.
 */
export function createUserSessions(options: UserSessionsOptions): UserSessions {
  return createUserSessionsWithKey(sessionKey(options.key, options.dev), options.dev)
}

export function createUserSessionsWithKey(key: SessionKey, dev: boolean): UserSessions {
  let defined: Promise<UseSession> | undefined
  const use = async (event: H3Event) => {
    defined ??= key().then((jwk) =>
      defineSession<Claims>({
        key: jwk,
        name: cookieName('jev-session', dev),
        maxAge: SESSION_MAX_AGE_SECONDS,
        cookie: { httpOnly: true, secure: !dev, sameSite: 'lax', path: '/' },
        jwe: sealingOptions(),
      }),
    )
    return (await defined)(event)
  }

  async function get(event: H3Event): Promise<UserSession> {
    const session = await use(event)
    return session.id ? fromClaims(session.data as Claims) : {}
  }

  async function write(event: H3Event, next: UserSession, previous: UserSession) {
    if (!next.user) {
      await clear(event)
      return {}
    }
    const loggedInAt =
      previous.user?.id === next.user.id && previous.loggedInAt ? previous.loggedInAt : Date.now()
    const claims = toClaims({ user: next.user, loggedInAt })
    const session = await use(event)
    await session.update((data) => {
      for (const name of Object.keys(data)) delete (data as Record<string, unknown>)[name]
      return claims
    })
    return fromClaims(claims)
  }

  async function clear(event: H3Event) {
    await (await use(event)).clear()
  }

  return {
    get,
    async set(event, data) {
      const previous = await get(event)
      const user = data.user && { ...previous.user, ...data.user }
      return write(event, { ...data, user: user as User | undefined }, previous)
    },
    async replace(event, data) {
      return write(event, data, await get(event))
    },
    clear,
    async require(event) {
      const session = await get(event)
      if (!session.user) throw new HTTPError({ status: 401, message: 'Sign in first.' })
      return session as SignedInSession
    },
  }
}

function toClaims({ user, loggedInAt }: { user: User; loggedInAt: number }): Claims {
  const { id, ...fields } = user
  return { ...fields, sub: id, loggedInAt }
}

function fromClaims(claims: Claims): UserSession {
  const { sub, loggedInAt, jti: _jti, iat: _iat, exp: _exp, ...fields } = claims
  return { user: { ...(fields as Omit<User, 'id'>), id: sub }, loggedInAt }
}
