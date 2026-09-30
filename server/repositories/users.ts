import { and, asc, eq, exists, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { DB } from '../database/db'
import { DbError, isUniqueViolation } from '../database/errors'
import type { IdentityProvider, UserAccount, UserIdentity } from '../database/schema'
import {
  missionPause,
  segmentFlag,
  submission,
  submissionLike,
  userAccount,
  userIdentity,
} from '../database/schema'

export interface Identity {
  provider: IdentityProvider
  subject: string
}

/** What a provider says about the user; the account shows its primary identity's. */
export interface IdentityProfile {
  displayName: string
  avatarUrl: string | null
  handle: string | null
}

/** An identity a sign-in just proved, with the profile it read. */
export interface ProvenIdentity extends Identity {
  profile: IdentityProfile
}

/** An account with no identity, named as given. Sign-in creates accounts through {@link createUserWithIdentity}. */
export async function createUser(
  db: DB,
  input: {
    displayName: string
    avatarUrl?: string | null
    handle?: string | null
    /** Development logins only; see `userAccount.devLogin`. */
    devLogin?: string | null
  },
): Promise<UserAccount> {
  const [row] = await db.insert(userAccount).values(input).returning()
  return row!
}

/** A new account holding `identity`, which becomes its primary. */
export async function createUserWithIdentity(
  db: DB,
  identity: ProvenIdentity,
): Promise<UserAccount> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(userAccount)
      .values({ ...identity.profile, primaryProvider: identity.provider })
      .returning()
    await tx.insert(userIdentity).values(identityRow(user!.id, identity))
    return user!
  })
}

export async function findUser(db: DB, id: string): Promise<UserAccount | undefined> {
  const [row] = await db.select().from(userAccount).where(eq(userAccount.id, id))
  return row
}

export async function findUserByIdentity(
  db: DB,
  identity: Identity,
): Promise<UserAccount | undefined> {
  const [row] = await db
    .select({ user: userAccount })
    .from(userIdentity)
    .innerJoin(userAccount, eq(userAccount.id, userIdentity.userId))
    .where(matches(identity))
  return row?.user
}

/** The account's identities, oldest first. */
export async function listIdentities(db: DB, userId: string): Promise<UserIdentity[]> {
  return db
    .select()
    .from(userIdentity)
    .where(eq(userIdentity.userId, userId))
    .orderBy(asc(userIdentity.createdAt), asc(userIdentity.provider))
}

/**
 * Stores the profile `identity` signed in with, and shows it on the account when it is the
 * primary identity. The account holding the identity, or undefined when none does.
 */
export async function recordSignIn(
  db: DB,
  identity: ProvenIdentity,
): Promise<UserAccount | undefined> {
  return db.transaction(async (tx) => {
    const [stored] = await tx
      .update(userIdentity)
      .set(identity.profile)
      .where(matches(identity))
      .returning({ userId: userIdentity.userId })
    if (!stored) return undefined
    const [shown] = await tx
      .update(userAccount)
      .set(identity.profile)
      .where(
        and(eq(userAccount.id, stored.userId), eq(userAccount.primaryProvider, identity.provider)),
      )
      .returning()
    return shown ?? (await findUser(tx, stored.userId))
  })
}

/**
 * Attaches `identity` to the user, idempotently; an account without a primary identity takes it
 * as primary. Refused (`INVALID_STATE`) when the identity
 * belongs to another user (merge instead) or the user already holds another identity of the
 * same provider.
 */
export async function linkIdentity(
  db: DB,
  userId: string,
  identity: ProvenIdentity,
): Promise<UserIdentity> {
  return db.transaction(async (tx) => {
    const user = await lockUser(tx, userId)
    await tx
      .insert(userIdentity)
      .values(identityRow(userId, identity))
      .onConflictDoNothing({ target: [userIdentity.provider, userIdentity.subject] })
      .catch((error: unknown) => {
        if (!isUniqueViolation(error, 'user_identity_user_provider_unique')) throw error
        throw new DbError(
          'INVALID_STATE',
          `User ${userId} already holds a ${identity.provider} identity; unlink it before linking another.`,
          { cause: error },
        )
      })
    const [linked] = await tx.select().from(userIdentity).where(matches(identity))
    if (linked!.userId !== userId) {
      throw new DbError(
        'INVALID_STATE',
        `The ${identity.provider} identity ${identity.subject} belongs to user ${linked!.userId}; merge that account into ${userId} instead of linking it.`,
      )
    }
    if (!user.primaryProvider) await showIdentity(tx, userId, identity.provider)
    return linked!
  })
}

/**
 * Moves everything of `from` onto `into` and deletes `from`, in one transaction: identities,
 * submissions, likes and not-moving flags, and pauses it recorded. A like or flag both gave
 * becomes one (the later flag stands). An open submission of `from` in a round where `into` has
 * one is withdrawn first, as its author would, since a user holds one per round. `into` keeps its
 * primary identity, or takes `from`'s when it had none, and likewise its development login.
 * Refused (`INVALID_STATE`) when both hold
 * an identity of the same provider.
 */
export async function mergeUsers(
  db: DB,
  options: { into: string; from: string },
): Promise<UserAccount> {
  const { into, from } = options
  if (into === from) {
    throw new DbError('INVALID_STATE', `User ${into} cannot be merged into itself.`)
  }
  return db.transaction(async (tx) => {
    // Locked in id order, so two merges of the same pair cannot deadlock.
    const [first, second] = [into, from].toSorted()
    const locked = new Map([
      [first!, await lockUser(tx, first!)],
      [second!, await lockUser(tx, second!)],
    ])
    const target = locked.get(into)!
    const source = locked.get(from)!

    const held = await listIdentities(tx, into)
    const moving = await listIdentities(tx, from)
    const clash = moving.find((m) => held.some((h) => h.provider === m.provider))
    if (clash) {
      throw new DbError(
        'INVALID_STATE',
        `Users ${into} and ${from} both hold a ${clash.provider} identity; unlink one before merging.`,
      )
    }

    const theirs = alias(submission, 'theirs')
    const clashing = await tx
      .update(submission)
      .set({ status: 'withdrawn' })
      .where(
        and(
          eq(submission.userId, from),
          eq(submission.status, 'open'),
          exists(
            tx
              .select({ id: theirs.id })
              .from(theirs)
              .where(
                and(
                  eq(theirs.roundId, submission.roundId),
                  eq(theirs.userId, into),
                  eq(theirs.status, 'open'),
                ),
              ),
          ),
        ),
      )
      .returning({ id: submission.id })
    if (clashing.length) {
      await tx.delete(submissionLike).where(
        and(
          eq(submissionLike.userId, from),
          inArray(
            submissionLike.submissionId,
            clashing.map((s) => s.id),
          ),
        ),
      )
    }

    await tx
      .insert(submissionLike)
      .select(
        tx
          .select({
            submissionId: submissionLike.submissionId,
            userId: sql<string>`${into}::uuid`.as('user_id'),
            createdAt: submissionLike.createdAt,
          })
          .from(submissionLike)
          .where(eq(submissionLike.userId, from)),
      )
      .onConflictDoNothing()
    await tx.delete(submissionLike).where(eq(submissionLike.userId, from))

    await tx
      .insert(segmentFlag)
      .select(
        tx
          .select({
            segmentId: segmentFlag.segmentId,
            userId: sql<string>`${into}::uuid`.as('user_id'),
            createdAt: segmentFlag.createdAt,
          })
          .from(segmentFlag)
          .where(eq(segmentFlag.userId, from)),
      )
      .onConflictDoUpdate({
        target: [segmentFlag.segmentId, segmentFlag.userId],
        set: { createdAt: sql`greatest(${segmentFlag.createdAt}, excluded.created_at)` },
      })
    await tx.delete(segmentFlag).where(eq(segmentFlag.userId, from))

    await tx.update(submission).set({ userId: into }).where(eq(submission.userId, from))
    await tx.update(missionPause).set({ pausedBy: into }).where(eq(missionPause.pausedBy, from))
    await tx.update(userIdentity).set({ userId: into }).where(eq(userIdentity.userId, from))
    await tx.delete(userAccount).where(eq(userAccount.id, from))
    if (source.devLogin && !target.devLogin) {
      await tx
        .update(userAccount)
        .set({ devLogin: source.devLogin })
        .where(eq(userAccount.id, into))
      target.devLogin = source.devLogin
    }

    if (!target.primaryProvider && source.primaryProvider) {
      return showIdentity(tx, into, source.primaryProvider)
    }
    return target
  })
}

/**
 * Makes the user's `provider` identity the one their account shows. Refused (`NOT_FOUND`) when
 * the user holds no identity of that provider.
 */
export async function setPrimaryProvider(
  db: DB,
  userId: string,
  provider: IdentityProvider,
): Promise<UserAccount> {
  return db.transaction(async (tx) => {
    await lockUser(tx, userId)
    return showIdentity(tx, userId, provider)
  })
}

/**
 * Detaches the user's `provider` identity; when it was the primary, the oldest remaining one
 * becomes primary. Refused (`INVALID_STATE`) for the last identity, which is the only way back
 * into the account, and (`NOT_FOUND`) when the user holds none of that provider.
 */
export async function unlinkIdentity(
  db: DB,
  userId: string,
  provider: IdentityProvider,
): Promise<UserAccount> {
  return db.transaction(async (tx) => {
    const user = await lockUser(tx, userId)
    const identities = await listIdentities(tx, userId)
    if (!identities.some((i) => i.provider === provider)) {
      throw new DbError('NOT_FOUND', `User ${userId} holds no ${provider} identity.`)
    }
    const remaining = identities.filter((i) => i.provider !== provider)
    if (!remaining.length) {
      throw new DbError(
        'INVALID_STATE',
        `The ${provider} identity is the last way into user ${userId}; link another before unlinking it.`,
      )
    }
    await tx
      .delete(userIdentity)
      .where(and(eq(userIdentity.userId, userId), eq(userIdentity.provider, provider)))
    if (user.primaryProvider !== provider) return user
    return showIdentity(tx, userId, remaining[0]!.provider)
  })
}

/** Sets the account's primary identity and copies its profile onto the account. */
async function showIdentity(
  tx: DB,
  userId: string,
  provider: IdentityProvider,
): Promise<UserAccount> {
  const [identity] = await tx
    .select()
    .from(userIdentity)
    .where(and(eq(userIdentity.userId, userId), eq(userIdentity.provider, provider)))
  if (!identity) throw new DbError('NOT_FOUND', `User ${userId} holds no ${provider} identity.`)
  const [user] = await tx
    .update(userAccount)
    .set({
      primaryProvider: provider,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      handle: identity.handle,
    })
    .where(eq(userAccount.id, userId))
    .returning()
  return user!
}

async function lockUser(tx: DB, userId: string): Promise<UserAccount> {
  const [user] = await tx.select().from(userAccount).where(eq(userAccount.id, userId)).for('update')
  if (!user) throw new DbError('NOT_FOUND', `User ${userId} does not exist.`)
  return user
}

function matches(identity: Identity) {
  return and(
    eq(userIdentity.provider, identity.provider),
    eq(userIdentity.subject, identity.subject),
  )
}

function identityRow(userId: string, { provider, subject, profile }: ProvenIdentity) {
  return { provider, subject, userId, ...profile }
}
