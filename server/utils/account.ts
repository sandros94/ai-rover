import type { H3Event } from 'nitro/h3'
import { defineHandler } from 'nitro/h3'
import * as v from 'valibot'
import type { UserSessions } from '../../modules/auth/runtime/server/lib/session'
import { useAuthContext } from '../../modules/auth/runtime/server/utils/auth'
import type { DB } from '../database/db'
import type { AccountView } from '#shared/utils/account'
import type { UserAccount } from '../database/schema'
import { IDENTITY_PROVIDERS } from '../database/schema'
import { listIdentities } from '../repositories/users'
import { useDB } from './db'
import { answerRouteError, requireSessionUser } from './mission/http'
import { sessionUser } from './sign-in'

export const ProviderSchema = v.picklist(IDENTITY_PROVIDERS)

export async function accountView(db: DB, account: UserAccount): Promise<AccountView> {
  const identities = await listIdentities(db, account.id)
  return {
    id: account.id,
    primaryProvider: account.primaryProvider,
    identities: identities.map(({ provider, displayName, avatarUrl, handle, createdAt }) => ({
      provider,
      displayName,
      avatarUrl,
      handle,
      linkedAt: createdAt,
    })),
  }
}

export interface AccountRouteContext {
  db: () => DB
  sessions: () => Pick<UserSessions, 'require' | 'set' | 'clear'>
}

const PLATFORM: AccountRouteContext = { db: useDB, sessions: () => useAuthContext().sessions }

export type AccountRouteHandler = (
  event: H3Event,
  context: { db: DB; user: UserAccount },
) => Promise<UserAccount>

/**
 * A route acting on the signed-in user's own account: `handler` returns the account as it left
 * it, which the session then shows and the route answers as an {@link AccountView}. Never
 * cached; an account gone since sign-in answers `USER_GONE` and clears the session.
 */
export function defineAccountHandler(handler: AccountRouteHandler) {
  return defineAccountHandlerWith(PLATFORM, handler)
}

export function defineAccountHandlerWith(
  platform: AccountRouteContext,
  handler: AccountRouteHandler,
) {
  return defineHandler(async (event) => {
    event.res.headers.set('cache-control', 'no-store')
    const sessions = platform.sessions()
    try {
      const db = platform.db()
      const { user } = await sessions.require(event)
      const account = await handler(event, {
        db,
        user: await requireSessionUser(db, event, sessions),
      })
      const view = await accountView(db, account)
      // Providers proven here stay, but not one whose identity has left the account.
      const linked = new Set(view.identities.map((identity) => identity.provider))
      const providers = user.providers.filter((provider) => linked.has(provider))
      await sessions.set(event, { user: sessionUser(account, providers) })
      return view
    } catch (error) {
      throw await answerRouteError(event, error, sessions)
    }
  })
}
