import { and, count, eq } from 'drizzle-orm'
import type { DB } from '../database/db'
import { DbError } from '../database/errors'
import { submission, submissionLike } from '../database/schema'

/** Idempotent. Likes change only while the submission is open, which implies an open round. */
export async function like(
  db: DB,
  submissionId: string,
  options: { userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockOpenSubmission(tx, submissionId)
    await tx
      .insert(submissionLike)
      .values({ submissionId, userId: options.userId })
      .onConflictDoNothing()
  })
}

/** Idempotent; same window as {@link like}. */
export async function unlike(
  db: DB,
  submissionId: string,
  options: { userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockOpenSubmission(tx, submissionId)
    await tx
      .delete(submissionLike)
      .where(
        and(
          eq(submissionLike.submissionId, submissionId),
          eq(submissionLike.userId, options.userId),
        ),
      )
  })
}

export async function countLikes(db: DB, submissionId: string): Promise<number> {
  const [row] = await db
    .select({ likes: count() })
    .from(submissionLike)
    .where(eq(submissionLike.submissionId, submissionId))
  return row?.likes ?? 0
}

/** Holds the submission's status steady until the transaction ends. */
async function lockOpenSubmission(tx: DB, submissionId: string): Promise<void> {
  const [row] = await tx
    .select({ status: submission.status })
    .from(submission)
    .where(eq(submission.id, submissionId))
    .for('share')
  if (!row) throw new DbError('NOT_FOUND', `Submission ${submissionId} does not exist.`)
  if (row.status !== 'open') {
    throw new DbError(
      'INVALID_STATE',
      `Submission ${submissionId} is ${row.status}; likes change only while it is open.`,
    )
  }
}

/** Ids of the round's submissions the user likes, whatever their status. */
export async function listLikedSubmissionIds(
  db: DB,
  options: { roundId: string; userId: string },
): Promise<string[]> {
  const rows = await db
    .select({ id: submissionLike.submissionId })
    .from(submissionLike)
    .innerJoin(submission, eq(submission.id, submissionLike.submissionId))
    .where(and(eq(submission.roundId, options.roundId), eq(submissionLike.userId, options.userId)))
  return rows.map((row) => row.id)
}
