import { describe, expect, it } from 'vitest'
import type { Move, ProfileLimits } from '#shared/utils/drive'
import {
  DEFAULT_SPEED_MODEL,
  driveLimits,
  moveAt,
  peakRate,
  planMove,
  rampAt,
  rampDistance,
  rampDurationS,
  turnDurationS,
  turnLimits,
} from '#shared/utils/drive'
import { AUTONAV_EFFECTIVE_MPS } from '#shared/utils/rover'

const limits: ProfileLimits = { rate: 0.033, accel: 0.025, jerk: 0.04 }

/** Samples every `stepS` from 0 to `durationS` inclusive. */
function samples(durationS: number, stepS: number): number[] {
  const out: number[] = []
  for (let t = 0; t < durationS; t += stepS) out.push(t)
  out.push(durationS)
  return out
}

/** Checks a move's rate, acceleration and jerk against its limits, and their continuity. */
function expectWithinLimits(move: Move): void {
  const { limits: l, durationS } = move
  const h = 1e-3
  let previous = moveAt(move, 0)
  for (const t of samples(durationS, h).slice(1)) {
    const at = moveAt(move, t)
    expect(at.rate).toBeGreaterThanOrEqual(-1e-12)
    expect(at.rate).toBeLessThanOrEqual(l.rate + 1e-12)
    expect(Math.abs(at.accel)).toBeLessThanOrEqual(l.accel + 1e-12)
    // Continuous rate and acceleration: no step bigger than the next derivative allows.
    expect(Math.abs(at.rate - previous.rate)).toBeLessThanOrEqual(l.accel * h + 1e-12)
    expect(Math.abs(at.accel - previous.accel)).toBeLessThanOrEqual(l.jerk * h + 1e-12)
    expect(at.position).toBeGreaterThanOrEqual(previous.position)
    previous = at
  }
}

describe('jerk-limited ramps', () => {
  it('reach the acceleration limit on a large change, two jerk phases on a small one', () => {
    // 0 → 0.033 m/s: A / J = 0.625 s of jerk each side, 0.033 / A = 1.32 s in all at the limit.
    expect(rampDurationS(0, 0.033, limits)).toBeCloseTo(0.033 / 0.025 + 0.025 / 0.04, 12)
    expect(rampDurationS(0.033, 0, limits)).toBe(rampDurationS(0, 0.033, limits))
    // Below A² / J = 0.015625 m/s the acceleration never reaches its limit.
    expect(rampDurationS(0.02, 0.03, limits)).toBeCloseTo(2 * Math.sqrt(0.01 / 0.04), 12)
    expect(rampDistance(0, 0.033, limits)).toBeCloseTo(
      (0.033 / 2) * rampDurationS(0, 0.033, limits),
      15,
    )
  })

  it('start and end at their rates with no acceleration, and cover their distance', () => {
    for (const [from, to] of [
      [0, 0.033],
      [0.033, 0],
      [0.02, 0.03],
      [0.03, 0.021],
    ] as const) {
      const T = rampDurationS(from, to, limits)
      const start = rampAt(from, to, limits, 0)
      expect([start.position + 0, start.rate, start.accel + 0]).toEqual([0, from, 0])
      const end = rampAt(from, to, limits, T)
      expect(end.rate).toBe(to)
      expect(end.accel).toBe(0)
      expect(end.position).toBeCloseTo(rampDistance(from, to, limits), 15)
      // Just short of the end the formula agrees with the snapped end.
      const near = rampAt(from, to, limits, T - 1e-9)
      expect(near.rate).toBeCloseTo(to, 12)
      expect(near.position).toBeCloseTo(end.position, 9)
    }
  })
})

describe('planMove', () => {
  it('cruises at the top rate when both ramps fit: the distance at the rate plus one ramp', () => {
    const move = planMove(10, limits)
    expect(move.peak).toBe(limits.rate)
    expect(move.rampS).toBeCloseTo(1.945, 12)
    expect(move.durationS).toBeCloseTo(10 / limits.rate + move.rampS, 9)
    expect(moveAt(move, 0)).toEqual({ position: 0, rate: 0, accel: 0 })
    expect(moveAt(move, move.durationS)).toEqual({ position: 10, rate: 0, accel: 0 })
    expect(moveAt(move, move.durationS / 2).rate).toBe(limits.rate)
    expectWithinLimits(move)
  })

  it('peaks lower on a short move, its two ramps covering the distance exactly', () => {
    // Between 2 A³ / J² = 0.0195 m and the 0.0642 m both full ramps need: the acceleration
    // limit is held, but the rate never reaches the top.
    const short = planMove(0.04, limits)
    expect(short.peak).toBeLessThan(limits.rate)
    expect(short.peak).toBeGreaterThan(limits.accel ** 2 / limits.jerk)
    expect(short.cruiseS).toBe(0)
    expect(2 * rampDistance(0, short.peak, limits)).toBeCloseTo(0.04, 15)
    expect(moveAt(short, short.durationS / 2).rate).toBeCloseTo(short.peak, 9)
    expectWithinLimits(short)
    // Shorter still, the triangle: jerk phases alone.
    const tiny = planMove(0.005, limits)
    expect(tiny.peak).toBeLessThan(limits.accel ** 2 / limits.jerk)
    expect(2 * rampDistance(0, tiny.peak, limits)).toBeCloseTo(0.005, 15)
    expect(tiny.durationS).toBeCloseTo(4 * Math.sqrt(tiny.peak / limits.jerk), 12)
    expectWithinLimits(tiny)
    // Continuous in the distance across both regimes.
    const edge = limits.accel ** 3 / limits.jerk ** 2
    expect(planMove(2 * edge * (1 + 1e-9), limits).peak).toBeCloseTo(
      planMove(2 * edge * (1 - 1e-9), limits).peak,
      9,
    )
    expect(planMove(0, limits).durationS).toBe(0)
  })

  it('lands on its distance at every sample, rising monotonically', () => {
    for (const d of [0.001, 0.03, 0.3, 3]) {
      const move = planMove(d, limits)
      expect(moveAt(move, move.durationS + 1).position).toBe(d)
      expect(moveAt(move, move.durationS - 1e-9).position).toBeCloseTo(d, 12)
    }
  })
})

describe('peakRate', () => {
  it('is the highest rate that still stops within the distance, capped at the top rate', () => {
    expect(peakRate(0, 10, limits)).toBe(limits.rate)
    const p = peakRate(0.01, 0.04, limits)
    expect(p).toBeGreaterThan(0.01)
    expect(p).toBeLessThan(limits.rate)
    expect(rampDistance(0.01, p, limits) + rampDistance(p, 0, limits)).toBeCloseTo(0.04, 12)
    // Already too fast to stop in time: it keeps the rate it has, for the caller to brake.
    expect(peakRate(0.03, 0.001, limits)).toBe(0.03)
  })
})

describe('the default motion limits', () => {
  const { accelMps2, jerkMps3, emergencyDecelMps2, turnRateRadPerS } = DEFAULT_SPEED_MODEL

  it('start or stop the drive in about 2 s over about 3 cm', () => {
    expect(accelMps2).toBe(0.025)
    expect(jerkMps3).toBe(0.04)
    const l = driveLimits(AUTONAV_EFFECTIVE_MPS)
    expect(rampDurationS(0, AUTONAV_EFFECTIVE_MPS, l)).toBeCloseTo(1.95, 2)
    expect(rampDistance(0, AUTONAV_EFFECTIVE_MPS, l)).toBeCloseTo(0.032, 3)
    // The emergency stop is four times as hard and takes a third of a second.
    expect(emergencyDecelMps2).toBe(0.1)
    expect(AUTONAV_EFFECTIVE_MPS / emergencyDecelMps2).toBeCloseTo(0.33, 2)
  })

  it('ramp a turn in place as its outer corner wheels ramp a drive: about 2.3 s', () => {
    const l = turnLimits()
    expect(l.rate).toBe(turnRateRadPerS)
    expect(rampDurationS(0, l.rate, l)).toBeCloseTo(2.3, 2)
    // 90° at up to 1.5°/s: the angle at the rate plus one ramp.
    expect(turnDurationS(Math.PI / 2)).toBeCloseTo(
      Math.PI / 2 / l.rate + rampDurationS(0, l.rate, l),
      9,
    )
    expect(turnDurationS(-Math.PI / 2)).toBe(turnDurationS(Math.PI / 2))
    expectWithinLimits(planMove(Math.PI / 2, l))
  })
})
