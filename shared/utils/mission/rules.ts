import { MissionError } from './errors'

/**
 * Tunable rules of a mission, stored with it. Every "within" radius is inclusive: a distance
 * equal to the radius counts as within.
 */
export interface MissionRules {
  /** Allowed straight-line distance from the segment start to a submitted goal, metres. */
  segmentDistanceBand: { minM: number; maxM: number }
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
  /** Time the first submission after an idle drive end waits for competitors. */
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
}

export const DEFAULT_MISSION_RULES: Readonly<MissionRules> = Object.freeze({
  segmentDistanceBand: Object.freeze({ minM: 50, maxM: 250 }),
  failureZone: Object.freeze({
    destinationRadiusM: 30,
    pathRadiusM: 15,
    clusterRadiusM: 50,
    strikes: 3,
  }),
  graceWindowMs: 5 * 60_000,
  maxJudgedPerRound: 5,
  tieBreak: 'risk',
})

export interface MapPoint {
  x: number
  y: number
}

/** Why a goal is refused. Closed set. */
export type GoalRefusal = 'too-near' | 'too-far' | 'near-death-zone'

/** The distance band is checked before the death zone. */
export function checkSubmissionGoal(
  goal: MapPoint,
  options: { start: MapPoint; deaths: readonly MapPoint[]; rules: MissionRules },
): { ok: true } | { ok: false; reason: GoalRefusal } {
  const { start, deaths, rules } = options
  const distance = Math.hypot(goal.x - start.x, goal.y - start.y)
  const { minM, maxM } = rules.segmentDistanceBand
  if (distance < minM) return { ok: false, reason: 'too-near' }
  if (distance > maxM) return { ok: false, reason: 'too-far' }
  const radius = rules.failureZone.destinationRadiusM
  for (const death of deaths) {
    if (Math.hypot(goal.x - death.x, goal.y - death.y) <= radius) {
      return { ok: false, reason: 'near-death-zone' }
    }
  }
  return { ok: true }
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
  likes: number
  createdAt: Date
  judgment: { distanceWeight: number; timeWeight: number; risk: { score: number } }
}

/**
 * Most liked first, ties by `rules.tieBreak`; the id breaks what remains, so the order never
 * depends on the input order.
 */
export function rankSubmissions<T extends RankEntry>(
  entries: readonly T[],
  options: { rules: MissionRules },
): T[] {
  const confidence = (e: RankEntry) => e.judgment.distanceWeight + e.judgment.timeWeight
  const byRisk = options.rules.tieBreak === 'risk'
  return entries.toSorted(
    (a, b) =>
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
