import { describe, expect, it } from 'vitest'
import type { MotionLimits } from '#shared/utils/client/scene/motion-profile'
import { motionProfile } from '#shared/utils/client/scene/motion-profile'

const DEG = Math.PI / 180
const LIMITS: MotionLimits = { rate: 2 * DEG, acceleration: 2 * DEG, jerk: 4 * DEG }

/** Rate and acceleration by finite differences every `dt` seconds across the whole move. */
function sample(distance: number, limits = LIMITS, dt = 1e-3) {
  const { durationS, positionAt } = motionProfile(distance, limits)
  const steps = Math.ceil(durationS / dt)
  const at = Array.from({ length: steps + 3 }, (_, k) => positionAt((k - 1) * dt))
  const rate = at.slice(1).map((p, k) => (p - at[k]!) / dt)
  const accel = rate.slice(1).map((v, k) => (v - rate[k]!) / dt)
  return { durationS, positionAt, at, rate, accel }
}

describe('motionProfile', () => {
  const cases = [
    ['a long move, cruising at the peak rate', 90 * DEG],
    ['a move holding the peak acceleration, too short to cruise', 2 * DEG],
    ['a move too short to reach the peak acceleration', 0.1 * DEG],
  ] as const

  it.each(cases)('starts and ends at rest on its endpoints: %s', (_, distance) => {
    const { durationS, positionAt, rate } = sample(distance)
    expect(positionAt(-1)).toBe(0)
    expect(positionAt(0)).toBe(0)
    expect(positionAt(durationS)).toBe(distance)
    expect(positionAt(durationS + 1)).toBe(distance)
    expect(Math.abs(rate[1]!)).toBeLessThan(1e-6)
    expect(Math.abs(rate.at(-2)!)).toBeLessThan(1e-6)
  })

  it.each(cases)(
    'moves forward, rate and acceleration continuous and within the limits: %s',
    (_, distance) => {
      const { at, rate, accel } = sample(distance)
      at.slice(1).forEach((p, k) => expect(p).toBeGreaterThanOrEqual(at[k]!))
      // Steps between samples bounded by the jerk limit: no jump in rate or acceleration.
      rate
        .slice(1)
        .forEach((v, k) =>
          expect(Math.abs(v - rate[k]!)).toBeLessThan(LIMITS.acceleration * 1e-3 * 1.01),
        )
      accel
        .slice(1)
        .forEach((a, k) => expect(Math.abs(a - accel[k]!)).toBeLessThan(LIMITS.jerk * 1e-3 * 1.5))
      expect(Math.max(...rate)).toBeLessThanOrEqual(LIMITS.rate * (1 + 1e-6))
      expect(Math.max(...accel.map(Math.abs))).toBeLessThanOrEqual(LIMITS.acceleration * 1.01)
    },
  )

  it.each(cases)('is symmetric in time: %s', (_, distance) => {
    const { durationS, positionAt } = motionProfile(distance, LIMITS)
    for (let k = 0; k <= 50; k++) {
      const t = (durationS * k) / 50
      expect(positionAt(t) + positionAt(durationS - t)).toBeCloseTo(distance, 12)
    }
  })

  it('cruises at the peak rate after a ramp of rate / acceleration + acceleration / jerk', () => {
    const ramp = LIMITS.rate / LIMITS.acceleration + LIMITS.acceleration / LIMITS.jerk
    const { durationS, positionAt } = motionProfile(90 * DEG, LIMITS)
    expect(ramp).toBeCloseTo(1.5, 12)
    expect(durationS).toBeCloseTo((90 * DEG) / LIMITS.rate + ramp, 9)
    expect(positionAt(ramp)).toBeCloseTo((LIMITS.rate * ramp) / 2, 12)
    expect((positionAt(20.5) - positionAt(19.5)) / 1).toBeCloseTo(LIMITS.rate, 12)
  })

  it('peaks below the peak rate, with no cruise, on a short move', () => {
    const { rate, durationS } = sample(0.5 * DEG)
    expect(Math.max(...rate)).toBeLessThan(LIMITS.rate * 0.9)
    expect(durationS).toBeLessThan((0.5 * DEG) / LIMITS.rate + 1.5)
  })

  it('takes no time over no distance, and refuses a negative one or a limit that is not positive', () => {
    expect(motionProfile(0, LIMITS).durationS).toBe(0)
    expect(motionProfile(0, LIMITS).positionAt(1)).toBe(0)
    expect(() => motionProfile(-1, LIMITS)).toThrow(RangeError)
    expect(() => motionProfile(1, { ...LIMITS, jerk: 0 })).toThrow(RangeError)
  })
})
