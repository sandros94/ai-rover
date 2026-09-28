import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { ProfileSubmission, SettledDriveStatus } from '#shared/utils/profile'
import type { DB } from '../database/db'
import { DbError } from '../database/errors'
import type { IdentityProvider } from '../database/schema'
import {
  round,
  segment,
  submission,
  submissionLike,
  userAccount,
  userIdentity,
} from '../database/schema'

/** A user as anyone may see them, with every submission their vote cards showed. */
export interface PublicProfile {
  user: {
    id: string
    displayName: string
    avatarUrl: string | null
    providers: IdentityProvider[]
    memberSince: Date
  }
  /** Newest first. */
  submissions: ProfileSubmission[]
}

/**
 * Submissions that stood in a round (open, won or lost), never those withdrawn or rejected,
 * which no vote card kept showing. A drive's ending shows only once it settled.
 */
const LISTED = ['open', 'won', 'lost'] as const

export async function getPublicProfile(db: DB, userId: string): Promise<PublicProfile> {
  const [user] = await db
    .select({
      id: userAccount.id,
      displayName: userAccount.displayName,
      avatarUrl: userAccount.avatarUrl,
      memberSince: userAccount.createdAt,
    })
    .from(userAccount)
    .where(eq(userAccount.id, userId))
  if (!user) throw new DbError('NOT_FOUND', `User ${userId} does not exist.`)
  const identities = await db
    .select({ provider: userIdentity.provider })
    .from(userIdentity)
    .where(eq(userIdentity.userId, userId))
    .orderBy(asc(userIdentity.createdAt), asc(userIdentity.provider))

  const numbered = db
    .select({
      id: round.id,
      number:
        sql<number>`row_number() over (partition by ${round.missionId} order by ${round.opensAt}, ${round.id})`.as(
          'number',
        ),
    })
    .from(round)
    .as('numbered')
  const likes = db
    .select({
      submissionId: submissionLike.submissionId,
      likes: count().as('likes'),
      ownLike: sql<boolean>`bool_or(${submissionLike.userId} = ${userId})`.as('own_like'),
    })
    .from(submissionLike)
    .groupBy(submissionLike.submissionId)
    .as('likes')
  const rows = await db
    .select({
      id: submission.id,
      round: numbered.number,
      createdAt: submission.createdAt,
      straightLineM: sql<number>`(${submission.metrics} ->> 'straightLineM')::float8`,
      likes: likes.likes,
      ownLike: likes.ownLike,
      status: submission.status,
      driveStatus: segment.status,
      distanceM: sql<number | null>`(${segment.outcome} ->> 'distanceM')::float8`,
    })
    .from(submission)
    .innerJoin(numbered, eq(numbered.id, submission.roundId))
    .leftJoin(likes, eq(likes.submissionId, submission.id))
    .leftJoin(segment, eq(segment.submissionId, submission.id))
    .where(and(eq(submission.userId, userId), inArray(submission.status, LISTED)))
    .orderBy(desc(submission.createdAt), desc(submission.id))

  return {
    user: { ...user, providers: identities.map((i) => i.provider) },
    submissions: rows.map((row) => ({
      id: row.id,
      round: Number(row.round),
      createdAt: row.createdAt,
      goalDistanceM: Number(row.straightLineM),
      likes: row.likes ?? 0,
      ownLike: row.ownLike ?? false,
      status: row.status as ProfileSubmission['status'],
      drive: !row.driveStatus
        ? null
        : row.driveStatus === 'driving'
          ? { status: 'driving' }
          : {
              status: row.driveStatus as SettledDriveStatus,
              distanceM: Number(row.distanceM ?? 0),
            },
    })),
  }
}
