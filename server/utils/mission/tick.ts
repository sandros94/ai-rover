import { sql } from 'drizzle-orm'
import { uuidv7 } from 'unsecure/uuid'
import type { DB } from '../../database/db'
import type { Mission, Round, Segment, SegmentStatus, Stop } from '../../database/schema'
import { getMission, setCurrentStop } from '../../repositories/missions'
import {
  closeRound,
  findUnresolvedRound,
  getOpenRound,
  openRound,
  reanchorRound,
  voidRound,
} from '../../repositories/rounds'
import {
  createSegment,
  getDrivingSegment,
  getSegment,
  listDeaths,
  settleSegment,
} from '../../repositories/segments'
import { createStop, getStop, nextStopIndex } from '../../repositories/stops'
import {
  getSubmission,
  listRoundSubmissions,
  rejectSubmission,
  reviseSubmission,
} from '../../repositories/submissions'
import type { JevClient } from '../jev/client'
import { publishSegment, publishStop } from '../journey/publish'
import type { JourneyStore } from '../journey/store'
import { driveSegment } from '#shared/utils/drive'
import { rankSubmissions, shouldResetToPreviousStop } from '#shared/utils/mission'
import {
  revealDisk,
  revealedKey,
  revealedOverDisk,
  revealVertices,
  stopManifestKey,
} from '#shared/utils/terrain'
import { roundStanding } from './round'
import type { PlanningGround } from './submit'
import { assessGoal } from './submit'
import { loadRecordReveals, loadRevealedMask, missionWorld, stopDisk } from './terrain'

/**
 * What one tick changed, in the order it happened. Public: nothing here names where a drive ends
 * before the drive is released.
 */
export interface TickResult {
  /** A drive whose end passed, made public. */
  settled: { segmentId: string; status: Exclude<SegmentStatus, 'driving'> } | null
  closed: { roundId: string; winnerSubmissionId: string } | null
  /** The winner's drive, computed in full and released from now on. */
  started: { segmentId: string; startedAt: Date } | null
  /** Beside the drive just started, or at the retry stop after a failure. */
  opened: { roundId: string } | null
}

interface TickContext {
  store: JourneyStore
  jev: JevClient
  mission: Mission
  now: Date
}

/**
 * Brings a mission up to `now`, idempotently: under a per-mission lock it (1) settles the drive
 * whose end has passed, which creates and publishes the stop it reached or voids the round beside
 * a failure, (2) closes the open round once its close time has passed, and (3) resolves a closed
 * round without a segment: drives the winner over the true terrain, publishes the drive, and
 * opens the next round from the same stop, anchored on the winner's goal. Safe to call from every
 * request; a second call at the same `now` changes nothing. `jev` re-judges the submissions
 * waiting beside a drive that stopped short.
 */
export async function tickMission(
  db: DB,
  options: { store: JourneyStore; jev: JevClient; missionId: string; now: Date },
): Promise<TickResult> {
  const { store, jev, missionId, now } = options
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${missionId}))`)
    const result: TickResult = { settled: null, closed: null, started: null, opened: null }
    const mission = await getMission(tx, missionId)
    if (mission.status !== 'active') return result
    const context: TickContext = { store, jev, mission, now }

    const driving = await getDrivingSegment(tx, missionId)
    // A null outcome means a producer outside the request still runs; it settles once written.
    if (driving?.outcome && driving.endsAt.getTime() <= now.getTime()) {
      Object.assign(result, await settle(tx, context, driving))
    }

    // The open round's segment starts where the drive beside it ends, so it waits for settlement.
    const open = await getOpenRound(tx, missionId)
    if (open && (!driving || result.settled))
      result.closed = await closeIfDue(tx, mission, open, now)

    const unresolved = await findUnresolvedRound(tx, missionId)
    if (unresolved) Object.assign(result, await resolve(tx, context, unresolved))
    return result
  })
}

/**
 * Makes a released drive's ending public. Arrived or stopped short: the stop reached is created
 * and published now, with the mask as of the drive's start, what the drive revealed and the
 * viewshed from the new stop, and the round beside the drive moves to it; after a stop short its
 * anchor moves there too and its open submissions are assessed again from there. Failed: the
 * death is recorded, the round beside the drive is voided and a fresh one opens at the stop the
 * rover retries from.
 */
async function settle(
  tx: DB,
  context: TickContext,
  driving: Segment,
): Promise<Pick<TickResult, 'settled' | 'opened'>> {
  const { store, mission, now } = context
  const outcome = driving.outcome!
  const from = await getStop(tx, driving.fromStopId)
  const beside = await getOpenRound(tx, mission.id)
  const { x, y, headingRad } = outcome.endPose

  if (outcome.kind === 'failed') {
    await settleSegment(tx, driving.id, { status: 'failed', death: { x, y }, now })
    const retry = await retryStop(tx, mission, from)
    await setCurrentStop(tx, mission.id, retry.id)
    if (beside) await voidRound(tx, beside.id, { closesAt: driving.endsAt })
    const fresh = await openRound(tx, {
      missionId: mission.id,
      fromStopId: retry.id,
      anchor: retry,
      opensAt: driving.endsAt,
    })
    return { settled: { segmentId: driving.id, status: 'failed' }, opened: { roundId: fresh.id } }
  }

  const world = missionWorld(mission)
  const index = await nextStopIndex(tx, mission.id)
  const reached = await createStop(tx, {
    missionId: mission.id,
    index,
    x,
    y,
    headingRad,
    manifestKey: stopManifestKey(mission.id, index),
    revealedKey: revealedKey(mission.id, index),
    fromSegmentId: driving.id,
  })
  const fromDisk = stopDisk(world, from)
  const seen = revealVertices(
    await loadRevealedMask(store, from),
    fromDisk,
    await loadRecordReveals(store, driving),
  )
  const disk = stopDisk(world, reached)
  const mask = revealDisk(seen, disk)

  if (beside) {
    const short = outcome.kind === 'stopped-short'
    const anchor = short ? { x, y } : { x: beside.anchorX, y: beside.anchorY }
    if (short) {
      const ground = { world, disk, revealed: revealedOverDisk(mask, disk), start: anchor }
      await reassessOpenSubmissions(tx, context, beside, ground)
    }
    await reanchorRound(tx, beside.id, { fromStopId: reached.id, anchor })
  }
  // Blobs last: a failure above (Jev, a missing slice) publishes nothing, and the rows commit
  // only after the blobs they name exist.
  await publishStop(store, { world, disk, mask, missionId: mission.id, stopIndex: index })
  await settleSegment(tx, driving.id, { status: outcome.kind, toStopId: reached.id, now })
  await setCurrentStop(tx, mission.id, reached.id)
  return { settled: { segmentId: driving.id, status: outcome.kind }, opened: null }
}

/**
 * Each open submission of `round` assessed again over `ground`: one that now breaks a rule or is
 * judged infeasible is rejected as invalidated by the stop, the others keep their place with the
 * new plan's metrics, summary and judgment. The goal itself is kept as submitted.
 */
async function reassessOpenSubmissions(
  tx: DB,
  context: TickContext,
  round: Round,
  ground: PlanningGround,
): Promise<void> {
  const { jev, mission } = context
  const deaths = await listDeaths(tx, mission.id)
  const waiting = (await listRoundSubmissions(tx, round.id)).filter((s) => s.status === 'open')
  for (const submission of waiting) {
    const assessed = await assessGoal(ground, {
      goal: { x: submission.goalX, y: submission.goalY },
      deaths,
      rules: mission.config.rules,
      jev,
    })
    if (assessed.ok) await reviseSubmission(tx, submission.id, assessed.assessment)
    if (!assessed.ok || assessed.assessment.judgment.verdict === 'reject') {
      await rejectSubmission(tx, submission.id, { reason: 'invalidated-by-stop' })
    }
  }
}

async function closeIfDue(
  tx: DB,
  mission: Mission,
  open: Round,
  now: Date,
): Promise<TickResult['closed']> {
  const { rules } = mission.config
  const { submissions, closesAt } = await roundStanding(tx, open, { rules, now })
  if (!closesAt || closesAt.getTime() > now.getTime()) return null
  const [winner] = rankSubmissions(submissions, { rules })
  // roundCloseAt is null without submissions, so a due round always has a winner.
  await closeRound(tx, open.id, { winnerSubmissionId: winner!.id, closesAt })
  return { roundId: open.id, winnerSubmissionId: winner!.id }
}

/**
 * Drives a closed round's winner from the round's stop, which is where the rover is: a round
 * closes only once the drive beside it has settled.
 */
async function resolve(
  tx: DB,
  context: TickContext,
  round: Round,
): Promise<Pick<TickResult, 'started' | 'opened'>> {
  const { store, mission, now } = context
  const winner = await getSubmission(tx, round.winnerSubmissionId!)
  const from = await getStop(tx, round.fromStopId)
  const world = missionWorld(mission)
  const { record } = driveSegment(world, {
    disk: stopDisk(world, from),
    revealed: await loadRevealedMask(store, from),
    start: { x: from.x, y: from.y, headingRad: from.headingRad },
    goal: { x: winner.goalX, y: winner.goalY },
  })

  const segmentId = uuidv7()
  const published = await publishSegment(store, {
    record,
    segmentId,
    startedAt: now.getTime(),
  })
  const segment = await createSegment(tx, {
    id: segmentId,
    missionId: mission.id,
    roundId: round.id,
    submissionId: winner.id,
    fromStopId: from.id,
    startedAt: now,
    endsAt: new Date(published.endsAt),
    manifestKey: published.manifestKey,
    outcome: record.outcome,
  })
  const next = await openRound(tx, {
    missionId: mission.id,
    fromStopId: from.id,
    anchor: { x: winner.goalX, y: winner.goalY },
    opensAt: now,
  })
  return {
    started: { segmentId: segment.id, startedAt: segment.startedAt },
    opened: { roundId: next.id },
  }
}

/**
 * Where the rover retries after failures from `from`, the latest settled: the same stop, or the
 * stop before it once `rules.failureZone.strikes` of the deaths from `from` cluster.
 */
async function retryStop(tx: DB, mission: Mission, from: Stop): Promise<Stop> {
  if (!from.fromSegmentId) return from
  const deaths = await listDeaths(tx, mission.id, { fromStopId: from.id })
  if (!shouldResetToPreviousStop(deaths, { rules: mission.config.rules })) return from
  return getStop(tx, (await getSegment(tx, from.fromSegmentId)).fromStopId)
}
