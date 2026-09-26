import { and, count, countDistinct, eq, gt } from 'drizzle-orm'
import type { DB } from '../database/db'
import { DbError } from '../database/errors'
import { segment, segmentFlag, submission, submissionLike } from '../database/schema'

/**
 * Flags the drive as not moving on behalf of `userId`, or moves their earlier flag to `now`.
 * Refused unless the segment is driving and its last slice is not out yet at `now`.
 */
export async function flagSegment(
  db: DB,
  segmentId: string,
  options: { userId: string; now: Date },
): Promise<void> {
  const { userId, now } = options
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: segment.status, endsAt: segment.endsAt })
      .from(segment)
      .where(eq(segment.id, segmentId))
      .for('share')
    if (!row) throw new DbError('NOT_FOUND', `Segment ${segmentId} does not exist.`)
    if (row.status !== 'driving' || row.endsAt.getTime() <= now.getTime()) {
      throw new DbError(
        'INVALID_STATE',
        `Segment ${segmentId} is no longer playing; flag only the drive in progress.`,
      )
    }
    await tx
      .insert(segmentFlag)
      .values({ segmentId, userId, createdAt: now })
      .onConflictDoUpdate({
        target: [segmentFlag.segmentId, segmentFlag.userId],
        set: { createdAt: now },
      })
  })
}

/** Users whose flag on the segment was raised after `since`. */
export async function countFlags(
  db: DB,
  segmentId: string,
  options: { since: Date },
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(segmentFlag)
    .where(and(eq(segmentFlag.segmentId, segmentId), gt(segmentFlag.createdAt, options.since)))
  return row?.n ?? 0
}

/** Whether `userId` flagged the segment after `since`. */
export async function hasFlagged(
  db: DB,
  segmentId: string,
  options: { userId: string; since: Date },
): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(segmentFlag)
    .where(
      and(
        eq(segmentFlag.segmentId, segmentId),
        eq(segmentFlag.userId, options.userId),
        gt(segmentFlag.createdAt, options.since),
      ),
    )
  return (row?.n ?? 0) > 0
}

/**
 * Distinct users who acted in the round beside the drive: submitted to it (whatever became of
 * the submission), liked one of its submissions, or flagged the drive.
 */
export async function countActiveUsers(
  db: DB,
  options: { roundId: string; segmentId: string },
): Promise<number> {
  const { roundId, segmentId } = options
  const submitters = db
    .select({ userId: submission.userId })
    .from(submission)
    .where(eq(submission.roundId, roundId))
  const likers = db
    .select({ userId: submissionLike.userId })
    .from(submissionLike)
    .innerJoin(submission, eq(submission.id, submissionLike.submissionId))
    .where(eq(submission.roundId, roundId))
  const flaggers = db
    .select({ userId: segmentFlag.userId })
    .from(segmentFlag)
    .where(eq(segmentFlag.segmentId, segmentId))
  const active = submitters.union(likers).union(flaggers).as('active')
  const [row] = await db.select({ n: countDistinct(active.userId) }).from(active)
  return Number(row?.n ?? 0)
}
