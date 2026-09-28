import type { DB } from '../../database/db'
import type { Mission, SegmentStatus, Stop, StoredJudgment } from '../../database/schema'
import { getMission } from '../../repositories/missions'
import { getActivePause } from '../../repositories/pauses'
import { getOpenRound } from '../../repositories/rounds'
import { getAuthoredSubmission } from '../../repositories/submissions'
import type { SettledSegment } from '../../repositories/segments'
import { getDrivingSegment, listSettledSegments } from '../../repositories/segments'
import { getStop, listStops } from '../../repositories/stops'
import type { Verdict } from '../jev/client'
import { DEFAULT_SLICE_SECONDS } from '#shared/utils/drive'
import type { MissionRules } from '#shared/utils/mission'
import { shouldResetToPreviousStop } from '#shared/utils/mission'
import type { SubmissionSummary } from '#shared/utils/nav'
import { LifecycleError } from './errors'
import { notMovingStanding } from './not-moving'
import { roundStanding } from './round'

export interface PublicSubmission {
  id: string
  goal: { x: number; y: number }
  createdAt: Date
  likes: number
  submitter: { id: string; displayName: string; avatarUrl: string | null }
  /**
   * Written by the author of the drive the round runs beside: everyone else's submission takes
   * precedence, whatever the likes.
   */
  deferred: boolean
  judgment: {
    feasible: number
    verdict: Verdict
    /** Jev's expected risk level; lower is safer and wins ties. */
    risk: number
    distanceWeight: number
    timeWeight: number
    /** Jev's probability of each level, safest or least confident first. */
    probabilities: { risk: number[]; distanceConfidence: number[]; timeConfidence: number[] }
  }
  summary: SubmissionSummary
}

export type { SettledSegment }

/** A stored judgment as the public sees it: scores and per-level probabilities, no cache flags. */
export function publicJudgment(judgment: StoredJudgment): PublicSubmission['judgment'] {
  return {
    feasible: judgment.feasible,
    verdict: judgment.verdict,
    risk: judgment.risk.score,
    distanceWeight: judgment.distanceWeight,
    timeWeight: judgment.timeWeight,
    probabilities: {
      risk: judgment.risk.probabilities,
      distanceConfidence: judgment.distanceConfidence.probabilities,
      timeConfidence: judgment.timeConfidence.probabilities,
    },
  }
}

/** Journey totals over settled segments: a drive counts once its ending is public. */
export interface JourneyTally {
  /** Ground distance of every settled drive, failures included, metres. */
  distanceM: number
  /** Stops reached, the landing stop included. */
  stops: number
  arrived: number
  stoppedShort: number
  failed: number
  /** Returns to the previous stop after clustered failures. */
  resets: number
  /** Ground distance of the longest settled drive, metres. */
  longestM: number
}

/**
 * Totals of `segments` (settled, in start order) over the mission's `stops`. A reset is counted
 * where the tick applies one: at a failure from a reached stop (never the landing stop) once the
 * deaths from that stop cluster by `rules`.
 */
export function journeyTally(
  segments: readonly Pick<SettledSegment, 'status' | 'fromStopId' | 'distanceM' | 'death'>[],
  options: { stops: readonly { id: string; fromSegmentId: string | null }[]; rules: MissionRules },
): JourneyTally {
  const reached = new Set(options.stops.filter((s) => s.fromSegmentId).map((s) => s.id))
  const deathsFrom = new Map<string, { x: number; y: number }[]>()
  const reset = new Set<string>()
  const tally: JourneyTally = {
    distanceM: 0,
    stops: options.stops.length,
    arrived: 0,
    stoppedShort: 0,
    failed: 0,
    resets: 0,
    longestM: 0,
  }
  for (const s of segments) {
    tally.distanceM += s.distanceM
    tally.longestM = Math.max(tally.longestM, s.distanceM)
    if (s.status === 'arrived') tally.arrived++
    else if (s.status === 'stopped-short') tally.stoppedShort++
    else {
      tally.failed++
      const deaths = deathsFrom.get(s.fromStopId) ?? []
      if (s.death) deaths.push(s.death)
      deathsFrom.set(s.fromStopId, deaths)
      if (
        reached.has(s.fromStopId) &&
        !reset.has(s.fromStopId) &&
        shouldResetToPreviousStop(deaths, { rules: options.rules })
      ) {
        reset.add(s.fromStopId)
        tally.resets++
      }
    }
  }
  return tally
}

/** A settled segment as a stop or a death names it: its number among settled drives, from 1. */
export interface PublicSegmentRef {
  segmentId: string
  number: number
  /** Index of the stop it left. */
  fromIndex: number
}

/** A stop reached, with the settled drive that reached it; null for the landing stop. */
export interface PublicStop {
  index: number
  x: number
  y: number
  reachedBy: (PublicSegmentRef & { at: Date }) | null
}

/** Where a settled drive lost the rover, why, when its ending became public, how far it drove. */
export interface PublicDeath extends PublicSegmentRef {
  x: number
  y: number
  reasons: string[]
  at: Date
  distanceM: number
}

/**
 * The public stops and deaths of `stops` and `segments` (settled, in start order: a segment's
 * number is its place in that order).
 */
export function publicStopsAndDeaths(
  stops: readonly {
    id: string
    index: number
    x: number
    y: number
    fromSegmentId: string | null
  }[],
  segments: readonly SettledSegment[],
): { trail: PublicStop[]; deaths: PublicDeath[] } {
  const indexOf = new Map(stops.map((s) => [s.id, s.index]))
  const refs = new Map(
    segments.map((s, k) => [
      s.id,
      {
        segment: s,
        ref: { segmentId: s.id, number: k + 1, fromIndex: indexOf.get(s.fromStopId)! },
      },
    ]),
  )
  const trail = stops.map(({ index, x, y, fromSegmentId }): PublicStop => {
    const by = fromSegmentId ? refs.get(fromSegmentId) : undefined
    return { index, x, y, reachedBy: by ? { ...by.ref, at: by.segment.endsAt } : null }
  })
  const deaths = [...refs.values()].flatMap(({ segment, ref }): PublicDeath[] =>
    segment.death
      ? [
          {
            ...segment.death,
            ...ref,
            reasons: [...segment.reasons],
            at: segment.endsAt,
            distanceM: segment.distanceM,
          },
        ]
      : [],
  )
  return { trail, deaths }
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
    /** The winning submission's author, as its round listed it. */
    submitter: { displayName: string; avatarUrl: string | null }
    /**
     * The winning submission's route as its round showed it: path length and estimated drive
     * time. Null when its summary holds no route.
     */
    plan: { pathLengthM: number; estimatedMinutes: number } | null
  } | null
  /** How the driving segment's slices are released; null while none drives. */
  release: { startedAt: Date; sliceSeconds: number } | null
  /**
   * "Rover not moving" flags on the drive in progress: how many count now and how many fail it
   * (with no progress over the window); null while none plays.
   */
  flags: { count: number; quorum: number } | null
  /** An operator's pause: submissions and likes are refused while it lasts. */
  pause: {
    message: string
    by: { displayName: string; avatarUrl: string | null }
    at: Date
  } | null
  /** Every stop reached so far, by index; a stop exists only once its drive has settled. */
  trail: PublicStop[]
  /** Settled failures, oldest first: goals and routes must keep clear of their positions. */
  deaths: PublicDeath[]
  /** The most recently started settled segment, for replay; null before the first settles. */
  lastSegment: Pick<
    SettledSegment,
    'id' | 'status' | 'startedAt' | 'endsAt' | 'fromStopId' | 'distanceM'
  > | null
  tally: JourneyTally
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
  const playing = driving !== undefined && driving.endsAt.getTime() > now.getTime()
  // Segments are created with their slices published at the default length.
  const sliceSeconds = DEFAULT_SLICE_SECONDS

  let round: PublicMissionState['round'] = null
  if (open) {
    const { submissions, closesAt, drivingAuthorId } = await roundStanding(db, open, {
      rules: mission.config.rules,
      now,
    })
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
        deferred: s.userId === drivingAuthorId,
        judgment: publicJudgment(s.judgment),
        summary: s.summary,
      })),
    }
  }

  const stops = await listStops(db, missionId)
  const settled = await listSettledSegments(db, missionId)
  const last = settled.at(-1)
  const flags = playing
    ? await notMovingStanding(db, {
        segmentId: driving.id,
        roundId: open?.id ?? null,
        rules: mission.config.rules,
        now,
      })
    : null
  const pause = await getActivePause(db, missionId)
  const winner = driving ? await getAuthoredSubmission(db, driving.submissionId) : undefined
  const route = winner?.summary.route

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
    segment:
      driving && winner
        ? {
            id: driving.id,
            status: driving.status,
            attempt: driving.attempt,
            startedAt: driving.startedAt,
            submissionId: driving.submissionId,
            fromStopId: driving.fromStopId,
            manifestKey: driving.manifestKey,
            submitter: {
              displayName: winner.submitter.displayName,
              avatarUrl: winner.submitter.avatarUrl,
            },
            plan: route?.reached
              ? {
                  pathLengthM: route.path_length_m,
                  estimatedMinutes: route.estimated_drive_minutes,
                }
              : null,
          }
        : null,
    release: driving ? { startedAt: driving.startedAt, sliceSeconds } : null,
    flags,
    pause: pause
      ? {
          message: pause.message,
          by: { displayName: pause.by.displayName, avatarUrl: pause.by.avatarUrl },
          at: pause.at,
        }
      : null,
    // Segments of a mission never overlap, so start order is also the order their deaths became public.
    ...publicStopsAndDeaths(stops, settled),
    lastSegment: last
      ? {
          id: last.id,
          status: last.status,
          startedAt: last.startedAt,
          endsAt: last.endsAt,
          fromStopId: last.fromStopId,
          distanceM: last.distanceM,
        }
      : null,
    tally: journeyTally(settled, { stops, rules: mission.config.rules }),
  }
}
