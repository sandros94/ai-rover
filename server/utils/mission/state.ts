import type { DB } from '../../database/db'
import type { Mission, SegmentStatus, Stop } from '../../database/schema'
import { getMission } from '../../repositories/missions'
import { getOpenRound } from '../../repositories/rounds'
import { getDrivingSegment, listDeaths } from '../../repositories/segments'
import { getStop, listStops } from '../../repositories/stops'
import type { Verdict } from '../jev/client'
import { DEFAULT_SLICE_SECONDS } from '#shared/utils/drive'
import type { MissionRules } from '#shared/utils/mission'
import type { SubmissionSummary } from '#shared/utils/nav'
import { LifecycleError } from './errors'
import { roundStanding } from './round'

export interface PublicSubmission {
  id: string
  goal: { x: number; y: number }
  createdAt: Date
  likes: number
  submitter: { id: string; displayName: string; avatarUrl: string | null }
  judgment: {
    feasible: number
    verdict: Verdict
    /** Jev's expected risk level; lower is safer and wins ties. */
    risk: number
    distanceWeight: number
    timeWeight: number
  }
  summary: SubmissionSummary
}

/**
 * The mission as anyone may see it at `now`. While a drive plays, nothing names where it ends:
 * no outcome and no end time; the open round leaves from the stop the rover left and is anchored
 * on the drive's planned goal, both already public.
 */
export interface PublicMissionState {
  now: Date
  mission: Pick<Mission, 'id' | 'status' | 'worldHash' | 'solsEpoch' | 'createdAt'> & {
    rules: MissionRules
  }
  currentStop: Pick<Stop, 'id' | 'index' | 'x' | 'y' | 'headingRad' | 'manifestKey' | 'revealedKey'>
  round: {
    id: string
    opensAt: Date
    /** The stop the rover is at, or left from while a drive plays. */
    fromStopId: string
    /** Where submissions are measured and planned from: that stop, or the planned goal. */
    anchor: { x: number; y: number }
    /**
     * Null while a drive plays, since the round closes when the drive ends and that end is
     * private until then; also null while the rover idles and nobody has submitted.
     */
    closesAt: Date | null
    submissions: PublicSubmission[]
  } | null
  segment: {
    id: string
    status: SegmentStatus
    attempt: number
    startedAt: Date
    submissionId: string
    fromStopId: string
    manifestKey: string
  } | null
  /** How the driving segment's slices are released; null while none drives. */
  release: { startedAt: Date; sliceSeconds: number } | null
  /** Every stop reached so far, by index; a stop exists only once its drive has settled. */
  trail: { index: number; x: number; y: number }[]
  /** Death positions of settled failures, oldest first: goals and routes must keep clear. */
  deaths: { x: number; y: number }[]
}

export async function publicMissionState(
  db: DB,
  options: { missionId: string; now: Date },
): Promise<PublicMissionState> {
  const { missionId, now } = options
  const mission = await getMission(db, missionId)
  if (!mission.currentStopId) {
    throw new LifecycleError(
      'NO_ACTIVE_MISSION',
      `Mission ${missionId} has not landed: it has no current stop.`,
    )
  }
  const stop = await getStop(db, mission.currentStopId)
  const open = await getOpenRound(db, missionId)
  const driving = await getDrivingSegment(db, missionId)
  // Segments are created with their slices published at the default length.
  const sliceSeconds = DEFAULT_SLICE_SECONDS

  let round: PublicMissionState['round'] = null
  if (open) {
    const { submissions, closesAt } = await roundStanding(db, open, {
      rules: mission.config.rules,
      now,
    })
    const playing = driving !== undefined && driving.endsAt.getTime() > now.getTime()
    round = {
      id: open.id,
      opensAt: open.opensAt,
      closesAt: playing ? null : closesAt,
      fromStopId: open.fromStopId,
      anchor: { x: open.anchorX, y: open.anchorY },
      submissions: submissions.map((s) => ({
        id: s.id,
        goal: { x: s.goalX, y: s.goalY },
        createdAt: s.createdAt,
        likes: s.likes,
        submitter: s.submitter,
        judgment: {
          feasible: s.judgment.feasible,
          verdict: s.judgment.verdict,
          risk: s.judgment.risk.score,
          distanceWeight: s.judgment.distanceWeight,
          timeWeight: s.judgment.timeWeight,
        },
        summary: s.summary,
      })),
    }
  }

  return {
    now,
    mission: {
      id: mission.id,
      status: mission.status,
      worldHash: mission.worldHash,
      solsEpoch: mission.solsEpoch,
      createdAt: mission.createdAt,
      rules: mission.config.rules,
    },
    currentStop: {
      id: stop.id,
      index: stop.index,
      x: stop.x,
      y: stop.y,
      headingRad: stop.headingRad,
      manifestKey: stop.manifestKey,
      revealedKey: stop.revealedKey,
    },
    round,
    segment: !driving
      ? null
      : {
          id: driving.id,
          status: driving.status,
          attempt: driving.attempt,
          startedAt: driving.startedAt,
          submissionId: driving.submissionId,
          fromStopId: driving.fromStopId,
          manifestKey: driving.manifestKey,
        },
    release: driving ? { startedAt: driving.startedAt, sliceSeconds } : null,
    trail: (await listStops(db, missionId)).map(({ index, x, y }) => ({ index, x, y })),
    deaths: (await listDeaths(db, missionId)).map(({ x, y }) => ({ x, y })),
  }
}
