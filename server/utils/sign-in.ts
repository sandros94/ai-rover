import type { H3Event } from 'nitro/h3'
import { HTTPError, redirect } from 'nitro/h3'
import type { AuthProvider } from '#auth'
import type { OAuthResult } from '../../modules/auth/runtime/server/lib/oauth'
import type { UserSessions } from '../../modules/auth/runtime/server/lib/session'
import type { DB } from '../database/db'
import { DbError } from '../database/errors'
import { createUser, findUserByIdentity, linkIdentity } from '../repositories/users'

/**
 * Turns a proven identity into the signed-in user: the account already holding the identity,
 * else the signed-in account when the flow asked to link, else a new account from the provider
 * profile. Then sets the session and lands on the requested path.
 */
export async function completeSignIn(
  event: H3Event,
  { db, sessions }: { db: DB; sessions: UserSessions },
  result: OAuthResult,
) {
  const identity = { provider: result.provider, subject: result.subject }
  let user = await findUserByIdentity(db, identity)
  if (user && result.linkTo && user.id !== result.linkTo) {
    throw new HTTPError({
      status: 409,
      message: `This ${result.provider} account already belongs to another user; sign in with it instead.`,
    })
  }
  if (!user) {
    const userId = result.linkTo ?? (await createUser(db, profileRow(result))).id
    try {
      await linkIdentity(db, userId, identity)
    } catch (error) {
      if (error instanceof DbError) throw new HTTPError({ status: 409, message: error.message })
      throw error
    }
    user = (await findUserByIdentity(db, identity))!
  }

  const previous = (await sessions.get(event)).user
  const providers: AuthProvider[] =
    previous?.id === user.id
      ? [...new Set([...previous.providers, result.provider])]
      : [result.provider]
  await sessions.replace(event, {
    user: {
      id: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? undefined,
      handle: user.handle ?? undefined,
      providers,
    },
  })
  return redirect(result.redirect, 302)
}

function profileRow({ profile }: OAuthResult) {
  return {
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl ?? null,
    handle: profile.handle ?? null,
  }
}
