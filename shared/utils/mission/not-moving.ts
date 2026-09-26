import type { KeyframeBlock } from '../drive/keyframes'
import { interpolatePose, KEYFRAME_STRIDE } from '../drive/keyframes'
import type { DriveEvent, DriveOutcome, SegmentRecord } from '../drive/segment'
import type { SegmentSlice } from '../drive/slices'
import { MissionError } from './errors'
import type { MissionRules } from './rules'

/**
 * Why a playing drive was failed as not moving. `flagged-not-moving`: viewers' flags reached the
 * quorum and the playback showed no progress over their window. `no-progress`: the record itself
 * showed no progress over the backstop, whatever the flags. Closed set.
 */
export type NotMovingReason = 'flagged-not-moving' | 'no-progress'

/** Flags needed to fail a drive with `active` users in the round: half of them, within bounds. */
export function notMovingQuorum(active: number, options: { rules: MissionRules }): number {
  const { quorumMin, quorumMax } = options.rules.notMoving
  return Math.min(quorumMax, Math.max(quorumMin, Math.ceil(active / 2)))
}

/**
 * Planar displacement, metres, from the pose `windowS` before the last frame (interpolated) to
 * the last frame; null while the frames do not reach back a whole window.
 */
export function progressOverWindow(
  keyframes: KeyframeBlock,
  options: { windowS: number },
): number | null {
  const { count, data } = keyframes
  if (count === 0) return null
  const last = (count - 1) * KEYFRAME_STRIDE
  const from = data[last]! - options.windowS
  if (from < data[0]!) return null
  const pose = interpolatePose(keyframes, from)
  return Math.hypot(data[last + 1]! - pose[1]!, data[last + 2]! - pose[2]!)
}

/**
 * The first slice count `n` at whose release (slices `0 … n − 1` out, the drive still playing)
 * the released frames show under `rules.notMoving.progressM` over `backstopMs`; null when that
 * never happens before the record's last slice is released. A pure function of the record, so
 * the backstop is known when the drive is computed.
 */
export function backstopSlice(
  record: Pick<SegmentRecord, 'keyframes' | 'events' | 'reveals' | 'outcome'>,
  options: { sliceSeconds: number; rules: MissionRules },
): number | null {
  const { sliceSeconds, rules } = options
  const { keyframes, events, reveals, outcome } = record
  const { count, data } = keyframes
  // The last slice as `sliceRecord` cuts it: the one holding the last frame, event or reveal.
  const times = [outcome.durationS, events.at(-1)?.t ?? 0, reveals.at(-1)?.t ?? 0]
  if (count > 0) times.push(data[(count - 1) * KEYFRAME_STRIDE]!)
  const lastSlice = Math.max(0, Math.floor(Math.max(...times) / sliceSeconds))
  const windowS = rules.notMoving.backstopMs / 1000
  let frames = 0
  for (let n = 1; n <= lastSlice; n++) {
    while (frames < count && data[frames * KEYFRAME_STRIDE]! < n * sliceSeconds) frames++
    const progress = progressOverWindow(prefix(keyframes, frames), { windowS })
    if (progress !== null && progress < rules.notMoving.progressM) return n
  }
  return null
}

/**
 * The slice that ends a drive failed as not moving once slices `0 … sliceIndex − 1` are out,
 * `released` being their frames: the rover stands where the last of them left it, one frame at
 * the slice's start with no speed, a `stuck` event, and the failure. Its ground distance is the
 * sum of the released frames' steps.
 */
export function stallEnding(
  released: KeyframeBlock,
  options: { sliceIndex: number; sliceSeconds: number; reason: NotMovingReason },
): SegmentSlice & { outcome: DriveOutcome } {
  const { sliceIndex, sliceSeconds, reason } = options
  const { count, data } = released
  if (count === 0) {
    throw new MissionError(
      'INVALID_INPUT',
      `stallEnding: no frame is released before slice ${sliceIndex}; a drive fails as not moving only once it has played.`,
    )
  }
  const S = KEYFRAME_STRIDE
  const last = data.slice((count - 1) * S, count * S)
  const t = sliceIndex * sliceSeconds
  last[0] = t
  last[8] = 0
  let distanceM = 0
  for (let k = 1; k < count; k++) {
    const a = (k - 1) * S
    const b = k * S
    distanceM += Math.hypot(
      data[b + 1]! - data[a + 1]!,
      data[b + 2]! - data[a + 2]!,
      data[b + 3]! - data[a + 3]!,
    )
  }
  const x = last[1]!
  const y = last[2]!
  const [qx, qy, qz, qw] = [last[4]!, last[5]!, last[6]!, last[7]!]
  const headingRad = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz))
  const reasons = [reason]
  const stuck: DriveEvent = { t, type: 'stuck', x, y, details: { reasons } }
  return {
    index: sliceIndex,
    keyframes: last,
    events: [stuck],
    reveals: [],
    outcome: { kind: 'failed', reasons, distanceM, durationS: t, endPose: { x, y, headingRad } },
  }
}

/**
 * The record as it would be failed as not moving at the release of slice `sliceIndex − 1`:
 * everything before slice `sliceIndex` kept as it was, then {@link stallEnding}.
 */
export function truncateRecord(
  record: SegmentRecord,
  options: { sliceIndex: number; sliceSeconds: number; reason: NotMovingReason },
): SegmentRecord {
  const cut = options.sliceIndex * options.sliceSeconds
  const { keyframes } = record
  let frames = 0
  while (frames < keyframes.count && keyframes.data[frames * KEYFRAME_STRIDE]! < cut) frames++
  const kept = prefix(keyframes, frames)
  const ending = stallEnding(kept, options)
  const data = new Float32Array((frames + 1) * KEYFRAME_STRIDE)
  data.set(kept.data)
  data.set(ending.keyframes, frames * KEYFRAME_STRIDE)
  return {
    ...record,
    keyframes: { ...keyframes, count: frames + 1, data },
    events: [...record.events.filter((e) => e.t < cut), ...ending.events],
    reveals: record.reveals.filter((r) => r.t < cut),
    outcome: ending.outcome,
  }
}

function prefix(keyframes: KeyframeBlock, count: number): KeyframeBlock {
  return { ...keyframes, count, data: keyframes.data.subarray(0, count * KEYFRAME_STRIDE) }
}
