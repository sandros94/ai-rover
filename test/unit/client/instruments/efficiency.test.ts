import { describe, expect, it } from 'vitest'
import type { KeyframeBlock } from '#shared/utils/drive'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import { DEFAULT_ROVER_GEOMETRY, ROVER_MAX_SPEED_MPS } from '#shared/utils/rover'
import {
  createOdometer,
  driveEfficiency,
  slipOverLastMetre,
} from '#shared/utils/client/instruments/efficiency'

const R = DEFAULT_ROVER_GEOMETRY.wheelRadius
const HZ = 2

/**
 * A straight drive east along x: `steps[k]` is the frame-to-frame `[actual, commanded]` metres;
 * the middle wheels turn by commanded over the radius.
 */
function block(steps: [number, number][]): KeyframeBlock {
  const data = new Float32Array((steps.length + 1) * KEYFRAME_STRIDE)
  let x = 0
  let spin = 0
  for (let k = 0; k <= steps.length; k++) {
    if (k > 0) {
      x += steps[k - 1]![0]
      spin += steps[k - 1]![1] / R
    }
    const f = data.subarray(k * KEYFRAME_STRIDE, (k + 1) * KEYFRAME_STRIDE)
    f[KEYFRAME_FIELDS.indexOf('t')] = k / HZ
    f[KEYFRAME_FIELDS.indexOf('x')] = x
    f[KEYFRAME_FIELDS.indexOf('qw')] = 1
    for (const name of ['spinFL', 'spinFR', 'spinML', 'spinMR', 'spinRL', 'spinRR'] as const)
      f[KEYFRAME_FIELDS.indexOf(name)] = spin
  }
  return { hz: HZ, stride: KEYFRAME_STRIDE, count: steps.length + 1, data }
}

describe('createOdometer', () => {
  it('integrates ground distance and reads commanded distance from the middle wheels', () => {
    const odometer = createOdometer(block(Array.from({ length: 100 }, () => [0.02, 0.025])))
    expect(odometer.at(0)).toEqual({ actualM: 0, commandedM: 0 })
    expect(odometer.at(50).actualM).toBeCloseTo(2, 5)
    expect(odometer.at(50).commandedM).toBeCloseTo(2.5, 4)
    expect(odometer.at(10.25).actualM).toBeCloseTo(0.41, 5)
    expect(odometer.at(1e6).actualM).toBeCloseTo(2, 5)
  })

  it('cancels turns in place, whose middle wheels spin opposite', () => {
    const b = block([[0, 0]])
    const f = b.data.subarray(KEYFRAME_STRIDE)
    f[KEYFRAME_FIELDS.indexOf('spinML')] = -3
    f[KEYFRAME_FIELDS.indexOf('spinMR')] = 3
    expect(createOdometer(b).at(0.5).commandedM).toBeCloseTo(0, 12)
  })
})

describe('driveEfficiency', () => {
  it('is effective speed so far over the 4.2 cm/s commanded cap', () => {
    expect(ROVER_MAX_SPEED_MPS).toBe(0.042)
    expect(driveEfficiency({ actualM: 3.3, elapsedS: 100 })).toBeCloseTo(0.033 / 0.042, 12)
    expect(driveEfficiency({ actualM: 1, elapsedS: 10, maxSpeedMps: 0.2 })).toBeCloseTo(0.5, 12)
  })

  it('is undefined before any time has passed', () => {
    expect(driveEfficiency({ actualM: 0, elapsedS: 0 })).toBeUndefined()
  })
})

describe('slipOverLastMetre', () => {
  it('compares commanded and actual over the last metre driven', () => {
    // 2 m at no slip, then 1 m at 50 % slip.
    const steps: [number, number][] = [
      ...Array.from({ length: 100 }, () => [0.02, 0.02] as [number, number]),
      ...Array.from({ length: 50 }, () => [0.02, 0.04] as [number, number]),
    ]
    const odometer = createOdometer(block(steps))
    const last = slipOverLastMetre(odometer, 75)
    expect(last.actualM).toBeCloseTo(1, 4)
    expect(last.commandedM).toBeCloseTo(2, 4)
    expect(last.slip).toBeCloseTo(0.5, 4)
    const early = slipOverLastMetre(odometer, 25)
    expect(early.slip).toBeCloseTo(0, 4)
  })

  it('uses what was driven when less than a metre', () => {
    const odometer = createOdometer(block([[0.1, 0.2]]))
    const last = slipOverLastMetre(odometer, 0.5)
    expect(last.actualM).toBeCloseTo(0.1, 6)
    expect(last.slip).toBeCloseTo(0.5, 5)
  })

  it('reads no slip while standing', () => {
    expect(slipOverLastMetre(createOdometer(block([[0, 0]])), 0.5).slip).toBe(0)
  })
})
