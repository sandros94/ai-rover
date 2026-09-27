import type { SegmentPlan } from '../nav/plan'
import { planSegment } from '../nav/plan'
import type { SnapRefusal, StopDisk } from '../terrain/disk'
import type { GoalRefusal, MapPoint, MissionRules } from './rules'
import { checkDriveTime, checkPathClearOfDeaths, checkSubmissionGoal } from './rules'

/**
 * Why a goal was not accepted. Closed set.
 *
 * - `unpathable`: the goal lies on seen ground and no seen vertex near it is traversable and
 *   reachable from the stop, unseen ground counting as passable.
 * - `outside`: the goal lies beyond the survey of the stop it is planned from.
 * - `near-death-zone`: the snapped goal lies too close to a death.
 * - `too-short`, `too-long`: the planned drive time falls outside the mission's time band.
 * - `path-near-death-zone`: the planned route passes too close to a death.
 * - `judged-infeasible`: Jev's verdict is reject.
 * - `too-many-attempts`: the user has used every judged attempt the round allows.
 * - `round-changed`: the round moved to another stop or anchor while the goal was being judged;
 *   plan again from the round as it is now.
 *
 * The last three are given only by the server, which counts attempts and asks Jev.
 */
export type SubmissionRefusal =
  | SnapRefusal
  | GoalRefusal
  | 'path-near-death-zone'
  | 'judged-infeasible'
  | 'too-many-attempts'
  | 'round-changed'

/** Why {@link planGoal} refuses a goal. Closed set. */
export type PlanRefusal = GoalRefusal | 'outside' | 'path-near-death-zone'

/**
 * A snapped goal checked against the survey and the deaths, planned from `start` over the disk,
 * then checked for its planned drive time and its route's clearance of the deaths. The server's
 * authoritative assessment and the browser's preview both run this, so the preview refuses and
 * routes exactly as a submission will. A route not reached is not refused here: Jev judges it.
 * A refusal by drive time carries the `message` that gives the estimate.
 */
export function planGoal(
  disk: StopDisk,
  options: {
    /** One byte per disk-grid vertex, as `revealedOverDisk` gives it. */
    revealed: Uint8Array
    start: MapPoint
    goal: MapPoint
    deaths: readonly MapPoint[]
    rules: MissionRules
    slopeLimitDeg: number
  },
): { ok: true; plan: SegmentPlan } | { ok: false; reason: PlanRefusal; message?: string } {
  const { revealed, start, goal, deaths, rules, slopeLimitDeg } = options
  // A goal submitted from another stop may lie beyond this one's survey.
  if (Math.hypot(goal.x - disk.center.x, goal.y - disk.center.y) > disk.radius) {
    return { ok: false, reason: 'outside' }
  }
  const rule = checkSubmissionGoal(goal, { deaths, rules })
  if (!rule.ok) return rule
  const plan = planSegment(disk, { revealed, start, goal, slopeLimitDeg })
  if (plan.metrics.reached) {
    const time = checkDriveTime(plan.metrics.estimatedDriveS, { rules })
    if (!time.ok) return time
  }
  if (plan.polyline.length > 0 && !checkPathClearOfDeaths(plan.polyline, { deaths, rules }).ok) {
    return { ok: false, reason: 'path-near-death-zone' }
  }
  return { ok: true, plan }
}
