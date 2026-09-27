import type { SegmentPlan } from '../nav/plan'
import { planSegment } from '../nav/plan'
import type { SnapRefusal, StopDisk } from '../terrain/disk'
import type { GoalRefusal, MapPoint, MissionRules } from './rules'
import { checkPathClearOfDeaths, checkSubmissionGoal } from './rules'

/**
 * Why a goal was not accepted. Closed set.
 *
 * - `unpathable`: no seen vertex near the goal is traversable and reachable from the stop.
 * - `unrevealed`: the rover has seen nothing near the goal.
 * - `outside`: the goal lies beyond the survey of the stop it is planned from.
 * - `too-near`, `too-far`, `near-death-zone`: the snapped goal breaks a mission rule.
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
 * A snapped goal checked against the survey, the rules and the deaths from `start`, then planned
 * over the disk. The server's authoritative assessment and the browser's preview both run this,
 * so the preview refuses and routes exactly as a submission will.
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
): { ok: true; plan: SegmentPlan } | { ok: false; reason: PlanRefusal } {
  const { revealed, start, goal, deaths, rules, slopeLimitDeg } = options
  // A goal submitted from another stop may lie beyond this one's survey.
  if (Math.hypot(goal.x - disk.center.x, goal.y - disk.center.y) > disk.radius) {
    return { ok: false, reason: 'outside' }
  }
  const rule = checkSubmissionGoal(goal, { start, deaths, rules })
  if (!rule.ok) return rule
  const plan = planSegment(disk, { revealed, start, goal, slopeLimitDeg })
  if (plan.polyline.length > 0 && !checkPathClearOfDeaths(plan.polyline, { deaths, rules }).ok) {
    return { ok: false, reason: 'path-near-death-zone' }
  }
  return { ok: true, plan }
}
