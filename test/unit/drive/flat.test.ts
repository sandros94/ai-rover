import { describe, expect, it } from 'vitest'
import { DEFAULT_ROVER_GEOMETRY } from '#shared/utils/rover'
import { driveSegment } from '#shared/utils/drive'
import { driveErrorOf, F, frame, revealedAfterStop, syntheticDisk, syntheticWorld } from './helpers'

const r = DEFAULT_ROVER_GEOMETRY.wheelRadius
const yMiddle = DEFAULT_ROVER_GEOMETRY.middleWheel.y
const SPINS = [F.spinFL, F.spinFR, F.spinML, F.spinMR, F.spinRL, F.spinRR] as const

describe('driveSegment on flat ground', () => {
  const world = syntheticWorld({})
  const disk = syntheticDisk(world)
  const revealed = revealedAfterStop(world, disk)
  const { record, stats } = driveSegment(world, {
    disk,
    revealed,
    start: { x: -50, y: 0, headingRad: 0 },
    goal: { x: 50, y: 0 },
  })
  const { keyframes, outcome } = record

  it('arrives after 100 m at the reference effective speed of ~0.033 m/s', () => {
    expect(outcome.kind).toBe('arrived')
    expect(outcome.reasons).toEqual([])
    expect(outcome.distanceM).toBeCloseTo(100, 6)
    expect(outcome.endPose.x).toBeCloseTo(50, 6)
    expect(outcome.endPose.y).toBeCloseTo(0, 6)
    expect(Math.abs(outcome.durationS - 100 / 0.033) / (100 / 0.033)).toBeLessThan(0.1)
    // 0.042 m/s cruise plus a think pause per metre: 1 / (1 / 0.042 + 6.5) ≈ 0.0330 m/s.
    const effective = outcome.distanceM / outcome.durationS
    expect(effective).toBeGreaterThan(0.032)
    expect(effective).toBeLessThan(0.034)
    expect(stats.simSteps).toBeGreaterThan(0)
    expect(stats.replans).toBe(0)
    expect(stats.computeMs).toBeGreaterThanOrEqual(0)
  })

  it('samples keyframes at 2 Hz from t = 0 to the end', () => {
    expect(keyframes.hz).toBe(2)
    expect(keyframes.stride).toBe(19)
    expect(keyframes.data.length).toBe(19 * keyframes.count)
    expect(Math.abs(keyframes.count - outcome.durationS * 2)).toBeLessThanOrEqual(1)
    for (let k = 0; k < keyframes.count; k++) expect(frame(keyframes, k)[F.t]).toBe(k / 2)
    expect(frame(keyframes, keyframes.count - 1)[F.t]).toBe(outcome.durationS)
  })

  it('keeps the body level at the flat body height with the suspension at rest', () => {
    for (let k = 0; k < keyframes.count; k++) {
      const f = frame(keyframes, k)
      expect(Math.abs(f[F.z]!)).toBeLessThan(1e-6)
      for (const name of ['rockerL', 'rockerR', 'bogieL', 'bogieR', 'qx', 'qy', 'qz'] as const)
        expect(Math.abs(f[F[name]]!)).toBeLessThan(1e-6)
      expect(f[F.qw]).toBeCloseTo(1, 6)
      expect(f[F.speed]).toBeGreaterThanOrEqual(0)
      expect(f[F.speed]).toBeLessThanOrEqual(0.042 + 1e-6)
    }
  })

  it('turns every wheel by distance over wheel radius', () => {
    const last = frame(keyframes, keyframes.count - 1)
    for (const k of SPINS) expect(Math.abs(last[k]! - 100 / r) / (100 / r)).toBeLessThan(0.01)
  })

  it('opens with start and closes with arrived', () => {
    expect(record.version).toBe(1)
    expect(record.events[0]).toMatchObject({ t: 0, type: 'start', x: -50, y: 0 })
    const arrived = record.events.at(-1)!
    expect(arrived.type).toBe('arrived')
    expect(arrived.x).toBeCloseTo(50, 6)
    // The block then holds the final pose up to the next keyframe.
    expect(arrived.t).toBeLessThanOrEqual(outcome.durationS)
    expect(arrived.t).toBeGreaterThan(outcome.durationS - 0.5)
    const pauses = record.events.filter((event) => event.type === 'pause')
    expect(pauses.length).toBeGreaterThanOrEqual(99)
  })
})

describe('driveSegment through a blended corner', () => {
  const world = syntheticWorld({})
  // An L-shaped corridor: north along x = −30, then east along y = 30.
  const disk = syntheticDisk(world, {
    blocked: (x, y) =>
      !(Math.abs(x + 30) <= 3 && y >= -3 && y <= 33) &&
      !(Math.abs(y - 30) <= 3 && x >= -33 && x <= 33),
  })
  const revealed = revealedAfterStop(world, disk)
  const start = { x: -30, y: 0, headingRad: Math.PI / 2 }
  const { record } = driveSegment(world, {
    disk,
    revealed,
    start,
    goal: { x: 30, y: 30 },
    plan: { turnInPlaceAboveRad: Math.PI / 2 },
  })
  const { outcome, keyframes } = record

  it('blends the corner into an arc', () => {
    expect(outcome.kind).toBe('arrived')
    expect(record.plan.motions.some((m) => m.type === 'arc' && m.curvature !== 0)).toBe(true)
  })

  it('turns the inner wheels less than the outer ones by the differential-odometry ratio', () => {
    const last = frame(keyframes, keyframes.count - 1)
    let turned = outcome.endPose.headingRad - start.headingRad
    turned = Math.atan2(Math.sin(turned), Math.cos(turned))
    expect(turned).toBeLessThan(-1)
    const left = last[F.spinML]!
    const right = last[F.spinMR]!
    // Right turn: the right side is inner.
    expect(right).toBeLessThan(left)
    expect(right - left).toBeCloseTo((2 * yMiddle * turned) / r, 2)
    const d = outcome.distanceM
    expect(right / left).toBeCloseTo((d + yMiddle * turned) / (d - yMiddle * turned), 3)
  })
})

describe('driveSegment input checks', () => {
  const world = syntheticWorld({})
  const disk = syntheticDisk(world)
  const revealed = revealedAfterStop(world, disk)
  const base = { disk, revealed, start: { x: 0, y: 0, headingRad: 0 }, goal: { x: 10, y: 0 } }

  it('refuses points outside the disk or non-finite', () => {
    expect(driveErrorOf(() => driveSegment(world, { ...base, goal: { x: 200, y: 0 } }))?.code).toBe(
      'INVALID_INPUT',
    )
    expect(
      driveErrorOf(() =>
        driveSegment(world, { ...base, start: { x: Number.NaN, y: 0, headingRad: 0 } }),
      )?.code,
    ).toBe('INVALID_INPUT')
  })

  it('refuses rates that do not divide evenly and non-positive distances', () => {
    expect(
      driveErrorOf(() => driveSegment(world, { ...base, simHz: 5, keyframeHz: 2 }))?.code,
    ).toBe('INVALID_INPUT')
    expect(driveErrorOf(() => driveSegment(world, { ...base, lookaheadM: 0 }))?.code).toBe(
      'INVALID_INPUT',
    )
    expect(driveErrorOf(() => driveSegment(world, { ...base, revealRadiusM: -1 }))?.code).toBe(
      'INVALID_INPUT',
    )
  })
})
