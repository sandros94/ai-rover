import { sql } from 'drizzle-orm'
import { uuidv7 } from 'unsecure/uuid'
import type { DB } from '../../database/db'
import type { Mission, Round, Segment, SegmentStatus, Stop } from '../../database/schema'
import { getMission, setCurrentStop } from '../../repositories/missions'
import {
  closeRound,
  getOpenRound,
  lockOpenRound,
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
import type { ListedSubmission } from '../../repositories/submissions'
import {
  listRoundSubmissions,
  lockOpenSubmissions,
  rejectSubmission,
  reviseSubmission,
} from '../../repositories/submissions'
import type { JevClient } from '../jev/client'
import { publishSegment, publishStop } from '../journey/publish'
import type { JourneyStore } from '../journey/store'
import type { SegmentRecord } from '#shared/utils/drive'
import { driveSegment, DriveError } from '#shared/utils/drive'
import { rankSubmissions, shouldResetToPreviousStop } from '#shared/utils/mission'
import { NavError } from '#shared/utils/nav'
import type { RevealedMask, StopDisk } from '#shared/utils/terrain'
import {
  computeStopDisk,
  revealDisk,
  revealedKey,
  revealedOverDisk,
  revealVertices,
  stopManifestKey,
  TerrainError,
} from '#shared/utils/terrain'
import { recordNextDue, roundStanding } from './round'
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
  /**
   * Beside the drive just started, at the retry stop after a failure, or at the same stop when no
   * candidate of a closing round could be driven.
   */
  opened: { roundId: string } | null
}

interface TickContext {
  store: JourneyStore
  mission: Mission
  now: Date
}

type Assessment = Awaited<ReturnType<typeof assessGoal>>

/**
 * Everything a settlement computes before it takes the lock: the stop reached, its disk, the mask
 * with the drive's reveals and the new viewshed, and after a stop short each open submission of
 * the round beside it planned and judged again from there, keyed by submission id.
 */
interface PreparedSettlement {
  segmentId: string
  disk: StopDisk
  mask: RevealedMask
  assessments: Map<string, Assessment>
}

/**
 * Brings a mission up to `now`, idempotently: under a per-mission lock it (1) settles the drive
 * whose end has passed, which creates and publishes the stop it reached or voids the round beside
 * a failure, (2) closes the open round once its close time has passed on the best ranked
 * submission whose drive can be computed, drives it over the true terrain, publishes the drive
 * and opens the next round from the same stop, anchored on the winner's goal, and (3) records
 * when the next tick has something to do. Safe to call from every request; a second call at the
 * same `now` changes nothing. `jev` re-judges the submissions waiting beside a drive that stopped
 * short, before the lock is taken so no Jev request holds it.
 */
export async function tickMission(
  db: DB,
  options: { store: JourneyStore; jev: JevClient; missionId: string; now: Date },
): Promise<TickResult> {
  const { store, jev, missionId, now } = options
  const prepared = await prepareSettlement(db, { store, jev, missionId, now })
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${missionId}))`)
    const result: TickResult = { settled: null, closed: null, started: null, opened: null }
    const mission = await getMission(tx, missionId)
    if (mission.status !== 'active') return result
    const context: TickContext = { store, mission, now }

    const driving = await getDrivingSegment(tx, missionId)
    // A null outcome means a producer outside the request still runs; it settles once written.
    if (driving?.outcome && driving.endsAt.getTime() <= now.getTime()) {
      Object.assign(result, await settle(tx, context, driving, prepared))
    }

    // The open round's segment starts where the drive beside it ends, so it waits for settlement.
    const open = await getOpenRound(tx, missionId)
    if (open && (!driving || result.settled)) {
      Object.assign(result, await closeIfDue(tx, context, open))
    }
    await recordNextDue(tx, mission, now)
    return result
  })
}

/**
 * The settlement of the drive due at `now`, computed without a transaction or a lock: null when
 * no drive is due or it failed (a failure only records the death). The snapshot may be overtaken
 * before the lock is taken; {@link settle} reconciles it.
 */
async function prepareSettlement(
  db: DB,
  options: { store: JourneyStore; jev: JevClient; missionId: string; now: Date },
): Promise<PreparedSettlement | null> {
  const { store, jev, missionId, now } = options
  const mission = await getMission(db, missionId)
  if (mission.status !== 'active') return null
  const driving = await getDrivingSegment(db, missionId)
  const outcome = driving?.outcome
  if (!driving || !outcome || driving.endsAt.getTime() > now.getTime()) return null
  if (outcome.kind === 'failed') return null

  const world = missionWorld(mission)
  const from = await getStop(db, driving.fromStopId)
  const seen = revealVertices(
    await loadRevealedMask(store, from),
    stopDisk(world, from),
    await loadRecordReveals(store, driving),
  )
  const { x, y } = outcome.endPose
  const disk = computeStopDisk(world, { center: { x, y } })
  const mask = revealDisk(seen, disk)
  const assessments = new Map<string, Assessment>()

  const beside = await getOpenRound(db, missionId)
  if (beside && outcome.kind === 'stopped-short') {
    const ground = { world, disk, revealed: revealedOverDisk(mask, disk), start: { x, y } }
    const deaths = await listDeaths(db, missionId)
    const waiting = (await listRoundSubmissions(db, beside.id)).filter((s) => s.status === 'open')
    for (const submission of waiting) {
      const assessed = await assessGoal(ground, {
        goal: { x: submission.goalX, y: submission.goalY },
        deaths,
        rules: mission.config.rules,
        jev,
      })
      assessments.set(submission.id, assessed)
    }
  }
  return { segmentId: driving.id, disk, mask, assessments }
}

/**
 * Makes a released drive's ending public. Arrived or stopped short: the stop reached is created
 * and published now, with the mask as of the drive's start, what the drive revealed and the
 * viewshed from the new stop, and the round beside the drive moves to it; after a stop short its
 * anchor moves there too and its open submissions take the assessments prepared from there.
 * Failed: the death is recorded, the round beside the drive is voided and a fresh one opens at the
 * stop the rover retries from. Without a preparation for this drive nothing is settled; the next
 * tick prepares again.
 */
async function settle(
  tx: DB,
  context: TickContext,
  driving: Segment,
  prepared: PreparedSettlement | null,
): Promise<Pick<TickResult, 'settled' | 'opened'>> {
  const { store, mission, now } = context
  const outcome = driving.outcome!
  const from = await getStop(tx, driving.fromStopId)
  const { x, y, headingRad } = outcome.endPose

  if (outcome.kind === 'failed') {
    const beside = await getOpenRound(tx, mission.id)
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

  if (prepared?.segmentId !== driving.id) return { settled: null, opened: null }
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

  const beside = await getOpenRound(tx, mission.id)
  if (beside) {
    const short = outcome.kind === 'stopped-short'
    const anchor = short ? { x, y } : { x: beside.anchorX, y: beside.anchorY }
    if (short) await applyAssessments(tx, beside, prepared.assessments)
    await reanchorRound(tx, beside.id, { fromStopId: reached.id, anchor })
  }
  // Blobs last: a failure above publishes nothing, and the rows commit only after the blobs they
  // name exist.
  const { disk, mask } = prepared
  await publishStop(store, { world, disk, mask, missionId: mission.id, stopIndex: index })
  await settleSegment(tx, driving.id, { status: outcome.kind, toStopId: reached.id, now })
  await setCurrentStop(tx, mission.id, reached.id)
  return { settled: { segmentId: driving.id, status: outcome.kind }, opened: null }
}

/**
 * The round's open submissions, locked, take their prepared assessments: one that now breaks a
 * rule or is judged infeasible is rejected as invalidated by the stop, the others keep their
 * place with the new plan's metrics, summary and judgment; the goal itself is kept as submitted.
 * One withdrawn since the snapshot is no longer open and is left alone. One submitted since was
 * planned from the anchor the round is leaving and has no assessment: it is rejected too, and
 * its author may submit again from the stop reached.
 */
async function applyAssessments(
  tx: DB,
  round: Round,
  assessments: Map<string, Assessment>,
): Promise<void> {
  for (const submission of await lockOpenSubmissions(tx, round.id)) {
    const assessed = assessments.get(submission.id)
    if (assessed?.ok) await reviseSubmission(tx, submission.id, assessed.assessment)
    if (!assessed?.ok || assessed.assessment.judgment.verdict === 'reject') {
      await rejectSubmission(tx, submission.id, { reason: 'invalidated-by-stop' })
    }
  }
}

/**
 * Closes the open round once due (null while it is not), with the round locked before its standings are read, so a like
 * or a submission either lands before the close and counts or waits and finds the round closed.
 * Candidates are tried best ranked first: one whose drive cannot be computed from the stop (a
 * typed planning or driving error) is rejected as invalidated by the stop and the next is tried.
 * The first that drives wins and starts; with none left the round is voided and a fresh one opens
 * from the same stop.
 */
async function closeIfDue(
  tx: DB,
  context: TickContext,
  open: Round,
): Promise<Pick<TickResult, 'closed' | 'started' | 'opened'> | null> {
  const { store, mission, now } = context
  const { rules } = mission.config
  const round = await lockOpenRound(tx, open.id)
  const { submissions, closesAt } = await roundStanding(tx, round, { rules, now })
  if (!closesAt || closesAt.getTime() > now.getTime()) return null

  const world = missionWorld(mission)
  // The round closes only once the drive beside it has settled, so the rover is at its stop.
  const from = await getStop(tx, round.fromStopId)
  const disk = stopDisk(world, from)
  const revealed = await loadRevealedMask(store, from)
  for (const candidate of rankSubmissions(submissions, { rules })) {
    let record: SegmentRecord
    try {
      ;({ record } = driveSegment(world, {
        disk,
        revealed,
        start: { x: from.x, y: from.y, headingRad: from.headingRad },
        goal: { x: candidate.goalX, y: candidate.goalY },
      }))
    } catch (error) {
      if (!isDriveRefusal(error)) throw error
      await rejectSubmission(tx, candidate.id, { reason: 'invalidated-by-stop' })
      continue
    }
    await closeRound(tx, round.id, { winnerSubmissionId: candidate.id, closesAt })
    return {
      closed: { roundId: round.id, winnerSubmissionId: candidate.id },
      ...(await start(tx, context, { round, from, winner: candidate, record })),
    }
  }

  await voidRound(tx, round.id, { closesAt })
  const fresh = await openRound(tx, {
    missionId: mission.id,
    fromStopId: from.id,
    anchor: from,
    opensAt: now,
  })
  return { closed: null, started: null, opened: { roundId: fresh.id } }
}

/** A typed error from planning or driving a goal: the goal cannot be driven, the tick goes on. */
function isDriveRefusal(error: unknown): boolean {
  return error instanceof DriveError || error instanceof NavError || error instanceof TerrainError
}

/** Publishes the winner's drive, starts its segment and opens the next round beside it. */
async function start(
  tx: DB,
  context: TickContext,
  options: { round: Round; from: Stop; winner: ListedSubmission; record: SegmentRecord },
): Promise<Pick<TickResult, 'started' | 'opened'>> {
  const { store, mission, now } = context
  const { round, from, winner, record } = options
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
