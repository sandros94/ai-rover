import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import type { DB } from '../database/db'
import { DbError, isUniqueViolation } from '../database/errors'
import type { Round } from '../database/schema'
import { round, segment, stop, submission } from '../database/schema'

/** Refuses while the mission has an open round, and a stop of another mission. */
export async function openRound(
  db: DB,
  input: { missionId: string; fromStopId: string; opensAt?: Date },
): Promise<Round> {
  return db.transaction(async (tx) => {
    const [from] = await tx
      .select({ missionId: stop.missionId })
      .from(stop)
      .where(eq(stop.id, input.fromStopId))
    if (from?.missionId !== input.missionId) {
      throw new DbError(
        'INVALID_STATE',
        `Stop ${input.fromStopId} is not a stop of mission ${input.missionId}; open the round from one of its stops.`,
      )
    }
    try {
      // A savepoint, so the violation leaves the outer transaction usable.
      const [row] = await tx.transaction((sp) => sp.insert(round).values(input).returning())
      return row!
    } catch (error) {
      if (!isUniqueViolation(error, 'round_open_per_mission_idx')) throw error
      throw new DbError(
        'INVALID_STATE',
        `Mission ${input.missionId} already has an open round; close it before opening another.`,
        { cause: error },
      )
    }
  })
}

export async function getOpenRound(db: DB, missionId: string): Promise<Round | undefined> {
  const [row] = await db
    .select()
    .from(round)
    .where(and(eq(round.missionId, missionId), eq(round.status, 'open')))
  return row
}

/** The oldest closed round of the mission whose winner has no segment yet. */
export async function findUnresolvedRound(db: DB, missionId: string): Promise<Round | undefined> {
  const [row] = await db
    .select({ round })
    .from(round)
    .leftJoin(segment, eq(segment.roundId, round.id))
    .where(and(eq(round.missionId, missionId), eq(round.status, 'closed'), isNull(segment.id)))
    .orderBy(asc(round.closesAt), asc(round.id))
    .limit(1)
  return row?.round
}

/**
 * Closes an open round on its winner, which must be an open submission of it; every other open
 * submission of the round becomes `lost`, so a closed round holds no open submission.
 */
export async function closeRound(
  db: DB,
  roundId: string,
  options: { winnerSubmissionId: string; closesAt: Date },
): Promise<Round> {
  const { winnerSubmissionId, closesAt } = options
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(round).where(eq(round.id, roundId)).for('update')
    if (!current) throw new DbError('NOT_FOUND', `Round ${roundId} does not exist.`)
    if (current.status !== 'open') {
      throw new DbError('INVALID_STATE', `Round ${roundId} is already closed.`)
    }
    const [winner] = await tx
      .update(submission)
      .set({ status: 'won' })
      .where(
        and(
          eq(submission.id, winnerSubmissionId),
          eq(submission.roundId, roundId),
          eq(submission.status, 'open'),
        ),
      )
      .returning({ id: submission.id })
    if (!winner) {
      throw new DbError(
        'INVALID_STATE',
        `Submission ${winnerSubmissionId} is not an open submission of round ${roundId}; pick the winner among its open submissions.`,
      )
    }
    await tx
      .update(submission)
      .set({ status: 'lost' })
      .where(
        and(
          eq(submission.roundId, roundId),
          eq(submission.status, 'open'),
          ne(submission.id, winnerSubmissionId),
        ),
      )
    const [row] = await tx
      .update(round)
      .set({ status: 'closed', winnerSubmissionId, closesAt })
      .where(eq(round.id, roundId))
      .returning()
    return row!
  })
}
