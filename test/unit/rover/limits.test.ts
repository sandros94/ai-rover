import { describe, expect, it } from 'vitest'
import type { RoverPose } from '#shared/utils/rover'
import { checkLimits, DEFAULT_ROVER_LIMITS, poseOnTerrain } from '#shared/utils/rover'
import { DEG, roverErrorOf } from './helpers'

const flat = poseOnTerrain(() => 0, { x: 0, y: 0, headingRad: 0 })

function withAngles(overrides: Partial<RoverPose>): RoverPose {
  return { ...flat, ...overrides }
}

describe('checkLimits', () => {
  it('uses the flight-limit defaults', () => {
    expect(DEFAULT_ROVER_LIMITS.tiltRad).toBeCloseTo(30 * DEG, 12)
    expect(DEFAULT_ROVER_LIMITS.pitchRad).toBeCloseTo(15 * DEG, 12)
    expect(DEFAULT_ROVER_LIMITS.rollRad).toBeCloseTo(15 * DEG, 12)
    expect(DEFAULT_ROVER_LIMITS.bogieRad).toBeCloseTo(17 * DEG, 12)
    expect(DEFAULT_ROVER_LIMITS.differentialRad).toBeCloseTo(7 * DEG, 12)
    expect(DEFAULT_ROVER_LIMITS.tipOverRad).toBeCloseTo(45 * DEG, 12)
    expect(DEFAULT_ROVER_LIMITS.minClearanceM).toBe(0)
  })

  it('passes a level rover', () => {
    expect(checkLimits(flat)).toEqual({ level: 'ok', reasons: [] })
  })

  it('warns per suspension angle and side', () => {
    const pose = withAngles({
      bogie: { left: 0, right: -18 * DEG },
      rocker: { left: 8 * DEG, right: -8 * DEG },
      differentialRad: 8 * DEG,
      rollRad: 16 * DEG,
    })
    expect(checkLimits(pose)).toEqual({
      level: 'warn',
      reasons: ['roll', 'bogie-right', 'differential'],
    })
  })

  it('fails on clearance and tip-over, keeping the warnings', () => {
    const pose = withAngles({ tiltRad: 46 * DEG, bellyClearanceM: -0.01 })
    expect(checkLimits(pose)).toEqual({
      level: 'fail',
      reasons: ['tilt', 'clearance', 'tip-over'],
    })
  })

  it('takes custom limits', () => {
    const pose = withAngles({ pitchRad: 10 * DEG })
    expect(checkLimits(pose).level).toBe('ok')
    expect(checkLimits(pose, { limits: { pitchRad: 5 * DEG } })).toEqual({
      level: 'warn',
      reasons: ['pitch'],
    })
  })

  it('refuses invalid limits and non-finite poses', () => {
    expect(roverErrorOf(() => checkLimits(flat, { limits: { tiltRad: -1 } }))?.code).toBe(
      'INVALID_LIMITS',
    )
    expect(roverErrorOf(() => checkLimits(withAngles({ tiltRad: Number.NaN })))?.code).toBe(
      'INVALID_POSE',
    )
  })
})
