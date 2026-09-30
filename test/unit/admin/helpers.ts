import type { H3Event } from 'nitro/h3'
import type { DB } from '#server/database/db'
import { createUserWithIdentity, linkIdentity, listIdentities } from '#server/repositories/users'
import type { AdminContext } from '#server/utils/admin/access'
import { parseAdminAllowlist } from '#server/utils/admin/access'
import type { JourneyStore } from '#server/utils/journey/store'

export const ORIGIN = 'https://rover.test'

/** The request header the fake sessions read the signed-in user's id from. */
const USER_HEADER = 'x-test-user'

/** The identity keys of the admin account: its primary on GitHub, a linked Discord listed. */
export const ADMIN_KEYS = { github: 'github:1001', discord: 'discord:80351110224678912' }
export const ALLOWLIST = `${ADMIN_KEYS.discord}, atproto:did:plc:someoneelse`

/**
 * Admin routes over `db` and `store`, the allowlist `allowlist` and sessions that sign in whoever
 * the request's test header names; the real sessions have their own tests. Identities are read
 * from the `db` given here, so a test may replace the context's `db` for its probes alone.
 */
export function adminContext(
  db: () => DB,
  store: () => JourneyStore,
  allowlist = ALLOWLIST,
): AdminContext {
  const parsed = parseAdminAllowlist(allowlist)
  return {
    allowlist: () => parsed,
    sessions: () => ({
      get: async (event: H3Event) => {
        const id = event.req.headers.get(USER_HEADER)
        return id ? { user: { id, displayName: 'Test', providers: ['github'] } } : {}
      },
    }),
    identitiesOf: (userId) => listIdentities(db(), userId),
    db,
    store,
    settings: () => ({ sessionKey: '', typesafeToken: '', origins: '' }),
  }
}

/** Request headers signing in as `userId`, or as nobody. */
export const as = (userId?: string): Record<string, string> =>
  userId ? { [USER_HEADER]: userId } : {}

const profile = (displayName: string) => ({ displayName, avatarUrl: null, handle: null })

/**
 * An admin, listed by the Discord identity linked to an account that signs in with GitHub, and
 * a visitor whose only identity is on GitHub under a subject no entry names.
 */
export async function adminAndVisitor(db: DB) {
  const admin = await createUserWithIdentity(db, {
    provider: 'github',
    subject: '1001',
    profile: profile('Ada'),
  })
  await linkIdentity(db, admin.id, {
    provider: 'discord',
    subject: '80351110224678912',
    profile: profile('Ada'),
  })
  const visitor = await createUserWithIdentity(db, {
    provider: 'github',
    subject: '1002',
    profile: profile('Grace'),
  })
  return { admin, visitor }
}
