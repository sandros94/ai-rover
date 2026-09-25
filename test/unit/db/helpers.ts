import { fileURLToPath } from 'node:url'
import { getDatabase } from '@netlify/database'
import { applyMigrations, NetlifyDB } from '@netlify/database-dev'
import { drizzle } from 'drizzle-orm/netlify-db'
import type { DB } from '#server/database/db'
import type { MissionConfig, StoredJudgment } from '#server/database/schema'
import { relations } from '#server/database/schema'
import { DbError } from '#server/database/errors'
import type { NavMetrics, SubmissionSummary } from '#shared/utils/nav'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import { createMission } from '#server/repositories/missions'
import { createStop } from '#server/repositories/stops'
import { openRound } from '#server/repositories/rounds'
import { createUser } from '#server/repositories/users'
import type { NewSubmission } from '#server/repositories/submissions'
import { executorOver } from '~~/modules/dev-db/runtime/server/utils/executor'

export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../netlify/database/migrations/', import.meta.url),
)

/**
 * A fresh in-memory platform database with every generated migration applied by the platform's
 * applier, reached through the same connector and driver as `useDB()`.
 */
export async function createTestDb(): Promise<{ db: DB; close: () => Promise<void> }> {
  const server = new NetlifyDB({ logger: () => {} })
  const connection = getDatabase({ connectionString: await server.start() })
  const db = drizzle({ client: connection, relations })
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

export const JUDGMENT: StoredJudgment = {
  feasible: 0.9,
  distanceConfidence: { score: 3, confidence: 0.8, probabilities: [0, 0.1, 0.2, 0.7] },
  timeConfidence: { score: 2, confidence: 0.6, probabilities: [0.1, 0.2, 0.6, 0.1] },
  risk: { score: 1, confidence: 0.7, probabilities: [0.2, 0.7, 0.1, 0] },
  distanceWeight: 1,
  timeWeight: 2 / 3,
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
}

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
  const round = await openRound(db, { missionId: mission.id, fromStopId: stop.id })
  const user = await createUser(db, { displayName: 'Ada' })
  return { mission, stop, round, user }
}

export function submissionInput(
  roundId: string,
  userId: string,
  goal = { x: 0, y: 80 },
): NewSubmission {
  return { roundId, userId, goal, judgment: JUDGMENT, metrics: METRICS, summary: SUMMARY }
}
