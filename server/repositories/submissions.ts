import { and, asc, count, eq } from 'drizzle-orm'
import type { NavMetrics } from '#shared/utils/nav/plan'
import type { SubmissionSummary } from '#shared/utils/nav/summary'
import type { DB } from '../database/db'
import { DbError, isUniqueViolation } from '../database/errors'
import type {
  RejectionReason,
  StoredJudgment,
  Submission,
  SubmissionStatus,
} from '../database/schema'
import { round, submission, submissionLike, userAccount } from '../database/schema'

/** What planning and judging a goal produced; revised when the plan's start moves. */
export interface SubmissionAssessment {
  judgment: StoredJudgment
  metrics: NavMetrics
  summary: SubmissionSummary
}

export type NewSubmission = SubmissionAssessment & {
  roundId: string
  userId: string
  /** The goal after snapping to a pathable cell, world metres. */
  goal: { x: number; y: number }
  /** Default: the database's clock. */
  createdAt?: Date
} & (
    | { status?: 'open' }
    /** A refused submission, stored with its reason; it holds no place in the round. */
    | { status: 'rejected'; rejectionReason: RejectionReason }
  )

export interface ListedSubmission extends Submission {
  likes: number
  submitter: { id: string; displayName: string; avatarUrl: string | null }
}

/** Refuses a closed round, and a second open submission by the same user in it. */
export async function createSubmission(db: DB, input: NewSubmission): Promise<Submission> {
  const { goal, ...rest } = input
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ status: round.status })
      .from(round)
      .where(eq(round.id, input.roundId))
      .for('share')
    if (!target) throw new DbError('NOT_FOUND', `Round ${input.roundId} does not exist.`)
    if (target.status !== 'open') {
      throw new DbError(
        'INVALID_STATE',
        `Round ${input.roundId} is closed; submit to the mission's open round.`,
      )
    }
    try {
      const [row] = await tx.transaction((sp) =>
        sp
          .insert(submission)
          .values({ ...rest, goalX: goal.x, goalY: goal.y })
          .returning(),
      )
      return row!
    } catch (error) {
      if (!isUniqueViolation(error, 'submission_open_per_user_idx')) throw error
      throw new DbError(
        'ALREADY_SUBMITTED',
        `User ${input.userId} already has an open submission in round ${input.roundId}; withdraw it before submitting again.`,
        { cause: error },
      )
    }
  })
}

export async function getSubmission(db: DB, submissionId: string): Promise<Submission> {
  const [row] = await db.select().from(submission).where(eq(submission.id, submissionId))
  if (!row) throw new DbError('NOT_FOUND', `Submission ${submissionId} does not exist.`)
  return row
}

/** Every submission of the round in creation order, whatever its status. */
export async function listRoundSubmissions(db: DB, roundId: string): Promise<ListedSubmission[]> {
  const likes = db
    .select({ submissionId: submissionLike.submissionId, likes: count().as('likes') })
    .from(submissionLike)
    .groupBy(submissionLike.submissionId)
    .as('likes')
  const rows = await db
    .select({
      submission,
      likes: likes.likes,
      submitter: {
        id: userAccount.id,
        displayName: userAccount.displayName,
        avatarUrl: userAccount.avatarUrl,
      },
    })
    .from(submission)
    .innerJoin(userAccount, eq(userAccount.id, submission.userId))
    .leftJoin(likes, eq(likes.submissionId, submission.id))
    .where(eq(submission.roundId, roundId))
    .orderBy(asc(submission.createdAt), asc(submission.id))
  return rows.map((row) => ({
    ...row.submission,
    likes: row.likes ?? 0,
    submitter: row.submitter,
  }))
}

/** Settles an open submission; settled ones never change again. Rejecting takes a reason. */
export async function setSubmissionStatus(
  db: DB,
  submissionId: string,
  status: Exclude<SubmissionStatus, 'open' | 'rejected'>,
): Promise<Submission> {
  return updateOpen(db, submissionId, { status }, `become ${status}`)
}

export async function rejectSubmission(
  db: DB,
  submissionId: string,
  options: { reason: RejectionReason },
): Promise<Submission> {
  return updateOpen(
    db,
    submissionId,
    { status: 'rejected', rejectionReason: options.reason },
    'be rejected',
  )
}

/** Replaces an open submission's judgment, metrics and summary, as re-planned and re-judged. */
export async function reviseSubmission(
  db: DB,
  submissionId: string,
  assessment: SubmissionAssessment,
): Promise<Submission> {
  const { judgment, metrics, summary } = assessment
  return updateOpen(db, submissionId, { judgment, metrics, summary }, 'be revised')
}

async function updateOpen(
  db: DB,
  submissionId: string,
  fields: Partial<Submission>,
  action: string,
): Promise<Submission> {
  const [row] = await db
    .update(submission)
    .set(fields)
    .where(and(eq(submission.id, submissionId), eq(submission.status, 'open')))
    .returning()
  if (row) return row
  await assertSubmissionExists(db, submissionId)
  throw new DbError(
    'INVALID_STATE',
    `Submission ${submissionId} is already settled; only an open submission can ${action}.`,
  )
}

/** Only the submitter may withdraw, and only while the submission is open. */
export async function withdrawSubmission(
  db: DB,
  submissionId: string,
  options: { userId: string },
): Promise<Submission> {
  const [row] = await db
    .update(submission)
    .set({ status: 'withdrawn' })
    .where(
      and(
        eq(submission.id, submissionId),
        eq(submission.userId, options.userId),
        eq(submission.status, 'open'),
      ),
    )
    .returning()
  if (row) return row
  await assertSubmissionExists(db, submissionId)
  throw new DbError(
    'INVALID_STATE',
    `Submission ${submissionId} is not an open submission of user ${options.userId}; only its submitter can withdraw it while it is open.`,
  )
}

async function assertSubmissionExists(db: DB, submissionId: string): Promise<void> {
  const [found] = await db
    .select({ id: submission.id })
    .from(submission)
    .where(eq(submission.id, submissionId))
  if (!found) throw new DbError('NOT_FOUND', `Submission ${submissionId} does not exist.`)
}
