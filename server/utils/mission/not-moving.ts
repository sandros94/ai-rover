import type { DB } from '../../database/db'
import type { Segment } from '../../database/schema'
import { DbError } from '../../database/errors'
import { countActiveUsers, countFlags, flagSegment, hasFlagged } from '../../repositories/flags'
import { endSegmentEarly, getDrivingSegment } from '../../repositories/segments'
import type { JourneyStore } from '../journey/store'
import type { KeyframeBlock, SegmentSlice } from '#shared/utils/drive'
import {
  encodeSlice,
  KEYFRAME_STRIDE,
  parseJourneyKey,
  parseStoredSegmentManifest,
  segmentSliceKey,
  sliceReleaseAt,
} from '#shared/utils/drive'
import type { MissionRules } from '#shared/utils/mission'
import { notMovingQuorum, progressOverWindow, stallEnding } from '#shared/utils/mission'
import { LifecycleError } from './errors'
import { loadSlices } from './terrain'

/**
 * Flags the mission's drive in progress as not moving on behalf of `userId`; refused for any
 * other segment. The caller ticks the mission afterwards, which fails the drive if the flag
 * completes the quorum.
 */
export async function flagNotMoving(
  db: DB,
  options: { missionId: string; segmentId: string; userId: string; now: Date },
): Promise<void> {
  const { missionId, segmentId, userId, now } = options
  const driving = await getDrivingSegment(db, missionId)
  if (driving?.id !== segmentId) {
    throw new DbError(
      'INVALID_STATE',
      `Segment ${segmentId} is not the drive in progress of mission ${missionId}; flag only that one.`,
    )
  }
  await flagSegment(db, segmentId, { userId, now })
}

/** Whether `userId` has a flag on the segment that counts at `now`. */
export async function hasNotMovingFlag(
  db: DB,
  options: { segmentId: string; userId: string; rules: MissionRules; now: Date },
): Promise<boolean> {
  const { segmentId, userId, rules, now } = options
  return hasFlagged(db, segmentId, {
    userId,
    since: new Date(now.getTime() - rules.notMoving.windowMs),
  })
}

/** Where the "rover not moving" flags on a playing drive stand at `now`. */
export async function notMovingStanding(
  db: DB,
  options: { segmentId: string; roundId: string | null; rules: MissionRules; now: Date },
): Promise<{ count: number; quorum: number }> {
  const { segmentId, roundId, rules, now } = options
  const since = new Date(now.getTime() - rules.notMoving.windowMs)
  const count = await countFlags(db, segmentId, { since })
  const active = roundId ? await countActiveUsers(db, { roundId, segmentId }) : count
  return { count, quorum: notMovingQuorum(active, { rules }) }
}

/**
 * Fails the playing drive as not moving when the flags within the window reach the quorum and
 * the slices released at `now` (`0 … n − 1`) show under `progressM` over the window: slice `n`,
 * not yet out, is rewritten to end the drive where the rover stands, every later slice is
 * deleted, and the segment now ends at slice `n`'s release with the failure, settled then like
 * any other. Nothing public changes before that release. Nothing happens when the drive already
 * ends with slice `n`, as after an earlier call. The blobs go first: a failure after them leaves
 * the row playing, and the next tick, seeing the same flags and the same released slices until
 * slice `n` is out, rewrites the same ending. True when it failed the drive.
 */
export async function failIfNotMoving(
  tx: DB,
  options: {
    store: JourneyStore
    driving: Segment
    roundId: string | null
    rules: MissionRules
    now: Date
  },
): Promise<boolean> {
  const { store, driving, roundId, rules, now } = options
  if (!driving.outcome || driving.endsAt.getTime() <= now.getTime()) return false
  const { count, quorum } = await notMovingStanding(tx, {
    segmentId: driving.id,
    roundId,
    rules,
    now,
  })
  if (count < quorum) return false

  const manifest = await store.getJson(driving.manifestKey)
  if (manifest === null) {
    throw new LifecycleError(
      'NOT_PUBLISHED',
      `Segment ${driving.id} has no manifest at "${driving.manifestKey}" in the journey store.`,
    )
  }
  const { sliceSeconds, keyframeHz } = parseStoredSegmentManifest(manifest)
  const released = Math.floor((now.getTime() - driving.startedAt.getTime()) / (sliceSeconds * 1000))
  const next = sliceReleaseAt(driving.startedAt.getTime(), released, sliceSeconds)
  // Nothing is released yet, or the drive already ends with the next slice.
  if (released === 0 || next >= driving.endsAt.getTime()) return false
  const windowS = rules.notMoving.windowMs / 1000
  // The window ends within slice n − 1, so it starts no earlier than this slice.
  const first = Math.max(0, Math.floor(((released - 1) * sliceSeconds - windowS) / sliceSeconds))
  const recent = await loadSlices(store, driving, { from: first, to: released })
  const progress = progressOverWindow(framesOf(recent, keyframeHz), { windowS })
  if (progress === null || progress >= rules.notMoving.progressM) return false

  const earlier = await loadSlices(store, driving, { from: 0, to: first })
  const ending = stallEnding(framesOf([...earlier, ...recent], keyframeHz), {
    sliceIndex: released,
    sliceSeconds,
    reason: 'flagged-not-moving',
  })
  await store.putImmutable(segmentSliceKey(driving.id, released), encodeSlice(ending), {
    contentType: 'application/octet-stream',
  })
  for (const key of await store.listKeys(`segments/${driving.id}/`)) {
    const parsed = parseJourneyKey(key)
    if (parsed?.kind === 'segment-slice' && parsed.index > released) await store.delete(key)
  }
  await endSegmentEarly(tx, driving.id, {
    endsAt: new Date(next),
    outcome: ending.outcome,
    now,
  })
  return true
}

/** The keyframes of consecutive slices as one block. */
function framesOf(slices: readonly SegmentSlice[], hz: number): KeyframeBlock {
  const data = new Float32Array(slices.reduce((n, s) => n + s.keyframes.length, 0))
  let offset = 0
  for (const slice of slices) {
    data.set(slice.keyframes, offset)
    offset += slice.keyframes.length
  }
  return { hz, stride: KEYFRAME_STRIDE, count: data.length / KEYFRAME_STRIDE, data }
}
