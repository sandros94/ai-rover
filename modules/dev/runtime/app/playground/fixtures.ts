import type { SlopeProfile } from '#shared/utils/client/instruments'
import { MARS_SOL_SECONDS, slopeProfile } from '#shared/utils/client/instruments'
import type { DestinationSource } from '#shared/utils/client'
import { DEFAULT_LIVE_MARGIN_SECONDS } from '#shared/utils/client'
import type { DriveEvent, SegmentRecord } from '#shared/utils/drive'
import { DEFAULT_SLICE_SECONDS, estimatedDriveMinutes } from '#shared/utils/drive'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { NavMetrics } from '#shared/utils/nav'
import type { DiskWire } from '../../shared/disk-wire'

/** Wall-clock start of the fixture drive: fixed, so screenshots are repeatable. */
export const FIXTURE_STARTED_AT = Date.UTC(2026, 8, 26, 9, 0, 0)
/** Mission epoch 41.3 sols before the drive. */
export const FIXTURE_SOLS_EPOCH = FIXTURE_STARTED_AT - 41.3 * MARS_SOL_SECONDS * 1000
/** The dev world's defaults, which the dev disk route serves. */
const SLOPE_LIMIT_DEG = 16
const CELL_SIZE = 1

export interface PlaygroundContext {
  record: SegmentRecord
  frame: Float32Array
  events: DriveEvent[]
  disk: DiskWire | undefined
  /** Scrub time, sim seconds. */
  t: number
  metrics: NavMetrics
  /** The planned route's slope, over the disk's seen ground; undefined without the disk. */
  profile: SlopeProfile | undefined
  slopeLimitDeg: number
  cellSize: number
  /** Area seen before the drive: the disk's visible vertices. */
  journeyBeforeM2: number
  /** Wall-clock as the live view would stand at `t`: one slice plus the fetch margin ahead. */
  nowMs: number
  segmentStartedAt: number
  solsEpoch: number
  judgment: typeof JUDGMENT
  /** The vote across the scrub: open while the first third plays, idle, then a planning phase. */
  round: {
    round: RoundFixture | null
    driving: boolean
    nowMs: number
    rules: typeof DEFAULT_MISSION_RULES
  }
  tally: typeof TALLY
}

const JUDGMENT = {
  feasible: 0.72,
  verdict: 'review' as const,
  risk: 1.4,
  distanceWeight: 0.62,
  timeWeight: 0.45,
}

const TALLY = {
  distanceM: 1284.6,
  stops: 9,
  arrived: 6,
  stoppedShort: 2,
  failed: 1,
  resets: 0,
  longestM: 238.2,
}

interface RoundFixture {
  closesAt: string | null
  submissions: {
    id: string
    likes: number
    createdAt: string
    judgment: { risk: number; distanceWeight: number; timeWeight: number }
  }[]
}

function roundAt(t: number, duration: number, nowMs: number): PlaygroundContext['round'] {
  const rules = DEFAULT_MISSION_RULES
  const submissions = [
    {
      id: 'north',
      likes: 3,
      createdAt: new Date(FIXTURE_STARTED_AT).toISOString(),
      judgment: { risk: 1.4, distanceWeight: 0.62, timeWeight: 0.45 },
    },
    {
      id: 'east',
      likes: 5,
      createdAt: new Date(FIXTURE_STARTED_AT + 60_000).toISOString(),
      judgment: { risk: 0.8, distanceWeight: 0.7, timeWeight: 0.6 },
    },
  ]
  const third = duration / 3
  if (t < third) return { round: { closesAt: null, submissions }, driving: true, nowMs, rules }
  if (t < 2 * third)
    return { round: { closesAt: null, submissions: [] }, driving: false, nowMs, rules }
  // The grace window scaled onto the last third of the scrub.
  const closesAt = nowMs + ((duration - t) / third) * rules.graceWindowMs
  return {
    round: { closesAt: new Date(closesAt).toISOString(), submissions },
    driving: false,
    nowMs,
    rules,
  }
}

/** What depends on the record and disk only: computed once per fixture, not per frame. */
export function fixtureContext(
  record: SegmentRecord,
  disk: DiskWire | undefined,
): Omit<PlaygroundContext, 'frame' | 'events' | 't' | 'nowMs' | 'round'> {
  let seen = 0
  if (disk) for (const v of disk.visible) seen += v
  return {
    record,
    disk,
    metrics: record.plan.metrics,
    profile: disk
      ? slopeProfile(record.plan.polyline, {
          grid: disk.grid,
          origin: disk.origin,
          revealed: disk.visible,
        })
      : undefined,
    slopeLimitDeg: SLOPE_LIMIT_DEG,
    cellSize: CELL_SIZE,
    journeyBeforeM2: seen * CELL_SIZE * CELL_SIZE,
    segmentStartedAt: FIXTURE_STARTED_AT,
    solsEpoch: FIXTURE_SOLS_EPOCH,
    judgment: JUDGMENT,
    tally: TALLY,
  }
}

/** What moves with the scrub time. */
export function scrubContext(
  record: SegmentRecord,
  t: number,
): Pick<PlaygroundContext, 'nowMs' | 'round'> {
  const nowMs =
    FIXTURE_STARTED_AT + (t + DEFAULT_SLICE_SECONDS + DEFAULT_LIVE_MARGIN_SECONDS) * 1000
  return { nowMs, round: roundAt(t, record.outcome.durationS, nowMs) }
}

/**
 * The fixture drive as the public state names it while it plays: a made-up author, and the
 * record's opening plan with its estimated drive time.
 */
export function fixtureSegment(record: SegmentRecord): NonNullable<DestinationSource['segment']> {
  const { metrics } = record.plan
  return {
    id: 'fixture',
    startedAt: new Date(FIXTURE_STARTED_AT).toISOString(),
    submitter: { displayName: 'Ada', avatarUrl: null },
    plan: metrics.reached
      ? {
          pathLengthM: Math.round(metrics.pathLengthM),
          estimatedMinutes: estimatedDriveMinutes(record.plan),
        }
      : null,
  }
}
