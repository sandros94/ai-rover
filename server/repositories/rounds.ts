import { and, eq, ne } from 'drizzle-orm'
import type { DB } from '../database/db'
import { DbError, isUniqueViolation } from '../database/errors'
import type { Round } from '../database/schema'
import { round, stop, submission } from '../database/schema'

export interface NewRound {
  missionId: string
  fromStopId: string
  /** The stop's position, or the planned destination of the drive the round opens beside. */
  anchor: { x: number; y: number }
  opensAt?: Date
}

/** Refuses while the mission has an open round, and a stop of another mission. */
export async function openRound(db: DB, input: NewRound): Promise<Round> {
  const { anchor, ...rest } = input
  return db.transaction(async (tx) => {
    await assertStopOfMission(tx, input.fromStopId, input.missionId)
    try {
      // A savepoint, so the violation leaves the outer transaction usable.
      const [row] = await tx.transaction((sp) =>
        sp
          .insert(round)
          .values({ ...rest, anchorX: anchor.x, anchorY: anchor.y })
          .returning(),
      )
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

export async function getRound(db: DB, roundId: string): Promise<Round> {
  const [row] = await db.select().from(round).where(eq(round.id, roundId))
  if (!row) throw new DbError('NOT_FOUND', `Round ${roundId} does not exist.`)
  return row
}

export async function getOpenRound(db: DB, missionId: string): Promise<Round | undefined> {
  const [row] = await db
    .select()
    .from(round)
    .where(and(eq(round.missionId, missionId), eq(round.status, 'open')))
  return row
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
    await lockOpenRound(tx, roundId)
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

/**
 * Ends an open round without a winner, at `closesAt`: every open submission of it becomes `lost`,
 * so a void round holds no open submission and never starts a segment.
 */
export async function voidRound(
  db: DB,
  roundId: string,
  options: { closesAt: Date },
): Promise<Round> {
  return db.transaction(async (tx) => {
    await lockOpenRound(tx, roundId)
    await tx
      .update(submission)
      .set({ status: 'lost' })
      .where(and(eq(submission.roundId, roundId), eq(submission.status, 'open')))
    const [row] = await tx
      .update(round)
      .set({ status: 'void', closesAt: options.closesAt })
      .where(eq(round.id, roundId))
      .returning()
    return row!
  })
}

/** Moves an open round to another stop of its mission and anchor. */
export async function reanchorRound(
  db: DB,
  roundId: string,
  options: { fromStopId: string; anchor: { x: number; y: number } },
): Promise<Round> {
  const { fromStopId, anchor } = options
  return db.transaction(async (tx) => {
    const current = await lockOpenRound(tx, roundId)
    await assertStopOfMission(tx, fromStopId, current.missionId)
    const [row] = await tx
      .update(round)
      .set({ fromStopId, anchorX: anchor.x, anchorY: anchor.y })
      .where(eq(round.id, roundId))
      .returning()
    return row!
  })
}

/**
 * The open round, locked for update until the transaction ends: submissions and likes, which
 * share-lock it, wait. Refuses a round that is not open.
 */
export async function lockOpenRound(tx: DB, roundId: string): Promise<Round> {
  const [current] = await tx.select().from(round).where(eq(round.id, roundId)).for('update')
  if (!current) throw new DbError('NOT_FOUND', `Round ${roundId} does not exist.`)
  if (current.status !== 'open') {
    throw new DbError('INVALID_STATE', `Round ${roundId} is already ${current.status}.`)
  }
  return current
}

async function assertStopOfMission(tx: DB, stopId: string, missionId: string): Promise<void> {
  const [from] = await tx
    .select({ missionId: stop.missionId })
    .from(stop)
    .where(eq(stop.id, stopId))
  if (from?.missionId !== missionId) {
    throw new DbError(
      'INVALID_STATE',
      `Stop ${stopId} is not a stop of mission ${missionId}; use one of its stops.`,
    )
  }
}
