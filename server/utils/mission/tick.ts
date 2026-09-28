import { sql } from 'drizzle-orm'
import type { DB } from '../../database/db'
import { DbError, postgresErrorOf } from '../../database/errors'
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
import { primeStop } from '../journey/prime'
import { contentSegmentId, encodeSegment, publishSegment, publishStop } from '../journey/publish'
import type { EncodedSegment } from '../journey/publish'
import type { JourneyStore } from '../journey/store'
import type { SegmentRecord } from '#shared/utils/drive'
import { DEFAULT_SLICE_SECONDS, driveSegment, DriveError } from '#shared/utils/drive'
import {
  backstopSlice,
  rankSubmissions,
  shouldResetToPreviousStop,
  truncateRecord,
} from '#shared/utils/mission'
import { NavError } from '#shared/utils/nav'
import {
  computeStopDisk,
  revealDisk,
  revealedKey,
  revealedOverDisk,
  revealVertices,
  stopManifestKey,
  TerrainError,
} from '#shared/utils/terrain'
import { failIfNotMoving } from './not-moving'
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
  /**
   * Why a step that was due was left to the next tick: `busy` when a tick that does not wait
   * found the mission lock held, `changed` when the mission moved between the preparation and
   * the lock. The state served is the one committed so far.
   */
  skipped?: 'busy' | 'changed'
}

/**
 * How a tick takes the mission lock. `wait`: queues behind the tick holding it, for at most
 * {@link LOCK_TIMEOUT}, then fails as {@link DbError} `BUSY`. `try`: never waits; when the lock
 * or a row it needs is held, nothing is applied and the tick answers `skipped: 'busy'`.
 */
export type MissionLock = 'wait' | 'try'

/** Postgres `lock_timeout` inside a tick's transaction. */
const LOCK_TIMEOUT = '8s'
/** Postgres `statement_timeout` inside a tick's transaction: a stuck query fails with its code. */
const STATEMENT_TIMEOUT = '15s'
/** SQLSTATE `lock_not_available`: a lock wait passed `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03'

/** What a tick is given beyond the mission: its store, Jev and lock mode. */
interface TickOptions {
  store: JourneyStore
  jev: JevClient
  missionId: string
  now: Date
  lock?: MissionLock
}

/** The step names a tick logs, in the order they can happen. */
type TickStep =
  | 'settle-prepare'
  | 'settle-publish'
  | 'settle-apply'
  | 'close-plan'
  | 'close-simulate'
  | 'close-publish'
  | 'close-apply'
  | 'busy'
  | 'changed'

/**
 * Logs a tick's progress, one line per step with the milliseconds since the previous line, so a
 * run killed at the platform's execution limit shows the last step it finished.
 */
class TickRun {
  private readonly began: number
  private mark: number
  constructor(private readonly missionId: string) {
    this.began = this.mark = Date.now()
  }

  step(name: TickStep): void {
    const now = Date.now()
    console.log(`[mission] tick ${this.missionId} ${name} ${Math.round(now - this.mark)}ms`)
    this.mark = now
  }

  end(outcome: 'done' | 'failed'): void {
    const line = `[mission] tick ${this.missionId} ${outcome} ${Math.round(Date.now() - this.began)}ms`
    if (outcome === 'done') console.log(line)
    else console.error(line)
  }
}

interface TickContext {
  store: JourneyStore
  mission: Mission
  now: Date
  /** Index of the stop the tick settled, set once it is; primed after the commit. */
  published?: number
}

type Assessment = Awaited<ReturnType<typeof assessGoal>>

/**
 * What a settlement did before it took the lock: the stop reached, published under the index it
 * takes (its disk, and the mask with the drive's reveals and the new viewshed), and after a stop
 * short each open submission of the round beside it planned and judged again from there, keyed by
 * submission id.
 */
interface PreparedSettlement {
  segmentId: string
  stopIndex: number
  assessments: Map<string, Assessment>
}

/**
 * Everything closing a due round computes before it takes the lock: the round and the stop it
 * leaves from, the candidates whose drive cannot be computed from there (ranked ahead of the
 * winner), and the winner's drive, published under the id its content names within the round;
 * no winner when none drives.
 */
interface PreparedClose {
  roundId: string
  fromStopId: string
  refused: Set<string>
  winner: { submissionId: string; drive: PublishedDrive } | null
}

/** A winner's drive as published: the segment row names these. */
interface PublishedDrive {
  segmentId: string
  endsAt: Date
  manifestKey: string
  outcome: SegmentRecord['outcome']
}

/**
 * Brings a mission up to `now`, idempotently: it (0) fails the playing drive as not moving once
 * the flags and its released playback say so (see `failIfNotMoving`), which only moves its
 * private end closer, (1) settles the drive whose end has passed, which creates the stop it
 * reached or voids the round beside a failure, (2) closes the open round once its close time has
 * passed on the best ranked submission whose drive can be computed, starts that drive and opens
 * the next round from the same stop, anchored on the winner's goal, and (3) records when the
 * next tick has something to do. A settlement and the close it makes due run as two passes, the
 * close planned from the stop the settlement committed. Safe to call from every request; a
 * second call at the same `now` changes nothing. A stop settled by the tick is primed in the CDN
 * once its transaction commits, without waiting for it (see `primeStop`).
 *
 * Only rows are written under the per-mission lock. Everything slow happens before it: Jev
 * re-judgments, planning and simulating the winner, and every blob of the stop reached and of the
 * winner's drive. Blobs are immutable and keyed by mission, stop and segment, so writing them
 * first is safe: a row never names a blob that is not there, and a blob no row names is never
 * served. Under the lock the tick checks that the mission is still where the preparation found
 * it; otherwise it applies nothing (`skipped: 'changed'`) and the next tick prepares again.
 * Every step is logged with its duration (see {@link TickRun}).
 */
export async function tickMission(db: DB, options: TickOptions): Promise<TickResult> {
  const run = new TickRun(options.missionId)
  const result: TickResult = { settled: null, closed: null, started: null, opened: null }
  try {
    for (let pass = 0; pass < 2; pass++) {
      const step = await tickPass(db, options, run)
      result.settled ??= step.settled
      result.closed ??= step.closed
      result.started ??= step.started
      result.opened = step.opened ?? result.opened
      if (step.skipped) result.skipped = step.skipped
      // Only a settlement can make a close due within the same tick.
      if (!step.settled || step.skipped) break
    }
  } catch (error) {
    run.end('failed')
    throw error
  }
  run.end('done')
  return result
}

/** One preparation, then one transaction under the mission lock applying it. */
async function tickPass(db: DB, options: TickOptions, run: TickRun): Promise<TickResult> {
  const { store, jev, missionId, now, lock = 'wait' } = options
  const idle: TickResult = { settled: null, closed: null, started: null, opened: null }
  const snapshot = await getMission(db, missionId)
  if (snapshot.status !== 'active') return idle
  const moving = await getDrivingSegment(db, missionId)
  const settlement = moving
    ? await prepareSettlement(db, { store, jev, mission: snapshot, driving: moving, now, run })
    : null
  const closing = moving ? null : await prepareClose(db, { store, mission: snapshot, now, run })

  let published: number | undefined
  const ticked = await underMissionLock(db, { missionId, lock }, async (tx) => {
    const result: TickResult = { ...idle }
    const mission = await getMission(tx, missionId)
    if (mission.status !== 'active') return result
    const context: TickContext = { store, mission, now }

    let driving = await getDrivingSegment(tx, missionId)
    // A drive failed as not moving ends at its next slice; that stays private until then.
    if (driving) {
      const beside = await getOpenRound(tx, missionId)
      const ended = await failIfNotMoving(tx, {
        store,
        driving,
        roundId: beside?.id ?? null,
        rules: mission.config.rules,
        now,
      })
      if (ended) driving = await getSegment(tx, driving.id)
    }
    // A null outcome means a producer outside the request still runs; it settles once written.
    if (driving?.outcome && driving.endsAt.getTime() <= now.getTime()) {
      Object.assign(result, await settle(tx, context, driving, settlement))
    }
    // The open round's segment starts where the drive beside it ends, so it waits for settlement.
    const open = driving ? undefined : await getOpenRound(tx, missionId)
    if (open) Object.assign(result, await closeIfDue(tx, context, open, closing))
    await recordNextDue(tx, mission, now)
    published = context.published
    return result
  })
  if (ticked === 'busy') {
    run.step('busy')
    return { ...idle, skipped: 'busy' }
  }
  run.step(moving ? 'settle-apply' : 'close-apply')
  if (ticked.skipped === 'changed') run.step('changed')
  if (published !== undefined) void primeStop(missionId, published)
  return ticked
}

/**
 * Runs `apply` in a transaction holding the mission's advisory lock, with every lock wait inside
 * bounded by {@link LOCK_TIMEOUT} and every statement by {@link STATEMENT_TIMEOUT}. `busy` when
 * `lock` is `try` and a lock was held.
 */
async function underMissionLock<T>(
  db: DB,
  options: { missionId: string; lock: MissionLock },
  apply: (tx: DB) => Promise<T>,
): Promise<T | 'busy'> {
  const { missionId, lock } = options
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = '${LOCK_TIMEOUT}'`))
      await tx.execute(sql.raw(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`))
      // A function killed mid-transaction leaves its session holding the lock; the database ends it.
      await tx.execute(
        sql.raw(`set local idle_in_transaction_session_timeout = '${STATEMENT_TIMEOUT}'`),
      )
      if (lock === 'wait') {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${missionId}))`)
      } else {
        const { rows } = (await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtext(${missionId})) as locked`,
        )) as { rows: { locked: boolean }[] }
        if (!rows[0]?.locked) return 'busy' as const
      }
      return apply(tx)
    })
  } catch (error) {
    if (postgresErrorOf(error)?.code !== LOCK_NOT_AVAILABLE) throw error
    if (lock === 'try') return 'busy'
    throw new DbError(
      'BUSY',
      `Mission ${missionId} is being brought up to date by another request; retry shortly.`,
      { cause: error },
    )
  }
}

/**
 * The settlement of `driving` due at `now`, computed and published without a transaction or a
 * lock: null when the drive is not due or it failed (a failure only records the death). The stop
 * reached is published under the index it takes once created. The snapshot may be overtaken
 * before the lock is taken; {@link settle} reconciles it.
 */
async function prepareSettlement(
  db: DB,
  options: {
    store: JourneyStore
    jev: JevClient
    mission: Mission
    driving: Segment
    now: Date
    run: TickRun
  },
): Promise<PreparedSettlement | null> {
  const { store, jev, mission, driving, now, run } = options
  const outcome = driving.outcome
  if (!outcome || driving.endsAt.getTime() > now.getTime()) return null
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

  const beside = await getOpenRound(db, mission.id)
  if (beside && outcome.kind === 'stopped-short') {
    const ground = { world, disk, revealed: revealedOverDisk(mask, disk), start: { x, y } }
    const deaths = await listDeaths(db, mission.id)
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
  const stopIndex = await nextStopIndex(db, mission.id)
  run.step('settle-prepare')
  await publishStop(store, { world, disk, mask, missionId: mission.id, stopIndex })
  run.step('settle-publish')
  return { segmentId: driving.id, stopIndex, assessments }
}

/**
 * Makes a released drive's ending public. Arrived or stopped short: the stop reached, already
 * published, is created with the mask as of the drive's start, what the drive revealed and the
 * viewshed from the new stop, and the round beside the drive moves to it; after a stop short its
 * anchor moves there too and its open submissions take the assessments prepared from there.
 * Failed: the death is recorded, the round beside the drive is voided and a fresh one opens at the
 * stop the rover retries from. Without a preparation for this drive and this stop index nothing
 * is settled; the next tick prepares again.
 */
async function settle(
  tx: DB,
  context: TickContext,
  driving: Segment,
  prepared: PreparedSettlement | null,
): Promise<Pick<TickResult, 'settled' | 'opened' | 'skipped'>> {
  const { mission, now } = context
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

  const index = await nextStopIndex(tx, mission.id)
  if (prepared?.segmentId !== driving.id || prepared.stopIndex !== index) {
    return { settled: null, opened: null, skipped: 'changed' }
  }
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
  context.published = index
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
 * The close of the mission's open round due at `now`, computed and published without a
 * transaction or a lock: null when no round is open or it is not due. Candidates are tried best
 * ranked first: one whose drive cannot be computed from the stop (a typed planning or driving
 * error) is set aside and the next is tried; the first that drives is the winner, its drive
 * published. {@link closeIfDue} reconciles it with the round as it stands under the lock.
 */
async function prepareClose(
  db: DB,
  options: { store: JourneyStore; mission: Mission; now: Date; run: TickRun },
): Promise<PreparedClose | null> {
  const { store, mission, now, run } = options
  const { rules } = mission.config
  const open = await getOpenRound(db, mission.id)
  if (!open) return null
  const { submissions, closesAt, drivingAuthorId } = await roundStanding(db, open, { rules, now })
  if (!closesAt || closesAt.getTime() > now.getTime()) return null

  const world = missionWorld(mission)
  // The round closes only once the drive beside it has settled, so the rover is at its stop.
  const from = await getStop(db, open.fromStopId)
  const disk = stopDisk(world, from)
  const revealed = await loadRevealedMask(store, from)
  const refused = new Set<string>()
  run.step('close-plan')
  for (const candidate of rankSubmissions(submissions, { rules, drivingAuthorId })) {
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
      refused.add(candidate.id)
      continue
    }
    const drive = await prepareDrive(record, { mission, roundId: open.id })
    run.step('close-simulate')
    const published = await publishDrive(store, { drive, now })
    run.step('close-publish')
    return {
      roundId: open.id,
      fromStopId: from.id,
      refused,
      winner: { submissionId: candidate.id, drive: published },
    }
  }
  run.step('close-simulate')
  return { roundId: open.id, fromStopId: from.id, refused, winner: null }
}

/**
 * Closes the open round once due (null while it is not) as prepared, with the round locked
 * before its standings are read, so a like or a submission either lands before the close and
 * counts or waits and finds the round closed. The candidates ranked ahead of the prepared winner
 * must be exactly those set aside: they are rejected as invalidated by the stop and the winner
 * starts; with no winner the round is voided and a fresh one opens from the same stop. A round
 * ranked otherwise since, or not the one prepared for, is left for the next tick.
 */
async function closeIfDue(
  tx: DB,
  context: TickContext,
  open: Round,
  prepared: PreparedClose | null,
): Promise<Pick<TickResult, 'closed' | 'started' | 'opened' | 'skipped'> | null> {
  const { mission, now } = context
  const { rules } = mission.config
  const round = await lockOpenRound(tx, open.id)
  const { submissions, closesAt, drivingAuthorId } = await roundStanding(tx, round, { rules, now })
  if (!closesAt || closesAt.getTime() > now.getTime()) return null
  const changed = { closed: null, started: null, opened: null, skipped: 'changed' } as const
  if (prepared?.roundId !== round.id || prepared.fromStopId !== round.fromStopId) return changed
  const ranked = rankSubmissions(submissions, { rules, drivingAuthorId })
  const first = ranked.findIndex((candidate) => !prepared.refused.has(candidate.id))
  const winner = first === -1 ? undefined : ranked[first]
  if (winner?.id !== prepared.winner?.submissionId) return changed

  for (const refused of first === -1 ? ranked : ranked.slice(0, first)) {
    await rejectSubmission(tx, refused.id, { reason: 'invalidated-by-stop' })
  }
  if (winner && prepared.winner) {
    await closeRound(tx, round.id, { winnerSubmissionId: winner.id, closesAt })
    return {
      closed: { roundId: round.id, winnerSubmissionId: winner.id },
      ...(await start(tx, context, { round, winner, drive: prepared.winner.drive })),
    }
  }

  await voidRound(tx, round.id, { closesAt })
  const fresh = await openRound(tx, {
    missionId: mission.id,
    fromStopId: round.fromStopId,
    anchor: await getStop(tx, round.fromStopId),
    opensAt: now,
  })
  return { closed: null, started: null, opened: { roundId: fresh.id } }
}

/** A typed error from planning or driving a goal: the goal cannot be driven, the tick goes on. */
function isDriveRefusal(error: unknown): boolean {
  return error instanceof DriveError || error instanceof NavError || error instanceof TerrainError
}

/** A winner's drive encoded under the id its content names, not yet published. */
interface PreparedDrive {
  segmentId: string
  segment: EncodedSegment
  outcome: SegmentRecord['outcome']
}

/**
 * The winner's drive of round `roundId`, cut where the record shows no progress over the
 * not-moving backstop, encoded and named by its content within the round.
 */
async function prepareDrive(
  driven: SegmentRecord,
  options: { mission: Mission; roundId: string },
): Promise<PreparedDrive> {
  const { mission, roundId } = options
  // The backstop is a pure function of the record, so a drive that would stall is cut here, as
  // it would be failed at the release that shows no progress over the backstop.
  const stall = backstopSlice(driven, {
    sliceSeconds: DEFAULT_SLICE_SECONDS,
    rules: mission.config.rules,
  })
  const record =
    stall === null
      ? driven
      : truncateRecord(driven, {
          sliceIndex: stall,
          sliceSeconds: DEFAULT_SLICE_SECONDS,
          reason: 'no-progress',
        })
  const segment = encodeSegment(record)
  // A drive is a seeded, pure function of the world, the stop and the goal, so a close prepared
  // again after a run cut short encodes the same bytes under the same id, and publishing resumes
  // where that run stopped instead of starting over.
  const segmentId = await contentSegmentId(segment, roundId)
  return { segmentId, segment, outcome: record.outcome }
}

/** Publishes a prepared drive starting at `now`. */
async function publishDrive(
  store: JourneyStore,
  options: { drive: PreparedDrive; now: Date },
): Promise<PublishedDrive> {
  const { drive, now } = options
  const published = await publishSegment(store, {
    segment: drive.segment,
    segmentId: drive.segmentId,
    startedAt: now.getTime(),
  })
  return {
    segmentId: drive.segmentId,
    endsAt: new Date(published.endsAt),
    manifestKey: published.manifestKey,
    outcome: drive.outcome,
  }
}

/** Starts the winner's published drive and opens the next round beside it. */
async function start(
  tx: DB,
  context: TickContext,
  options: { round: Round; winner: ListedSubmission; drive: PublishedDrive },
): Promise<Pick<TickResult, 'started' | 'opened'>> {
  const { mission, now } = context
  const { round, winner, drive } = options
  const segment = await createSegment(tx, {
    id: drive.segmentId,
    missionId: mission.id,
    roundId: round.id,
    submissionId: winner.id,
    fromStopId: round.fromStopId,
    startedAt: now,
    endsAt: drive.endsAt,
    manifestKey: drive.manifestKey,
    outcome: drive.outcome,
  })
  const next = await openRound(tx, {
    missionId: mission.id,
    fromStopId: round.fromStopId,
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
