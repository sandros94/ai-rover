import { and, count, eq, ne, sql } from 'drizzle-orm'
import type { DB } from '../database/db'
import { round, segment, submission, submissionLike, userAccount } from '../database/schema'

/** One member's record in a mission, all of it public. */
export interface CommunityTally {
  user: { id: string; displayName: string; avatarUrl: string | null }
  /** Settled drives that were theirs. */
  won: number
  /** LGTMs other users gave their submissions, whatever became of them. */
  lgtmsReceived: number
  /** Ground distance of their settled drives, failures included, metres. */
  distanceM: number
  /** Their settled drives that failed. */
  failures: number
}

/**
 * Every user who submitted to the mission, with their tally from its settled drives and the
 * likes on their submissions; most distance first, then most won, most LGTMs, name and id.
 */
export async function listCommunityTallies(db: DB, missionId: string): Promise<CommunityTally[]> {
  const ofMission = eq(round.missionId, missionId)
  const members = await db
    .selectDistinct({
      id: userAccount.id,
      displayName: userAccount.displayName,
      avatarUrl: userAccount.avatarUrl,
    })
    .from(submission)
    .innerJoin(round, eq(round.id, submission.roundId))
    .innerJoin(userAccount, eq(userAccount.id, submission.userId))
    .where(ofMission)
  const drives = await db
    .select({
      userId: submission.userId,
      won: count(),
      distanceM: sql<number>`coalesce(sum((${segment.outcome} ->> 'distanceM')::float8), 0)`,
      failures: sql<number>`count(*) filter (where ${segment.status} = 'failed')`,
    })
    .from(segment)
    .innerJoin(submission, eq(submission.id, segment.submissionId))
    .where(and(eq(segment.missionId, missionId), ne(segment.status, 'driving')))
    .groupBy(submission.userId)
  const received = await db
    .select({ userId: submission.userId, n: count() })
    .from(submissionLike)
    .innerJoin(submission, eq(submission.id, submissionLike.submissionId))
    .innerJoin(round, eq(round.id, submission.roundId))
    .where(and(ofMission, ne(submissionLike.userId, submission.userId)))
    .groupBy(submission.userId)

  const driven = new Map(drives.map((d) => [d.userId, d]))
  const liked = new Map(received.map((r) => [r.userId, r.n]))
  return members
    .map((user): CommunityTally => {
      const d = driven.get(user.id)
      return {
        user,
        won: d?.won ?? 0,
        lgtmsReceived: liked.get(user.id) ?? 0,
        distanceM: Number(d?.distanceM ?? 0),
        failures: Number(d?.failures ?? 0),
      }
    })
    .toSorted(
      (a, b) =>
        b.distanceM - a.distanceM ||
        b.won - a.won ||
        b.lgtmsReceived - a.lgtmsReceived ||
        a.user.displayName.localeCompare(b.user.displayName) ||
        (a.user.id < b.user.id ? -1 : a.user.id > b.user.id ? 1 : 0),
    )
}
