import { eq } from 'drizzle-orm'
import type { UserAccount } from '#server/database/schema'
import { userAccount } from '#server/database/schema'
import { createUser } from '#server/repositories/users'
import { useDB } from '#server/utils/db'
import { assertLoopback } from './migrate'

/**
 * The account development login `handle` signs in as, created on first sign-in as `dev:<handle>`.
 * Found by its `devLogin`, which linking identities and switching the primary one leave alone,
 * so the login keeps its account once it has taken a linked identity's name. Refuses, writing
 * nothing, unless `url` (the database `useDB()` reaches) is on this machine.
 */
export async function findOrCreateDevUser(
  url: string | undefined,
  handle: string,
): Promise<Pick<UserAccount, 'id' | 'displayName' | 'handle'>> {
  assertLoopback(url)
  const db = useDB()
  const [found] = await db
    .select({
      id: userAccount.id,
      displayName: userAccount.displayName,
      handle: userAccount.handle,
    })
    .from(userAccount)
    .where(eq(userAccount.devLogin, handle))
    .limit(1)
  if (found) return found
  const {
    id,
    displayName,
    handle: stored,
  } = await createUser(db, {
    displayName: handle,
    handle: `dev:${handle}`,
    devLogin: handle,
  })
  return { id, displayName, handle: stored }
}
