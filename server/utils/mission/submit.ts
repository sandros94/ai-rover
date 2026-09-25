import type { DB } from '../../database/db'
import { DbError } from '../../database/errors'
import type { Submission } from '../../database/schema'
import { getMission } from '../../repositories/missions'
import { getOpenRound } from '../../repositories/rounds'
import { getDrivingSegment, listDeaths } from '../../repositories/segments'
import { getStop } from '../../repositories/stops'
import {
  createSubmission,
  getSubmission,
  listRoundSubmissions,
} from '../../repositories/submissions'
import type { JevClient } from '../jev/client'
import type { JourneyStore } from '../journey/store'
import type { GoalRefusal } from '#shared/utils/mission'
import { checkPathClearOfDeaths, checkSubmissionGoal } from '#shared/utils/mission'
import { planSegment, summarizeSubmission } from '#shared/utils/nav'
import { revealedOverDisk } from '#shared/utils/terrain'
import { LifecycleError } from './errors'
import { loadRevealedMask, missionWorld, stopDisk } from './terrain'

/**
 * Why a goal was not accepted. Closed set.
 *
 * - `too-near`, `too-far`, `near-death-zone`: the goal breaks a mission rule; nothing is stored.
 * - `path-near-death-zone`: the planned route passes too close to a death; nothing is stored.
 * - `judged-infeasible`: Jev's verdict is reject; the submission is stored as `rejected`.
 */
export type SubmissionRefusal = GoalRefusal | 'path-near-death-zone' | 'judged-infeasible'

export type SubmitResult =
  | { accepted: true; submission: Submission }
  | { accepted: false; reason: SubmissionRefusal; submission: Submission | null }

/**
 * Submits a goal to the mission's open round: the goal snapped to the nearest vertex, checked
 * against the rules and the settled deaths, planned from the round's stop over what the rover has
 * seen, then judged by Jev. Throws `ALREADY_SUBMITTED` (before any planning or Jev request) while
 * the user has an open submission in the round, and `AUTHOR_DRIVING` while the rover drives the
 * user's own segment.
 */
export async function submitGoal(
  db: DB,
  options: {
    store: JourneyStore
    jev: JevClient
    missionId: string
    userId: string
    goal: { x: number; y: number }
    now: Date
  },
): Promise<SubmitResult> {
  const { store, jev, missionId, userId, now } = options
  const mission = await getMission(db, missionId)
  const round = await getOpenRound(db, missionId)
  if (!round) {
    throw new LifecycleError(
      'NO_OPEN_ROUND',
      `Mission ${missionId} has no open round; it takes submissions only while active.`,
    )
  }
  const driving = await getDrivingSegment(db, missionId)
  if (driving && driving.endsAt.getTime() > now.getTime()) {
    const author = await getSubmission(db, driving.submissionId)
    if (author.userId === userId) {
      throw new LifecycleError(
        'AUTHOR_DRIVING',
        `User ${userId} wrote the segment the rover is driving; submit again once it ends.`,
      )
    }
  }
  const submitted = await listRoundSubmissions(db, round.id)
  if (submitted.some((s) => s.userId === userId && s.status === 'open')) {
    throw new DbError(
      'ALREADY_SUBMITTED',
      `User ${userId} already has an open submission in round ${round.id}; withdraw it before submitting again.`,
    )
  }

  const { rules } = mission.config
  const world = missionWorld(mission)
  const { cellSize } = world.config
  const goal = {
    x: Math.round(options.goal.x / cellSize) * cellSize,
    y: Math.round(options.goal.y / cellSize) * cellSize,
  }
  const from = await getStop(db, round.fromStopId)
  const start = { x: from.x, y: from.y }
  const deaths = await listDeaths(db, missionId)
  const rule = checkSubmissionGoal(goal, { start, deaths, rules })
  if (!rule.ok) return { accepted: false, reason: rule.reason, submission: null }

  const disk = stopDisk(world, from)
  const revealed = revealedOverDisk(await loadRevealedMask(store, from), disk)
  const plan = planSegment(disk, {
    revealed,
    start,
    goal,
    slopeLimitDeg: world.config.slopeLimitDeg,
  })
  if (plan.polyline.length > 0 && !checkPathClearOfDeaths(plan.polyline, { deaths, rules }).ok) {
    return { accepted: false, reason: 'path-near-death-zone', submission: null }
  }
  const summary = summarizeSubmission(plan, { world, disk, revealed, start, goal })
  const { cached: _cached, usage: _usage, ...judgment } = await jev.judgeSubmission(summary)
  const rejected = judgment.verdict === 'reject'
  const submission = await createSubmission(db, {
    roundId: round.id,
    userId,
    goal,
    judgment,
    metrics: plan.metrics,
    summary,
    status: rejected ? 'rejected' : 'open',
    createdAt: now,
  })
  return rejected
    ? { accepted: false, reason: 'judged-infeasible', submission }
    : { accepted: true, submission }
}
