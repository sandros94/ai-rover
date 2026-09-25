import { and, eq } from 'drizzle-orm'
import type { Db } from '../database/db'
import { DbError } from '../database/errors'
import type { IdentityProvider, UserAccount, UserIdentity } from '../database/schema'
import { userAccount, userIdentity } from '../database/schema'

export interface Identity {
  provider: IdentityProvider
  subject: string
}

export async function createUser(
  db: Db,
  input: { displayName: string; avatarUrl?: string | null; handle?: string | null },
): Promise<UserAccount> {
  const [row] = await db.insert(userAccount).values(input).returning()
  return row!
}

export async function findUserByIdentity(
  db: Db,
  identity: Identity,
): Promise<UserAccount | undefined> {
  const [row] = await db
    .select({ user: userAccount })
    .from(userIdentity)
    .innerJoin(userAccount, eq(userAccount.id, userIdentity.userId))
    .where(
      and(eq(userIdentity.provider, identity.provider), eq(userIdentity.subject, identity.subject)),
    )
  return row?.user
}

/** Idempotent for the same user; an identity never moves between users. */
export async function linkIdentity(
  db: Db,
  userId: string,
  identity: Identity,
): Promise<UserIdentity> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: userAccount.id })
      .from(userAccount)
      .where(eq(userAccount.id, userId))
    if (!user) {
      throw new DbError('NOT_FOUND', `User ${userId} does not exist; create it before linking.`)
    }
    await tx
      .insert(userIdentity)
      .values({ ...identity, userId })
      .onConflictDoNothing()
    const [linked] = await tx
      .select()
      .from(userIdentity)
      .where(
        and(
          eq(userIdentity.provider, identity.provider),
          eq(userIdentity.subject, identity.subject),
        ),
      )
    if (linked!.userId !== userId) {
      throw new DbError(
        'INVALID_STATE',
        `The ${identity.provider} identity ${identity.subject} belongs to user ${linked!.userId}; sign in as that user instead of linking it to ${userId}.`,
      )
    }
    return linked!
  })
}
