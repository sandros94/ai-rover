import { describe, expect, it } from 'vitest'
import type { KeyframeBlock, SegmentSlice } from '#shared/utils/drive'
import { KEYFRAME_STRIDE, sliceRecord } from '#shared/utils/drive'
import {
  backstopSlice,
  DEFAULT_MISSION_RULES,
  notMovingQuorum,
  progressOverWindow,
  stallEnding,
  truncateRecord,
} from '#shared/utils/mission'
import { syntheticRecord } from './helpers'

const rules = DEFAULT_MISSION_RULES
const S = 30

/** The keyframes of `slices` back to back, as a block. */
function framesOf(slices: readonly SegmentSlice[], hz = 2): KeyframeBlock {
  const data = new Float32Array(slices.reduce((n, s) => n + s.keyframes.length, 0))
  let offset = 0
  for (const slice of slices) {
    data.set(slice.keyframes, offset)
    offset += slice.keyframes.length
  }
  return { hz, stride: KEYFRAME_STRIDE, count: data.length / KEYFRAME_STRIDE, data }
}

describe('notMovingQuorum', () => {
  it('is half the active users rounded up, between the minimum and the maximum', () => {
    const quorum = (active: number) => notMovingQuorum(active, { rules })
    expect([0, 1, 2, 3, 4].map(quorum)).toEqual([2, 2, 2, 2, 2])
    expect(quorum(5)).toBe(3)
    expect(quorum(9)).toBe(5)
    expect(quorum(10)).toBe(5)
    expect(quorum(40)).toBe(5)
  })
})

describe('progressOverWindow', () => {
  const { slices } = sliceRecord(syntheticRecord({ speedMps: 0.1, stopAfterS: 1200 }))

  it('measures the displacement over the window ending at the last frame', () => {
    // Frames up to 1199.5 s: moving the whole window, 600 s at 0.1 m/s.
    expect(progressOverWindow(framesOf(slices.slice(0, 40)), { windowS: 600 })).toBeCloseTo(60, 3)
    // Frames up to 1499.5 s: moving for the first 300.5 s of the window only.
    expect(progressOverWindow(framesOf(slices.slice(0, 50)), { windowS: 600 })).toBeCloseTo(
      30.05,
      3,
    )
    // Frames up to 1799.5 s: the window starts at 1199.5 s, half a second before the rover stopped.
    expect(progressOverWindow(framesOf(slices.slice(0, 60)), { windowS: 600 })).toBeCloseTo(0.05, 3)
  })

  it('is null until the frames reach back a whole window', () => {
    expect(progressOverWindow(framesOf(slices.slice(0, 10)), { windowS: 600 })).toBeNull()
    expect(progressOverWindow(framesOf([]), { windowS: 600 })).toBeNull()
  })
})

describe('backstopSlice', () => {
  it('finds the first release at which the released frames show no progress over the backstop', () => {
    // Stopped at 1200 s; slices before 70 end at 2099.5 s, 900 s after 1199.5 s.
    const record = syntheticRecord({ stopAfterS: 1200, durationS: 3600 })
    expect(backstopSlice(record, { sliceSeconds: S, rules })).toBe(70)
  })

  it('is null when the rover keeps moving, or the drive ends before the backstop fires', () => {
    expect(backstopSlice(syntheticRecord({ stopAfterS: 3600 }), { sliceSeconds: S, rules })).toBe(
      null,
    )
    // Stopped at 1200 s but the record ends at 2000 s: the drive is over before 2099.5 s.
    expect(
      backstopSlice(syntheticRecord({ stopAfterS: 1200, durationS: 2000 }), {
        sliceSeconds: S,
        rules,
      }),
    ).toBe(null)
  })
})

describe('truncateRecord and stallEnding', () => {
  const record = syntheticRecord({ stopAfterS: 1200, durationS: 3600 })
  const original = sliceRecord(record).slices

  it('keeps every slice before the cut and ends in a failure one slice later', () => {
    const truncated = truncateRecord(record, {
      sliceIndex: 70,
      sliceSeconds: S,
      reason: 'no-progress',
    })
    const { slices } = sliceRecord(truncated)
    expect(slices).toHaveLength(71)
    expect(slices.slice(0, 70)).toEqual(original.slice(0, 70))
    const last = slices[70]!
    expect(last.outcome).toMatchObject({
      kind: 'failed',
      reasons: ['no-progress'],
      durationS: 2100,
      endPose: { x: 120, y: 0, headingRad: 0 },
    })
    expect(last.outcome!.distanceM).toBeCloseTo(120, 3)
    // The rover stands where it was: one frame at the cut, not moving.
    expect(last.keyframes).toHaveLength(KEYFRAME_STRIDE)
    expect(last.keyframes[0]).toBe(2100)
    expect(last.keyframes[1]).toBeCloseTo(120, 3)
    expect(last.keyframes[8]).toBe(0)
    expect(last.events).toEqual([
      { t: 2100, type: 'stuck', x: 120, y: 0, details: { reasons: ['no-progress'] } },
    ])
    expect(last.reveals).toEqual([])
  })

  it('builds the same final slice from the released slices alone', () => {
    const fromRecord = sliceRecord(
      truncateRecord(record, { sliceIndex: 60, sliceSeconds: S, reason: 'flagged-not-moving' }),
    ).slices[60]
    const fromReleased = stallEnding(framesOf(original.slice(0, 60)), {
      sliceIndex: 60,
      sliceSeconds: S,
      reason: 'flagged-not-moving',
    })
    expect(fromReleased).toEqual(fromRecord)
  })
})
