import { and, count, eq } from 'drizzle-orm'
import type { Db } from '../database/db'
import { DbError } from '../database/errors'
import { submission, submissionLike } from '../database/schema'

/** Idempotent. Likes change only while the submission is open, which implies an open round. */
export async function like(
  db: Db,
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
  db: Db,
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

export async function countLikes(db: Db, submissionId: string): Promise<number> {
  const [row] = await db
    .select({ likes: count() })
    .from(submissionLike)
    .where(eq(submissionLike.submissionId, submissionId))
  return row?.likes ?? 0
}

/** Holds the submission's status steady until the transaction ends. */
async function lockOpenSubmission(tx: Db, submissionId: string): Promise<void> {
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
