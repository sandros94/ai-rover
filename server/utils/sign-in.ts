import type { H3Event } from 'nitro/h3'
import { HTTPError, redirect } from 'nitro/h3'
import type { KnownUnauthErrorCode } from 'unauth/n'
import { isUnauthError } from 'unauth/n'
import type { SessionUser } from '#shared/types/session'
import type { AuthProvider, SignInErrorCode } from '#shared/utils/sign-in'
import { SIGN_IN_ERRORS } from '#shared/utils/sign-in'
import type { DB } from '../database/db'
import { DbError, postgresErrorOf } from '../database/errors'
import type { UserAccount } from '../database/schema'
import type { ProvenIdentity } from '../repositories/users'
import {
  createUserWithIdentity,
  findUser,
  linkIdentity,
  mergeUsers,
  recordSignIn,
} from '../repositories/users'
import type { AuthSessions } from './session'
import { signedInUser, signInSession } from './session'

/** A sign-in a provider completed: the identity it proved and what the start asked for. */
export interface SignIn {
  identity: ProvenIdentity
  /** The signed-in user the identity joins, when the start asked to link. */
  linkTo?: string
  /** Same-origin path to land on. */
  redirect: string
}

/**
 * Turns a proven identity into the signed-in user. Signing in: the account holding the identity,
 * else a new account from it. Linking: the user who started the link must still be the one
 * signed in (`link-changed` otherwise); an unclaimed identity joins that account, one held by
 * another account brings that whole account over (see `mergeUsers`). Then sets the session and
 * lands on the requested path.
 */
export async function completeSignIn(
  event: H3Event,
  { db, sessions }: { db: DB; sessions: Pick<AuthSessions, 'use'> },
  { identity, linkTo, redirect: landing }: SignIn,
) {
  const session = await sessions.use(event)
  const previous = signedInUser(session)
  if (linkTo && previous?.id !== linkTo) {
    throw signInFailure('link-changed', {
      status: 409,
      message: 'The signed-in user changed during linking.',
    })
  }

  let user = await recordSignIn(db, identity)
  if (linkTo && user?.id !== linkTo) {
    const holder = user
    user = await refusingConflicts(async () => {
      if (holder) return mergeUsers(db, { into: linkTo, from: holder.id })
      await linkIdentity(db, linkTo, identity)
      return (await findUser(db, linkTo))!
    })
  }
  user ??= await createUserWithIdentity(db, identity)

  const providers: AuthProvider[] =
    previous?.id === user.id
      ? [...new Set([...previous.providers, identity.provider])]
      : [identity.provider]
  await signInSession(session, sessionUser(user, providers))
  return redirect(landing, 302)
}

/** A same-origin path to land on after sign-in; anything else lands on `/`. */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048) return '/'
  if (value.startsWith('//') || value.startsWith('/\\')) return '/'
  const url = new URL(value, 'http://path.invalid')
  return url.origin === 'http://path.invalid' ? url.pathname + url.search + url.hash : '/'
}

/** The session's view of `account`, with the providers proven in this browser session. */
export function sessionUser(account: UserAccount, providers: AuthProvider[]): SessionUser {
  return {
    id: account.id,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl ?? undefined,
    handle: account.handle ?? undefined,
    providers,
  }
}

/** A failed sign-in whose code the user reads, for {@link signInErrorCode}. */
export function signInFailure(
  code: SignInErrorCode,
  init: { status: number; message: string; cause?: unknown },
): HTTPError {
  return new HTTPError({ ...init, data: { reason: code } })
}

async function refusingConflicts(run: () => Promise<UserAccount>): Promise<UserAccount> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof DbError && error.code === 'INVALID_STATE') {
      throw signInFailure('link-conflict', { status: 409, message: error.message, cause: error })
    }
    throw error
  }
}

/** The code each failed flow of `unauth/n` lands with; any code not listed is `sign-in-failed`. */
const UNAUTH_FAILURES: Partial<Record<KnownUnauthErrorCode, SignInErrorCode>> = {
  ERR_AUTHN_FLOW_EXPIRED: 'state-mismatch',
  ERR_AUTHN_STATE_MISMATCH: 'state-mismatch',
  ERR_AUTHN_PROVIDER_REFUSED: 'refused',
  ERR_AUTHN_LOGIN_HINT_REQUIRED: 'handle',
  ERR_AUTHN_LOGIN_HINT_INVALID: 'handle',
  ERR_AUTHN_TOKEN_EXCHANGE: 'provider',
  ERR_AUTHN_PROFILE_INVALID: 'provider',
  ERR_AUTHN_PROVIDER_ERROR: 'provider',
}

/**
 * The code a failed sign-in redirects with; the failure's own message never leaves the server.
 * An `UnauthError` by its code, an HTTPError by the code it was built with (see
 * {@link signInFailure}); otherwise `database` for a Postgres failure underneath, `provider` for
 * an HTTPError 502 or 504.
 */
export function signInErrorCode(error: unknown): SignInErrorCode {
  if (isUnauthError(error)) {
    return Object.hasOwn(UNAUTH_FAILURES, error.code)
      ? UNAUTH_FAILURES[error.code as KnownUnauthErrorCode]!
      : 'sign-in-failed'
  }
  const data = error instanceof HTTPError ? (error.data as { reason?: unknown } | undefined) : {}
  const reason = data?.reason
  if (typeof reason === 'string' && Object.hasOwn(SIGN_IN_ERRORS, reason)) {
    return reason as SignInErrorCode
  }
  if (postgresErrorOf(causeOf(error))) return 'database'
  if (error instanceof HTTPError && (error.status === 502 || error.status === 504)) {
    return 'provider'
  }
  return 'sign-in-failed'
}

/**
 * The failure underneath `error`: an `UnauthError`'s structured `cause`, the `cause` an HTTPError
 * was built with (h3 keeps it inside the options object it stores as `error.cause`), or any other
 * error itself.
 */
function causeOf(error: unknown): unknown {
  if (isUnauthError(error)) return error.cause
  if (!(error instanceof HTTPError)) return error
  const stored: unknown = error.cause
  return stored instanceof Error ? stored : (stored as { cause?: unknown } | undefined)?.cause
}

/**
 * Answers a failed sign-in: logs it and lands with its code on the login page, or on the
 * settings page when someone is signed in, since only linking fails for them.
 */
export async function failSignIn(
  event: H3Event,
  error: unknown,
  sessions: Pick<AuthSessions, 'use'>,
) {
  const code = signInErrorCode(error)
  const status = (error as { status?: unknown } | null)?.status
  const shown = typeof status === 'number' ? status : 500
  const message = error instanceof Error ? error.message : String(error)
  const cause = causeOf(error)
  const log = shown >= 500 ? console.error : console.warn
  log(`[auth] sign-in failed (${code}): ${shown} ${message}`, ...(cause ? [cause] : []))
  const page = signedInUser(await sessions.use(event)) ? '/settings' : '/login'
  return redirect(`${page}?${new URLSearchParams({ error: code })}`, 302)
}
