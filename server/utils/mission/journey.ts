import type { DB } from '../../database/db'
import { getMission } from '../../repositories/missions'
import type { JourneyRange, JourneySegment } from '../../repositories/segments'
import {
  getJourneySegment,
  listJourneySegments,
  listSettledSegments,
} from '../../repositories/segments'
import { listStops } from '../../repositories/stops'
import type { MissionRules } from '#shared/utils/mission'
import { MissionError } from '#shared/utils/mission'
import type { PublicDeath, PublicStop, PublicSubmission } from './state'
import { publicJudgment, publicStopsAndDeaths } from './state'

/** Settled drives per page of the journey log. */
export const JOURNEY_PAGE_SIZE = 50

/** A settled drive as anyone may see it: the stored judgment reduced to its public form. */
export type PublicDrive = Omit<JourneySegment, 'judgment'> & {
  judgment: PublicSubmission['judgment']
}

const publicDrive = (segment: JourneySegment): PublicDrive => ({
  ...segment,
  judgment: publicJudgment(segment.judgment),
})

/** The `page` query parameter: a positive integer, 1 when absent. */
export function parseJourneyPage(raw: unknown): number {
  if (raw === undefined) return 1
  const page = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new MissionError(
      'INVALID_INPUT',
      `The page ${JSON.stringify(raw)} is not a page number; pass a positive integer.`,
    )
  }
  return page
}

export type { JourneyRange }

/** A positive integer segment number, or undefined when absent. */
function parseSegmentNumber(name: string, raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new MissionError(
      'INVALID_INPUT',
      `The ${name} ${JSON.stringify(raw)} is not a segment number; pass a positive integer.`,
    )
  }
  return n
}

/**
 * The range query parameters: `from` and `to` segment numbers (both included) and `since`, an
 * ISO instant the drives must have ended after. Undefined when none is given.
 */
export function parseJourneyRange(query: Record<string, unknown>): JourneyRange | undefined {
  const from = parseSegmentNumber('from', query.from)
  const to = parseSegmentNumber('to', query.to)
  let since: Date | undefined
  if (query.since !== undefined) {
    const ms = typeof query.since === 'string' && query.since ? Date.parse(query.since) : Number.NaN
    if (!Number.isFinite(ms)) {
      throw new MissionError(
        'INVALID_INPUT',
        `The since ${JSON.stringify(query.since)} is not an instant; pass an ISO 8601 date and time.`,
      )
    }
    since = new Date(ms)
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw new MissionError(
      'INVALID_INPUT',
      `The range from segment ${from} to segment ${to} is reversed; pass from ≤ to.`,
    )
  }
  if (from === undefined && to === undefined && since === undefined) return undefined
  return {
    ...(since === undefined ? {} : { since }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  }
}

/**
 * One page of the mission's settled drives: newest first, or within `range` oldest first, the
 * order a playlist plays them in. The drive in progress is never listed: its row holds the
 * private outcome.
 */
export async function journeyPage(
  db: DB,
  options: { missionId: string; page: number; range?: JourneyRange },
): Promise<{ drives: PublicDrive[]; page: number; pageSize: number; total: number }> {
  const { missionId, page, range } = options
  const { segments, total } = await listJourneySegments(db, missionId, {
    limit: JOURNEY_PAGE_SIZE,
    offset: (page - 1) * JOURNEY_PAGE_SIZE,
    range,
    order: range ? 'oldest' : 'newest',
  })
  return { drives: segments.map(publicDrive), page, pageSize: JOURNEY_PAGE_SIZE, total }
}

/**
 * One settled drive to replay, with what the replay needs beside it: the mission clock and
 * rules, the stops reached up to the one it left and the deaths public when it started, both as
 * the live map shows them, and the settled drive after it, if any.
 */
export async function journeyDrive(
  db: DB,
  options: { missionId: string; segmentId: string },
): Promise<{
  drive: PublicDrive
  mission: { id: string; solsEpoch: Date; rules: MissionRules }
  trail: PublicStop[]
  deaths: PublicDeath[]
  next: { id: string; number: number } | null
}> {
  const { missionId, segmentId } = options
  const drive = publicDrive(await getJourneySegment(db, segmentId, { missionId }))
  const mission = await getMission(db, missionId)
  const stops = await listStops(db, missionId)
  const { trail, deaths } = publicStopsAndDeaths(stops, await listSettledSegments(db, missionId))
  const after = drive.number + 1
  const {
    segments: [next],
  } = await listJourneySegments(db, missionId, {
    limit: 1,
    offset: 0,
    range: { from: after, to: after },
  })
  return {
    next: next ? { id: next.id, number: next.number } : null,
    drive,
    mission: { id: mission.id, solsEpoch: mission.solsEpoch, rules: mission.config.rules },
    trail: trail.filter((s) => s.index <= drive.from.index),
    deaths: deaths.filter((d) => d.number < drive.number),
  }
}
