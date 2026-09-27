import type { DB } from '../../database/db'
import { DbError } from '../../database/errors'
import type { Submission } from '../../database/schema'
import { getMission } from '../../repositories/missions'
import { getOpenRound } from '../../repositories/rounds'
import { listDeaths } from '../../repositories/segments'
import { getStop } from '../../repositories/stops'
import type { SubmissionAssessment } from '../../repositories/submissions'
import {
  countUserRoundSubmissions,
  createSubmission,
  listRoundSubmissions,
} from '../../repositories/submissions'
import type { JevClient } from '../jev/client'
import type { JourneyStore } from '../journey/store'
import type { MapPoint, MissionRules, PlanRefusal, SubmissionRefusal } from '#shared/utils/mission'
import { planGoal } from '#shared/utils/mission'
import { summarizeSubmission } from '#shared/utils/nav'
import type { StopDisk, World } from '#shared/utils/terrain'
import { revealedOverDisk, snapToPathable } from '#shared/utils/terrain'
import { LifecycleError } from './errors'
import { assertNotPaused } from './pause'
import { recordNextDue } from './round'
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
): Promise<{ ok: true; assessment: SubmissionAssessment } | { ok: false; reason: PlanRefusal }> {
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
 * Submits a goal to the mission's open round: the goal snapped to the nearest seen pathable vertex,
 * checked against the rules and the settled deaths, planned from the round's anchor over the
 * disk of its stop and what the rover had seen there, then judged by Jev. During a drive that is
 * the stop the rover left and its mask from before the drive, so nothing the drive discovers is
 * used. An accepted goal starts with its author's like. Throws `MISSION_PAUSED` while an operator
 * pauses the mission and `ALREADY_SUBMITTED` (both before any planning or Jev request) while the
 * user has an open submission in the round; refuses `too-many-attempts`, also before planning, once the user has made
 * `rules.maxJudgedPerRound` submissions in the round, and `round-changed`, storing nothing, when
 * the round moved to another stop or anchor while the goal was planned and judged.
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
  await assertNotPaused(db, missionId)
  const round = await getOpenRound(db, missionId)
  if (!round) {
    throw new LifecycleError(
      'NO_OPEN_ROUND',
      `Mission ${missionId} has no open round; it takes submissions only while active.`,
    )
  }
  const submitted = await listRoundSubmissions(db, round.id)
  if (submitted.some((s) => s.userId === userId && s.status === 'open')) {
    throw new DbError(
      'ALREADY_SUBMITTED',
      `User ${userId} already has an open submission in round ${round.id}; withdraw it before submitting again.`,
    )
  }

  const attempts = await countUserRoundSubmissions(db, { roundId: round.id, userId })
  if (attempts >= mission.config.rules.maxJudgedPerRound) {
    return { accepted: false, reason: 'too-many-attempts', submission: null }
  }

  const world = missionWorld(mission)
  const from = await getStop(db, round.fromStopId)
  const disk = stopDisk(world, from, { radius: mission.config.rules.stopRadiusM })
  const revealed = revealedOverDisk(await loadRevealedMask(store, from), disk)
  const snapped = snapToPathable(disk, options.goal, { revealed })
  if (!snapped.ok) return { accepted: false, reason: snapped.reason, submission: null }
  const goal = snapped.point
  const ground: PlanningGround = {
    world,
    disk,
    revealed,
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
  let submission: Submission
  try {
    submission = await createSubmission(db, {
      roundId: round.id,
      userId,
      goal,
      plannedFrom: { fromStopId: round.fromStopId, anchor: ground.start },
      ...assessed.assessment,
      ...(rejected
        ? { status: 'rejected' as const, rejectionReason: 'judged-infeasible' as const }
        : { status: 'open' as const }),
      createdAt: now,
    })
  } catch (error) {
    // A settlement moved the round while the goal was planned and judged.
    if (error instanceof DbError && error.code === 'ROUND_CHANGED') {
      return { accepted: false, reason: 'round-changed', submission: null }
    }
    throw error
  }
  // The first open submission of an idle round starts its planning phase.
  if (!rejected) await recordNextDue(db, mission, now)
  return rejected
    ? { accepted: false, reason: 'judged-infeasible', submission }
    : { accepted: true, submission }
}
