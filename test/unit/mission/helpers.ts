import { count } from 'drizzle-orm'
import type { DB } from '#server/database/db'
import type { StoredJudgment } from '#server/database/schema'
import { schema } from '#server/database/schema'
import { createUser } from '#server/repositories/users'
import type { JevClient, SubmissionJudgment } from '#server/utils/jev/client'
import type { JourneyStore } from '#server/utils/journey/store'
import { createJourneyStore } from '#server/utils/journey/store'
import type { SubmissionSummary } from '#shared/utils/nav'
import { MemoryBlobs } from '../journey/helpers'
import { JUDGMENT, METRICS as METRICS_FIXTURE } from '../db/helpers'
import type { SegmentRecord } from '#shared/utils/drive'
import { KEYFRAME_STRIDE } from '#shared/utils/drive'

export { createTestDb, dbErrorOf } from '../db/helpers'

/** Wall-clock zero of every lifecycle test; far from the database's own clock on purpose. */
export const T0 = new Date('2030-01-01T00:00:00Z')

export function at(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms)
}

export const MINUTE = 60_000

export function memoryStore(): { store: JourneyStore; blobs: MemoryBlobs } {
  const blobs = new MemoryBlobs()
  return { store: createJourneyStore({ store: blobs }), blobs }
}

/**
 * A Jev client answering from `judge` (default: the accepting fixture judgment), recording every
 * summary it was asked about. `judge` may be async, to act while a judgment is in flight.
 */
export function fakeJev(
  judge: (
    summary: SubmissionSummary,
  ) => Partial<StoredJudgment> | Promise<Partial<StoredJudgment>> = () => ({}),
) {
  const summaries: SubmissionSummary[] = []
  const client: JevClient = {
    async judgeSubmission(summary) {
      summaries.push(summary)
      const judgment: SubmissionJudgment = {
        ...structuredClone(JUDGMENT),
        ...(await judge(summary)),
        cached: false,
      }
      return judgment
    },
  }
  return { client, summaries }
}

export async function users(db: DB, ...names: string[]) {
  return Promise.all(names.map((displayName) => createUser(db, { displayName })))
}

/** Row count of every table, to compare before and after an operation. */
export async function tableCounts(db: DB): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const [name, table] of Object.entries(schema)) {
    const [row] = await db.select({ n: count() }).from(table)
    counts[name] = row!.n
  }
  return counts
}

/**
 * A drive record at 2 Hz along +x from `start`: the rover moves at `speedMps` until
 * `stopAfterS`, then stands still until `durationS`; heading 0, identity attitude. The outcome
 * says arrived where the frames end.
 */
export function syntheticRecord(
  options: {
    start?: { x: number; y: number }
    speedMps?: number
    stopAfterS?: number
    durationS?: number
  } = {},
): SegmentRecord {
  const { start = { x: 0, y: 0 }, speedMps = 0.1, stopAfterS = 1200, durationS = 3600 } = options
  const hz = 2
  const count = durationS * hz + 1
  const data = new Float32Array(count * KEYFRAME_STRIDE)
  for (let k = 0; k < count; k++) {
    const t = k / hz
    const f = k * KEYFRAME_STRIDE
    data[f] = t
    data[f + 1] = start.x + speedMps * Math.min(t, stopAfterS)
    data[f + 2] = start.y
    data[f + 7] = 1
    data[f + 8] = t < stopAfterS ? speedMps : 0
  }
  const endX = start.x + speedMps * Math.min(durationS, stopAfterS)
  return {
    version: 1,
    start: { ...start, headingRad: 0 },
    goal: { x: endX, y: start.y },
    plan: {
      route: { reached: true, waypoints: [], expansions: 0 },
      polyline: [start, { x: endX, y: start.y }],
      motions: [],
      metrics: { ...METRICS_FIXTURE },
    },
    keyframes: { hz, stride: KEYFRAME_STRIDE, count, data },
    events: [{ t: 0, type: 'start', x: start.x, y: start.y }],
    reveals: [{ t: 0, vertices: new Uint32Array([1, 2, 3]) }],
    outcome: {
      kind: 'arrived',
      reasons: [],
      distanceM: endX - start.x,
      durationS,
      endPose: { x: endX, y: start.y, headingRad: 0 },
    },
  }
}
