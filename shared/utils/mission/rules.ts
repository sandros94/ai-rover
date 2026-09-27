import * as v from 'valibot'
import { DEFAULT_STOP_RADIUS } from '../terrain/disk'
import { MissionError } from './errors'

/**
 * Tunable rules of a mission, stored with it. Every "within" radius is inclusive: a distance
 * equal to the radius counts as within.
 */
export interface MissionRules {
  /**
   * Radius of every stop's survey, metres: the ground a stop publishes, and where a round's goals
   * are picked and planned.
   */
  stopRadiusM: number
  /** Allowed planned drive time of a segment (the plan's `estimatedDriveS`), seconds. */
  segmentTimeBand: { minS: number; maxS: number }
  failureZone: {
    /** A goal may not end within this distance of a death position. */
    destinationRadiusM: number
    /** A planned path may not pass within this distance of a death position. */
    pathRadiusM: number
    /** Deaths pairwise within this distance form a cluster. */
    clusterRadiusM: number
    /** Deaths in one cluster that reset the rover to the previous stop. */
    strikes: number
  }
  /** The planning phase: how long the first submission after an idle drive end waits for competitors. */
  graceWindowMs: number
  /**
   * Submissions one user may make in one round, whatever became of them (withdrawn and rejected
   * ones included): each was planned and judged by Jev, so this bounds what one user can spend.
   */
  maxJudgedPerRound: number
  /**
   * How submissions with equal likes are ordered. `'risk'`: lower Jev risk score, then higher
   * confidence sum, then earlier. `'confidence'`: higher confidence sum, then earlier.
   * Closed set.
   */
  tieBreak: 'risk' | 'confidence'
  /**
   * When a playing drive is failed as not moving. Flags of distinct users within `windowMs` reach
   * the quorum, `min(quorumMax, max(quorumMin, ceil(active / 2)))` over the users active in the
   * round, and the released playback shows under `progressM` of displacement over that window;
   * or, whatever the flags, the record shows under `progressM` over `backstopMs`.
   */
  notMoving: {
    quorumMax: number
    quorumMin: number
    windowMs: number
    progressM: number
    backstopMs: number
  }
}

export const DEFAULT_MISSION_RULES: Readonly<MissionRules> = Object.freeze({
  stopRadiusM: DEFAULT_STOP_RADIUS,
  segmentTimeBand: Object.freeze({ minS: 15 * 60, maxS: 2 * 3600 }),
  failureZone: Object.freeze({
    destinationRadiusM: 30,
    pathRadiusM: 15,
    clusterRadiusM: 50,
    strikes: 3,
  }),
  graceWindowMs: 5 * 60_000,
  maxJudgedPerRound: 5,
  tieBreak: 'risk',
  notMoving: Object.freeze({
    quorumMax: 5,
    quorumMin: 2,
    windowMs: 10 * 60_000,
    progressM: 0.5,
    backstopMs: 15 * 60_000,
  }),
})

const seconds = v.pipe(v.number(), v.finite(), v.minValue(0))
const metres = v.pipe(v.number(), v.finite(), v.minValue(0))
const milliseconds = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0))

/** Mission rules as stored with a mission; nothing else is accepted, extra fields included. */
export const MissionRulesSchema = v.strictObject({
  stopRadiusM: v.pipe(v.number(), v.finite(), v.gtValue(0)),
  segmentTimeBand: v.pipe(
    v.strictObject({ minS: seconds, maxS: seconds }),
    v.check((band) => band.minS <= band.maxS, 'segmentTimeBand.minS exceeds maxS'),
  ),
  failureZone: v.strictObject({
    destinationRadiusM: metres,
    pathRadiusM: metres,
    clusterRadiusM: metres,
    strikes: count,
  }),
  graceWindowMs: milliseconds,
  maxJudgedPerRound: count,
  tieBreak: v.picklist(['risk', 'confidence']),
  notMoving: v.strictObject({
    quorumMax: count,
    quorumMin: count,
    windowMs: milliseconds,
    progressM: metres,
    backstopMs: milliseconds,
  }),
}) satisfies v.GenericSchema<unknown, MissionRules>

/** Stored mission rules, checked against {@link MissionRulesSchema}; throws `INVALID_INPUT`. */
export function parseMissionRules(value: unknown): MissionRules {
  const parsed = v.safeParse(MissionRulesSchema, value)
  if (!parsed.success) {
    const [issue] = parsed.issues
    throw new MissionError(
      'INVALID_INPUT',
      `Mission rules are invalid: ${v.getDotPath(issue) ?? '(root)'} ${issue.message}. Migrate the stored rules to the current shape.`,
      { cause: new v.ValiError(parsed.issues) },
    )
  }
  return parsed.output
}

export interface MapPoint {
  x: number
  y: number
}

/** Why a goal is refused by rule. Closed set. */
export type GoalRefusal = 'too-short' | 'too-long' | 'near-death-zone'

/** A goal ending within the destination radius of a death is refused. */
export function checkSubmissionGoal(
  goal: MapPoint,
  options: { deaths: readonly MapPoint[]; rules: MissionRules },
): { ok: true } | { ok: false; reason: 'near-death-zone' } {
  const { deaths, rules } = options
  const radius = rules.failureZone.destinationRadiusM
  for (const death of deaths) {
    if (Math.hypot(goal.x - death.x, goal.y - death.y) <= radius) {
      return { ok: false, reason: 'near-death-zone' }
    }
  }
  return { ok: true }
}

/**
 * A planned drive time checked against `rules.segmentTimeBand`; a refusal says why in words,
 * the estimate included. The bounds themselves are allowed.
 */
export function checkDriveTime(
  estimatedS: number,
  options: { rules: MissionRules },
): { ok: true } | { ok: false; reason: 'too-short' | 'too-long'; message: string } {
  if (!Number.isFinite(estimatedS) || estimatedS < 0) {
    throw new MissionError(
      'INVALID_INPUT',
      `checkDriveTime: estimatedS is ${estimatedS}; pass the plan's estimated drive time, seconds ≥ 0.`,
    )
  }
  const { minS, maxS } = options.rules.segmentTimeBand
  const planned = `The planned drive takes about ${formatDriveTime(estimatedS)}`
  if (estimatedS < minS) {
    return {
      ok: false,
      reason: 'too-short',
      message: `${planned}; a segment drives at least ${formatDriveTime(minS)}.`,
    }
  }
  if (estimatedS > maxS) {
    return {
      ok: false,
      reason: 'too-long',
      message: `${planned}; a segment drives at most ${formatDriveTime(maxS)}.`,
    }
  }
  return { ok: true }
}

/** A drive time in whole minutes, as "42 min", "2 h" or "1 h 05 min". */
export function formatDriveTime(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} min`
}

/**
 * `nearestM` is the smallest distance from any death to any segment of the polyline (a single
 * point counts as a zero-length segment), `Infinity` with no deaths.
 */
export function checkPathClearOfDeaths(
  polyline: readonly MapPoint[],
  options: { deaths: readonly MapPoint[]; rules: MissionRules },
): { ok: boolean; nearestM: number } {
  if (polyline.length === 0) {
    throw new MissionError(
      'INVALID_INPUT',
      'Polyline is empty; pass at least one point (the planned route).',
    )
  }
  let nearestM = Infinity
  for (const death of options.deaths) {
    if (polyline.length === 1) {
      nearestM = Math.min(nearestM, Math.hypot(death.x - polyline[0]!.x, death.y - polyline[0]!.y))
    }
    for (let k = 1; k < polyline.length; k++) {
      nearestM = Math.min(nearestM, distanceToSegment(death, polyline[k - 1]!, polyline[k]!))
    }
  }
  return { ok: nearestM > options.rules.failureZone.pathRadiusM, nearestM }
}

function distanceToSegment(p: MapPoint, a: MapPoint, b: MapPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * True when `rules.failureZone.strikes` of the deaths lie pairwise within `clusterRadiusM`: a
 * chain of near neighbours does not count.
 */
export function shouldResetToPreviousStop(
  deaths: readonly MapPoint[],
  options: { rules: MissionRules },
): boolean {
  const { clusterRadiusM, strikes } = options.rules.failureZone
  if (strikes <= 0) return true
  const near = (a: MapPoint, b: MapPoint) => Math.hypot(a.x - b.x, a.y - b.y) <= clusterRadiusM
  const clique: MapPoint[] = []
  // Deaths per stop are few, so an exhaustive clique search stays cheap.
  function grow(from: number): boolean {
    if (clique.length === strikes) return true
    for (let k = from; k <= deaths.length - (strikes - clique.length); k++) {
      const candidate = deaths[k]!
      if (clique.every((member) => near(member, candidate))) {
        clique.push(candidate)
        if (grow(k + 1)) return true
        clique.pop()
      }
    }
    return false
  }
  return grow(0)
}

export interface RankEntry {
  id: string
  /** The submitter. */
  userId: string
  likes: number
  createdAt: Date
  judgment: { distanceWeight: number; timeWeight: number; risk: { score: number } }
}

/**
 * Most liked first, ties by `rules.tieBreak`; the id breaks what remains, so the order never
 * depends on the input order. Submissions by `drivingAuthorId`, who wrote the drive the round
 * runs beside, rank after everyone else's whatever their likes: others take precedence, and the
 * author's pick wins only when nobody else's is left.
 */
export function rankSubmissions<T extends RankEntry>(
  entries: readonly T[],
  options: { rules: MissionRules; drivingAuthorId?: string | null },
): T[] {
  const confidence = (e: RankEntry) => e.judgment.distanceWeight + e.judgment.timeWeight
  const byRisk = options.rules.tieBreak === 'risk'
  const deferred = (e: RankEntry) =>
    options.drivingAuthorId != null && e.userId === options.drivingAuthorId ? 1 : 0
  return entries.toSorted(
    (a, b) =>
      deferred(a) - deferred(b) ||
      b.likes - a.likes ||
      (byRisk ? a.judgment.risk.score - b.judgment.risk.score : 0) ||
      confidence(b) - confidence(a) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/**
 * When the open round closes. While the drive plays, at its end; after it, still at its end if a
 * submission was waiting then, otherwise `graceWindowMs` after the first submission. Null while
 * the drive has ended (or none exists) and nobody has submitted: the rover idles.
 */
export function roundCloseAt(options: {
  driveEndsAt: Date | null
  firstSubmissionAt: Date | null
  now: Date
  rules: MissionRules
}): Date | null {
  const { driveEndsAt, firstSubmissionAt, now, rules } = options
  if (driveEndsAt && driveEndsAt.getTime() > now.getTime()) return driveEndsAt
  if (!firstSubmissionAt) return null
  if (driveEndsAt && firstSubmissionAt.getTime() <= driveEndsAt.getTime()) return driveEndsAt
  return new Date(firstSubmissionAt.getTime() + rules.graceWindowMs)
}
