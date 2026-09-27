import { fileURLToPath } from 'node:url'
import { getDatabase } from '@netlify/database'
import { applyMigrations, NetlifyDB } from '@netlify/database-dev'
import { drizzle } from 'drizzle-orm/netlify-db'
import type { DB } from '#server/database/db'
import type { MissionConfig } from '#server/database/schema'
import type { SubmissionJudgment } from '#server/utils/jev/client'
import { relations } from '#server/database/schema'
import { DbError } from '#server/database/errors'
import type { NavMetrics, SubmissionSummary } from '#shared/utils/nav'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import { createMission } from '#server/repositories/missions'
import { createStop } from '#server/repositories/stops'
import { openRound } from '#server/repositories/rounds'
import { createUser } from '#server/repositories/users'
import type { NewSubmission } from '#server/repositories/submissions'
import { createSubmission } from '#server/repositories/submissions'
import { closeRound } from '#server/repositories/rounds'
import { createSegment, settleSegment } from '#server/repositories/segments'
import type { Round, Stop } from '#server/database/schema'
import type { DriveOutcome } from '#shared/utils/drive'
import { executorOver } from '~~/modules/dev/runtime/server/utils/executor'

export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../netlify/database/migrations/', import.meta.url),
)

/**
 * A fresh in-memory platform database with every generated migration applied by the platform's
 * applier, reached through the same connector and driver as `useDB()`. `onQuery` sees the SQL of
 * every query the returned database runs.
 */
export async function createTestDb(
  options: { onQuery?: (sql: string) => void } = {},
): Promise<{ db: DB; close: () => Promise<void> }> {
  const server = new NetlifyDB({ logger: () => {} })
  const connection = getDatabase({ connectionString: await server.start() })
  const { onQuery } = options
  const db = drizzle({
    client: connection,
    relations,
    ...(onQuery && { logger: { logQuery: (query: string) => onQuery(query) } }),
  })
  await applyMigrations(executorOver(db), MIGRATIONS_DIR)
  return {
    db,
    async close() {
      await connection.pool.end()
      await server.stop()
    },
  }
}

/** The DbError `promise` rejects with, or undefined when it resolves or rejects otherwise. */
export async function dbErrorOf(promise: Promise<unknown>): Promise<DbError | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DbError) return error
    throw error
  }
  return undefined
}

export const CONFIG: MissionConfig = { world: {}, rules: DEFAULT_MISSION_RULES }

/** A full judgment as a fresh submission stores it. */
export const JUDGMENT: Omit<SubmissionJudgment, 'cached'> = {
  feasible: 0.9,
  distanceConfidence: { score: 3, confidence: 0.8, probabilities: [0, 0.1, 0.2, 0.7] },
  timeConfidence: { score: 2, confidence: 0.6, probabilities: [0.1, 0.2, 0.6, 0.1] },
  risk: { score: 1, confidence: 0.7, probabilities: [0.2, 0.7, 0.1, 0] },
  explorationValue: { score: 2, confidence: 0.6, probabilities: [0.1, 0.1, 0.6, 0.1, 0.1] },
  distanceWeight: 1,
  timeWeight: 2 / 3,
  explorationWeight: 0.5,
  verdict: 'accept',
}

export const METRICS: NavMetrics = {
  reached: true,
  pathLengthM: 81,
  straightLineM: 80,
  detourRatio: 1.0125,
  maxSlopeDeg: 6,
  meanSlopeDeg: 3,
  unrevealedFraction: 0,
  goalInFog: false,
  estimatedDriveS: 2600,
  turnCount: 1,
  expansions: 120,
  computeMs: 0,
}

export const SUMMARY: SubmissionSummary = {
  rover: { class: 'rover', speed: 'slow', limits: 'none' },
  mission_rules: 'rules',
  destination: { straight_line_m: 80, straight_line_label: 'short', bearing: 'north' },
  route: { reached: false },
  failure_reason: 'blocked',
  exploration: {
    path_in_fog: 0,
    destination_unexplored: false,
    pocket: 0,
    pocket_label: 'no pocket',
  },
  recent_stops: [],
}

export const EXPLORATION = { pathInFog: 0, goalInFog: 0, pocket: 0 }

/** A mission with its first stop set current, an open round from it and one user. */
export async function seedMission(db: DB) {
  const mission = await createMission(db, {
    seed: 'mars',
    worldHash: '0123456789abcdef',
    config: CONFIG,
    solsEpoch: new Date('2026-09-01T00:00:00Z'),
  })
  const stop = await createStop(db, {
    missionId: mission.id,
    index: 0,
    x: 0,
    y: 0,
    headingRad: 0,
    manifestKey: 'terrain/0123456789abcdef/stops/0.json',
    revealedKey: 'terrain/0123456789abcdef/revealed/0.bin',
  })
  const round = await openRound(db, {
    missionId: mission.id,
    fromStopId: stop.id,
    anchor: { x: 0, y: 0 },
  })
  const user = await createUser(db, { displayName: 'Ada' })
  return { mission, stop, round, user }
}

/** A submission to `round`, planned from where the round stands now. */
export function submissionInput(
  round: Pick<Round, 'id' | 'fromStopId' | 'anchorX' | 'anchorY'>,
  userId: string,
  goal = { x: 0, y: 80 },
): NewSubmission {
  return {
    roundId: round.id,
    userId,
    goal,
    plannedFrom: { fromStopId: round.fromStopId, anchor: { x: round.anchorX, y: round.anchorY } },
    judgment: JUDGMENT,
    metrics: METRICS,
    summary: SUMMARY,
    exploration: 0.25,
    explorationParts: EXPLORATION,
  }
}

/** Start of the first drive of {@link seedJourney}; each drive starts two hours after the last. */
export const JOURNEY_T0 = new Date('2026-09-25T12:00:00Z')
const HOUR = 3_600_000
const plus = (ms: number) => new Date(JOURNEY_T0.getTime() + ms)

function journeyOutcome(kind: DriveOutcome['kind'], distanceM: number, at = { x: 0, y: 80 }) {
  return {
    kind,
    reasons: kind === 'arrived' ? [] : ['stuck'],
    distanceM,
    durationS: distanceM * 30,
    endPose: { ...at, headingRad: 0 },
  } satisfies DriveOutcome
}

/**
 * Three drives: an arrival from the landing stop to stop 1, a failure from stop 1, and a drive
 * from stop 1 still playing, whose outcome is written but private.
 */
export async function seedJourney(db: DB) {
  const seeded = await seedMission(db)
  const { mission, user } = seeded
  async function drive(from: Stop, k: number, result: DriveOutcome, round?: Round) {
    const r =
      round ?? (await openRound(db, { missionId: mission.id, fromStopId: from.id, anchor: from }))
    const submission = await createSubmission(
      db,
      submissionInput(r, user.id, { x: result.endPose.x, y: result.endPose.y }),
    )
    await closeRound(db, r.id, { winnerSubmissionId: submission.id, closesAt: plus(k * 2 * HOUR) })
    return createSegment(db, {
      missionId: mission.id,
      roundId: r.id,
      submissionId: submission.id,
      fromStopId: from.id,
      startedAt: plus(k * 2 * HOUR),
      endsAt: plus(k * 2 * HOUR + HOUR),
      manifestKey: `segments/${k}/manifest.json`,
      outcome: result,
    })
  }
  const arrival = await drive(seeded.stop, 0, journeyOutcome('arrived', 80), seeded.round)
  const reached = await createStop(db, {
    missionId: mission.id,
    index: 1,
    x: 0,
    y: 80,
    headingRad: 0,
    manifestKey: 'missions/m/stops/1.json',
    revealedKey: 'missions/m/revealed/1.bin',
    fromSegmentId: arrival.id,
  })
  await settleSegment(db, arrival.id, { now: plus(HOUR), status: 'arrived', toStopId: reached.id })
  const failure = await drive(reached, 1, journeyOutcome('failed', 42, { x: 30, y: 100 }))
  await settleSegment(db, failure.id, {
    now: plus(3 * HOUR),
    status: 'failed',
    death: { x: 30, y: 100 },
  })
  const driving = await drive(reached, 2, journeyOutcome('failed', 7, { x: 5, y: 85 }))
  return { ...seeded, reached, arrival, failure, driving }
}
