import { and, asc, count, eq } from 'drizzle-orm'
import type { ExplorationParts } from '#shared/utils/mission/exploration'
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
  /** 0 to 1: the mean of the code's exploration value and Jev's. */
  exploration: number
  explorationParts: ExplorationParts
}

export type NewSubmission = SubmissionAssessment & {
  roundId: string
  userId: string
  /** Where the round stood when the goal was planned; the round must still stand there. */
  plannedFrom: { fromStopId: string; anchor: { x: number; y: number } }
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

/**
 * Refuses a closed round, a round that has left the stop or anchor the goal was planned from
 * (`ROUND_CHANGED`: plan again), and a second open submission by the same user in it. The round
 * row stays share-locked until the insert commits, so a settlement moving it waits for the insert
 * or is waited on. An open submission starts with its author's like, in the same transaction.
 */
export async function createSubmission(db: DB, input: NewSubmission): Promise<Submission> {
  const { goal, plannedFrom, ...rest } = input
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        status: round.status,
        fromStopId: round.fromStopId,
        anchorX: round.anchorX,
        anchorY: round.anchorY,
      })
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
    if (
      target.fromStopId !== plannedFrom.fromStopId ||
      target.anchorX !== plannedFrom.anchor.x ||
      target.anchorY !== plannedFrom.anchor.y
    ) {
      throw new DbError(
        'ROUND_CHANGED',
        `Round ${input.roundId} now leaves from stop ${target.fromStopId} anchored at (${target.anchorX}, ${target.anchorY}); plan the goal again from there.`,
      )
    }
    try {
      const [row] = await tx.transaction((sp) =>
        sp
          .insert(submission)
          .values({ ...rest, goalX: goal.x, goalY: goal.y })
          .returning(),
      )
      // Submitting is an LGTM on your own entry; a rejected one holds no place to approve.
      if (row!.status === 'open') {
        await tx.insert(submissionLike).values({ submissionId: row!.id, userId: row!.userId })
      }
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

/** The submission with its author, as a round lists it. */
export async function getAuthoredSubmission(
  db: DB,
  submissionId: string,
): Promise<Submission & Pick<ListedSubmission, 'submitter'>> {
  const [row] = await db
    .select({
      submission,
      submitter: {
        id: userAccount.id,
        displayName: userAccount.displayName,
        avatarUrl: userAccount.avatarUrl,
      },
    })
    .from(submission)
    .innerJoin(userAccount, eq(userAccount.id, submission.userId))
    .where(eq(submission.id, submissionId))
  if (!row) throw new DbError('NOT_FOUND', `Submission ${submissionId} does not exist.`)
  return { ...row.submission, submitter: row.submitter }
}

/** Submissions `userId` made in the round, whatever their status. */
export async function countUserRoundSubmissions(
  db: DB,
  options: { roundId: string; userId: string },
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(submission)
    .where(and(eq(submission.roundId, options.roundId), eq(submission.userId, options.userId)))
  return row?.n ?? 0
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

/**
 * The round's open submissions in creation order, locked for update until the transaction ends,
 * so none is withdrawn or liked while the caller settles them.
 */
export async function lockOpenSubmissions(tx: DB, roundId: string): Promise<Submission[]> {
  return tx
    .select()
    .from(submission)
    .where(and(eq(submission.roundId, roundId), eq(submission.status, 'open')))
    .orderBy(asc(submission.createdAt), asc(submission.id))
    .for('update')
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

/**
 * Replaces an open submission's judgment, metrics, summary and exploration, as re-planned and
 * re-judged.
 */
export async function reviseSubmission(
  db: DB,
  submissionId: string,
  assessment: SubmissionAssessment,
): Promise<Submission> {
  const { judgment, metrics, summary, exploration, explorationParts } = assessment
  return updateOpen(
    db,
    submissionId,
    { judgment, metrics, summary, exploration, explorationParts },
    'be revised',
  )
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

/**
 * Only the submitter may withdraw, and only while the submission is open. Their own like goes
 * with it; the likes others gave stay on record.
 */
export async function withdrawSubmission(
  db: DB,
  submissionId: string,
  options: { userId: string },
): Promise<Submission> {
  const row = await db.transaction(async (tx) => {
    const [withdrawn] = await tx
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
    if (withdrawn) {
      await tx
        .delete(submissionLike)
        .where(
          and(
            eq(submissionLike.submissionId, submissionId),
            eq(submissionLike.userId, options.userId),
          ),
        )
    }
    return withdrawn
  })
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
