import type { DB } from '../../database/db'
import { DbError } from '../../database/errors'
import type { Submission } from '../../database/schema'
import { getMission } from '../../repositories/missions'
import { getOpenRound } from '../../repositories/rounds'
import { getDrivingSegment, listDeaths } from '../../repositories/segments'
import { getStop } from '../../repositories/stops'
import type { SubmissionAssessment } from '../../repositories/submissions'
import {
  createSubmission,
  getSubmission,
  listRoundSubmissions,
} from '../../repositories/submissions'
import type { JevClient } from '../jev/client'
import type { JourneyStore } from '../journey/store'
import type { GoalRefusal, MapPoint, MissionRules, SubmissionRefusal } from '#shared/utils/mission'
import { planGoal } from '#shared/utils/mission'
import { summarizeSubmission } from '#shared/utils/nav'
import type { StopDisk, World } from '#shared/utils/terrain'
import { revealedOverDisk, snapToPathable } from '#shared/utils/terrain'
import { LifecycleError } from './errors'
import { loadRevealedMask, missionWorld, stopDisk } from './terrain'

export type SubmitResult =
  | { accepted: true; submission: Submission }
  | { accepted: false; reason: SubmissionRefusal; submission: Submission | null }

/** What a goal is planned over: a stop's disk, what was seen there, and where plans start. */
export interface PlanningGround {
  world: World
  disk: StopDisk
  /** One byte per disk-grid vertex, as `revealedOverDisk` gives it. */
  revealed: Uint8Array
  start: MapPoint
}

/**
 * A goal checked against the rules and the settled deaths from `ground.start`, planned over the
 * ground, then judged by Jev; a refusal by rule asks Jev nothing. The judgment may still be a
 * reject, which the caller stores as such.
 */
export async function assessGoal(
  ground: PlanningGround,
  options: { goal: MapPoint; deaths: readonly MapPoint[]; rules: MissionRules; jev: JevClient },
): Promise<
  | { ok: true; assessment: SubmissionAssessment }
  | { ok: false; reason: GoalRefusal | 'path-near-death-zone' }
> {
  const { world, disk, revealed, start } = ground
  const { goal, deaths, rules, jev } = options
  const planned = planGoal(disk, {
    revealed,
    start,
    goal,
    deaths,
    rules,
    slopeLimitDeg: world.config.slopeLimitDeg,
  })
  if (!planned.ok) return planned
  const { plan } = planned
  const summary = summarizeSubmission(plan, { world, disk, revealed, start, goal })
  const { cached: _cached, usage: _usage, ...judgment } = await jev.judgeSubmission(summary)
  return { ok: true, assessment: { judgment, metrics: plan.metrics, summary } }
}

/**
 * Submits a goal to the mission's open round: the goal snapped to the nearest pathable vertex,
 * checked against the rules and the settled deaths, planned from the round's anchor over the
 * disk of its stop and what the rover had seen there, then judged by Jev. During a drive that is
 * the stop the rover left and its mask from before the drive, so nothing the drive discovers is
 * used. Throws `ALREADY_SUBMITTED` (before any planning or Jev request) while the user has an
 * open submission in the round, and `AUTHOR_DRIVING` while the rover drives the user's own
 * segment.
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

  const world = missionWorld(mission)
  const from = await getStop(db, round.fromStopId)
  const disk = stopDisk(world, from)
  const goal = snapToPathable(disk, options.goal)
  if (!goal) return { accepted: false, reason: 'unpathable', submission: null }
  const ground: PlanningGround = {
    world,
    disk,
    revealed: revealedOverDisk(await loadRevealedMask(store, from), disk),
    start: { x: round.anchorX, y: round.anchorY },
  }
  const assessed = await assessGoal(ground, {
    goal,
    deaths: await listDeaths(db, missionId),
    rules: mission.config.rules,
    jev,
  })
  if (!assessed.ok) return { accepted: false, reason: assessed.reason, submission: null }

  const rejected = assessed.assessment.judgment.verdict === 'reject'
  const submission = await createSubmission(db, {
    roundId: round.id,
    userId,
    goal,
    ...assessed.assessment,
    ...(rejected
      ? { status: 'rejected' as const, rejectionReason: 'judged-infeasible' as const }
      : { status: 'open' as const }),
    createdAt: now,
  })
  return rejected
    ? { accepted: false, reason: 'judged-infeasible', submission }
    : { accepted: true, submission }
}
