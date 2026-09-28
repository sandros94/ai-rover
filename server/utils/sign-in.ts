import type { H3Event, HTTPError } from 'nitro/h3'
import { redirect } from 'nitro/h3'
import type { AuthProvider, User } from '#auth'
import type { SignInErrorCode } from '#shared/utils/sign-in'
import type { OAuthResult } from '../../modules/auth/runtime/server/lib/oauth'
import {
  oauthCauseOf,
  oauthError,
  oauthFailureOf,
} from '../../modules/auth/runtime/server/lib/oauth'
import type { UserSessions } from '../../modules/auth/runtime/server/lib/session'
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

/**
 * Turns a proven identity into the signed-in user. Signing in: the account holding the identity,
 * else a new account from it. Linking (the flow names the signed-in user): an unclaimed identity
 * joins the signed-in account; one held by another account brings that whole account over (see
 * `mergeUsers`). Then sets the session and lands on the requested path.
 */
export async function completeSignIn(
  event: H3Event,
  { db, sessions }: { db: DB; sessions: UserSessions },
  result: OAuthResult,
) {
  const identity: ProvenIdentity = {
    provider: result.provider,
    subject: result.subject,
    profile: {
      displayName: result.profile.displayName,
      avatarUrl: result.profile.avatarUrl ?? null,
      handle: result.profile.handle ?? null,
    },
  }
  let user = await recordSignIn(db, identity)
  const { linkTo } = result
  if (linkTo && user?.id !== linkTo) {
    const holder = user
    user = await refusingConflicts(async () => {
      if (holder) return mergeUsers(db, { into: linkTo, from: holder.id })
      await linkIdentity(db, linkTo, identity)
      return (await findUser(db, linkTo))!
    })
  }
  user ??= await createUserWithIdentity(db, identity)

  const previous = (await sessions.get(event)).user
  const providers: AuthProvider[] =
    previous?.id === user.id
      ? [...new Set([...previous.providers, result.provider])]
      : [result.provider]
  await sessions.replace(event, { user: sessionUser(user, providers) })
  return redirect(result.redirect, 302)
}

/** The session's view of `account`, with the providers proven in this browser session. */
export function sessionUser(account: UserAccount, providers: AuthProvider[]): User {
  return {
    id: account.id,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl ?? undefined,
    handle: account.handle ?? undefined,
    providers,
  }
}

async function refusingConflicts(run: () => Promise<UserAccount>): Promise<UserAccount> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof DbError && error.code === 'INVALID_STATE') {
      throw oauthError('link-conflict', { status: 409, message: error.message, cause: error })
    }
    throw error
  }
}

/** The code a failed sign-in redirects with; the failure's own message never leaves the server. */
export function signInErrorCode(error: HTTPError): SignInErrorCode {
  const reason: SignInErrorCode | undefined = oauthFailureOf(error)
  if (reason) return reason
  if (postgresErrorOf(oauthCauseOf(error))) return 'database'
  if (error.status === 502 || error.status === 504) return 'provider'
  return 'sign-in-failed'
}

/**
 * `onError` of the sign-in routes: logs the failure and lands with its code on the login page,
 * or on the settings page when someone is signed in, since only linking fails for them.
 */
export async function failSignIn(event: H3Event, error: HTTPError, sessions: UserSessions) {
  const code = signInErrorCode(error)
  const log = error.status >= 500 ? console.error : console.warn
  const cause = oauthCauseOf(error)
  log(
    `[auth] sign-in failed (${code}): ${error.status} ${error.message}`,
    ...(cause ? [cause] : []),
  )
  const page = (await sessions.get(event)).user ? '/settings' : '/login'
  return redirect(`${page}?${new URLSearchParams({ error: code })}`, 302)
}
