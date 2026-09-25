import { sql } from 'drizzle-orm'
import { uuidv7 } from 'unsecure/uuid'
import type { DB } from '../../database/db'
import type { Mission, Round, Segment, SegmentStatus, Stop } from '../../database/schema'
import { getMission, setCurrentStop } from '../../repositories/missions'
import { closeRound, findUnresolvedRound, getOpenRound, openRound } from '../../repositories/rounds'
import {
  createSegment,
  getDrivingSegment,
  getSegment,
  listDeaths,
  settleSegment,
} from '../../repositories/segments'
import { createStop, getStop, getStopReachedBy, nextStopIndex } from '../../repositories/stops'
import { getSubmission } from '../../repositories/submissions'
import { publishSegment, publishStop } from '../journey/publish'
import type { JourneyStore } from '../journey/store'
import { driveSegment } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import { rankSubmissions, shouldResetToPreviousStop } from '#shared/utils/mission'
import { revealDisk, revealedKey, revealVertices, stopManifestKey } from '#shared/utils/terrain'
import { roundStanding } from './round'
import { loadRevealedMask, missionWorld, stopDisk } from './terrain'

/**
 * What one tick changed, in the order it happened. Public: nothing here names where a drive ends
 * or the stop the next round starts from before the drive is released.
 */
export interface TickResult {
  /** A drive whose end passed, made public. */
  settled: { segmentId: string; status: Exclude<SegmentStatus, 'driving'> } | null
  closed: { roundId: string; winnerSubmissionId: string } | null
  /** The winner's drive, computed in full and released from now on. */
  started: { segmentId: string; startedAt: Date } | null
  opened: { roundId: string } | null
}

/**
 * Brings a mission up to `now`, idempotently: under a per-mission lock it (1) settles the drive
 * whose end has passed, (2) closes the open round once its close time has passed, and (3)
 * resolves a closed round without a segment: drives the winner over the true terrain, publishes
 * the drive (and the stop it reaches), and opens the next round from where the rover will be.
 * Safe to call from every request; a second call at the same `now` changes nothing.
 */
export async function tickMission(
  db: DB,
  options: { store: JourneyStore; missionId: string; now: Date },
): Promise<TickResult> {
  const { store, missionId, now } = options
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${missionId}))`)
    const result: TickResult = { settled: null, closed: null, started: null, opened: null }
    const mission = await getMission(tx, missionId)
    if (mission.status !== 'active') return result

    const driving = await getDrivingSegment(tx, missionId)
    // A null outcome means a producer outside the request still runs; it settles once written.
    if (driving?.outcome && driving.endsAt.getTime() <= now.getTime()) {
      result.settled = await settle(tx, mission, driving, now)
    }

    const open = await getOpenRound(tx, missionId)
    if (open) result.closed = await closeIfDue(tx, mission, open, now)

    const unresolved = await findUnresolvedRound(tx, missionId)
    if (unresolved) {
      const { started, opened } = await resolve(tx, { store, mission, round: unresolved, now })
      result.started = started
      result.opened = opened
    }
    return result
  })
}

async function settle(
  tx: DB,
  mission: Mission,
  driving: Segment,
  now: Date,
): Promise<NonNullable<TickResult['settled']>> {
  const outcome = driving.outcome!
  if (outcome.kind === 'failed') {
    const { x, y } = outcome.endPose
    await settleSegment(tx, driving.id, { status: 'failed', death: { x, y }, now })
    const retry = await retryStop(tx, mission, await getStop(tx, driving.fromStopId))
    await setCurrentStop(tx, mission.id, retry)
    return { segmentId: driving.id, status: 'failed' }
  }
  const reached = await getStopReachedBy(tx, driving.id)
  if (!reached) {
    throw new Error(
      `Segment ${driving.id} ${outcome.kind} but no stop names it as its origin; the tick that started it creates that stop, so the data was changed outside the lifecycle.`,
    )
  }
  await settleSegment(tx, driving.id, { status: outcome.kind, toStopId: reached.id, now })
  await setCurrentStop(tx, mission.id, reached.id)
  return { segmentId: driving.id, status: outcome.kind }
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

async function resolve(
  tx: DB,
  options: { store: JourneyStore; mission: Mission; round: Round; now: Date },
): Promise<Pick<TickResult, 'started' | 'opened'>> {
  const { store, mission, round, now } = options
  const winner = await getSubmission(tx, round.winnerSubmissionId!)
  const from = await getStop(tx, round.fromStopId)
  const world = missionWorld(mission)
  const disk = stopDisk(world, from)
  const mask = await loadRevealedMask(store, from)
  const { record } = driveSegment(world, {
    disk,
    revealed: mask,
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

  let nextFrom: string
  const { outcome } = record
  if (outcome.kind === 'failed') {
    nextFrom = await retryStop(tx, mission, from, outcome.endPose)
  } else {
    const index = await nextStopIndex(tx, mission.id)
    const { x, y, headingRad } = outcome.endPose
    const reached = await createStop(tx, {
      missionId: mission.id,
      index,
      x,
      y,
      headingRad,
      manifestKey: stopManifestKey(mission.worldHash, index),
      revealedKey: revealedKey(mission.worldHash, index),
      fromSegmentId: segment.id,
    })
    const reachedDisk = stopDisk(world, reached)
    const seen = revealDisk(
      revealVertices(
        mask,
        disk,
        record.reveals.flatMap((reveal) => Array.from(reveal.vertices)),
      ),
      reachedDisk,
    )
    await publishStop(store, { world, disk: reachedDisk, mask: seen, stopIndex: index })
    nextFrom = reached.id
  }

  const next = await openRound(tx, { missionId: mission.id, fromStopId: nextFrom, opensAt: now })
  return {
    started: { segmentId: segment.id, startedAt: segment.startedAt },
    opened: { roundId: next.id },
  }
}

/**
 * Where the rover retries after failures from `from`: the same stop, or the stop before it once
 * `rules.failureZone.strikes` of the deaths from `from` cluster. `pending` is a failure not
 * settled yet, counted as if it were.
 */
async function retryStop(
  tx: DB,
  mission: Mission,
  from: Stop,
  pending?: MapPoint,
): Promise<string> {
  if (!from.fromSegmentId) return from.id
  const deaths: MapPoint[] = await listDeaths(tx, mission.id, { fromStopId: from.id })
  if (pending) deaths.push(pending)
  if (!shouldResetToPreviousStop(deaths, { rules: mission.config.rules })) return from.id
  return (await getSegment(tx, from.fromSegmentId)).fromStopId
}
