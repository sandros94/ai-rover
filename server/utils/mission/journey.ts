import type { DB } from '../../database/db'
import { getMission } from '../../repositories/missions'
import type { JourneySegment } from '../../repositories/segments'
import { getJourneySegment, listJourneySegments } from '../../repositories/segments'
import { listStops } from '../../repositories/stops'
import type { MissionRules } from '#shared/utils/mission'
import { MissionError } from '#shared/utils/mission'
import type { PublicSubmission } from './state'
import { publicJudgment } from './state'

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

/**
 * One page of the mission's settled drives, newest first. The drive in progress is never listed:
 * its row holds the private outcome.
 */
export async function journeyPage(
  db: DB,
  options: { missionId: string; page: number },
): Promise<{ drives: PublicDrive[]; page: number; pageSize: number; total: number }> {
  const { missionId, page } = options
  const { segments, total } = await listJourneySegments(db, missionId, {
    limit: JOURNEY_PAGE_SIZE,
    offset: (page - 1) * JOURNEY_PAGE_SIZE,
  })
  return { drives: segments.map(publicDrive), page, pageSize: JOURNEY_PAGE_SIZE, total }
}

/**
 * One settled drive to replay, with what the replay needs beside it: the mission clock and
 * rules, and the stops reached up to the one it left.
 */
export async function journeyDrive(
  db: DB,
  options: { missionId: string; segmentId: string },
): Promise<{
  drive: PublicDrive
  mission: { id: string; solsEpoch: Date; rules: MissionRules }
  trail: { index: number; x: number; y: number }[]
}> {
  const { missionId, segmentId } = options
  const drive = publicDrive(await getJourneySegment(db, segmentId, { missionId }))
  const mission = await getMission(db, missionId)
  const stops = await listStops(db, missionId)
  return {
    drive,
    mission: { id: mission.id, solsEpoch: mission.solsEpoch, rules: mission.config.rules },
    trail: stops
      .filter((s) => s.index <= drive.from.index)
      .map(({ index, x, y }) => ({ index, x, y })),
  }
}
