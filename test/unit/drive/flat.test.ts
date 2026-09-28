import { describe, expect, it } from 'vitest'
import {
  AUTONAV_EFFECTIVE_MPS,
  DEFAULT_ROVER_GEOMETRY,
  ROVER_MAX_SPEED_MPS,
} from '#shared/utils/rover'
import { DEFAULT_STOP_MODEL, driveSegment, statusAt, statusRuns } from '#shared/utils/drive'
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

  it('publishes the reference speeds: 0.042 m/s cap, 0.033 m/s AutoNav', () => {
    expect(ROVER_MAX_SPEED_MPS).toBe(0.042)
    expect(AUTONAV_EFFECTIVE_MPS).toBe(0.033)
    expect(DEFAULT_STOP_MODEL).toEqual({ imagingEveryM: 25, imagingStopS: 30, assessStopS: 20 })
  })

  it('arrives after 100 m in ≈ 3,030 s: the AutoNav rate plus imaging stops', () => {
    expect(outcome.kind).toBe('arrived')
    expect(outcome.reasons).toEqual([])
    expect(outcome.distanceM).toBeCloseTo(100, 6)
    expect(outcome.endPose.x).toBeCloseTo(50, 6)
    expect(outcome.endPose.y).toBeCloseTo(0, 6)
    expect(Math.abs(outcome.durationS - 3030) / 3030).toBeLessThan(0.05)
    // Driving time alone is distance over the AutoNav rate; the rest is the three imaging stops.
    expect(outcome.durationS).toBeCloseTo(100 / 0.033 + 3 * 30, -1)
    // The plan's estimate is the same sum, so on flat, seen ground it is the drive's time.
    expect(record.plan.metrics.estimatedDriveS).toBeCloseTo(outcome.durationS, -1)
    expect(stats.simSteps).toBeGreaterThan(0)
    expect(stats.replans).toBe(0)
    expect(stats.computeMs).toBeGreaterThanOrEqual(0)
  })

  it('stops only to image, every 25 m and not at the goal', () => {
    const types = new Set(record.events.map((event) => event.type))
    expect(types).toEqual(new Set(['start', 'imaging', 'arrived']))
    const imaging = record.events.filter((event) => event.type === 'imaging')
    expect(imaging).toHaveLength(3)
    for (const [k, event] of imaging.entries()) {
      expect(event.details).toEqual({ durationS: 30 })
      expect(event.x).toBeCloseTo(-50 + 25 * (k + 1), 1)
    }
  })

  it('holds still with the wheels unturned through an imaging stop', () => {
    const stop = record.events.find((event) => event.type === 'imaging')!
    const from = Math.ceil(stop.t * keyframes.hz)
    const to = Math.floor((stop.t + 30) * keyframes.hz)
    // The frame at the stop's start still carries the last step's speed.
    const first = frame(keyframes, from)
    for (let k = from + 1; k <= to; k++) {
      const f = frame(keyframes, k)
      expect(f[F.speed]).toBe(0)
      expect(f[F.x]).toBe(first[F.x])
      for (const w of SPINS) expect(f[w]).toBe(first[w])
    }
  })

  it('tracks what the rover is doing: driving, imaging, then stopped', () => {
    const runs = statusRuns(record.events)
    expect(runs.map((run) => run.status)).toEqual([
      'driving',
      'imaging',
      'driving',
      'imaging',
      'driving',
      'imaging',
      'driving',
      'stopped',
    ])
    const stop = record.events.find((event) => event.type === 'imaging')!
    expect(statusAt(record.events, stop.t + 12)).toMatchObject({
      status: 'imaging',
      t: stop.t,
      endsAt: stop.t + 30,
    })
    expect(statusAt(record.events, stop.t + 31).status).toBe('driving')
    expect(statusAt(record.events, outcome.durationS).status).toBe('stopped')
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
      expect(f[F.speed]).toBeLessThanOrEqual(AUTONAV_EFFECTIVE_MPS + 1e-6)
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
  })
})

describe('driveSegment near the edge of its survey', () => {
  const world = syntheticWorld({})
  // The east half unseen from the stop, so the drive has ground to reveal near the edge.
  const disk = syntheticDisk(world, { radius: 60, hidden: (x) => x > 0 })
  const { record } = driveSegment(world, {
    disk,
    revealed: revealedAfterStop(world, disk),
    start: { x: -50, y: 0, headingRad: 0 },
    goal: { x: 50, y: 0 },
  })

  it('reveals nothing beyond the survey, though its viewsheds reach past it', () => {
    const { width, cellSize } = disk.grid
    let revealed = 0
    let beyond = 0
    for (const { vertices } of record.reveals) {
      for (const k of vertices) {
        revealed++
        const i = k % width
        const x = (disk.origin.i + i) * cellSize
        const y = (disk.origin.j + (k - i) / width) * cellSize
        if (Math.hypot(x, y) > disk.radius) beyond++
      }
    }
    expect(record.outcome.kind).toBe('arrived')
    expect(revealed).toBeGreaterThan(0)
    expect(beyond).toBe(0)
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

describe('driveSegment with a turn in place', () => {
  const world = syntheticWorld({})
  const disk = syntheticDisk(world)
  const revealed = revealedAfterStop(world, disk)
  const { record } = driveSegment(world, {
    disk,
    revealed,
    start: { x: 0, y: 0, headingRad: Math.PI / 2 },
    goal: { x: 20, y: 0 },
  })

  it('turns 90° right at 3°/s before driving, as a turning stop', () => {
    expect(record.outcome.kind).toBe('arrived')
    const turning = record.events.filter((event) => event.type === 'turning')
    expect(turning).toHaveLength(1)
    expect(turning[0]).toMatchObject({ t: 0, type: 'turning' })
    expect(turning[0]!.details!.angleDeg).toBeCloseTo(-90, 6)
    expect(turning[0]!.details!.durationS).toBeCloseTo(30, 6)
    expect(statusAt(record.events, 10)).toMatchObject({ status: 'turning', angleDeg: -90 })
    expect(statusAt(record.events, 31).status).toBe('driving')
    // 30 s turning plus 20 m at the AutoNav rate; no imaging stop short of 25 m.
    expect(record.outcome.durationS).toBeCloseTo(30 + 20 / 0.033, -1)
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

  it('refuses stop settings that are not durations or spacings', () => {
    for (const stops of [{ imagingEveryM: 0 }, { imagingStopS: -1 }, { assessStopS: Number.NaN }]) {
      expect(driveErrorOf(() => driveSegment(world, { ...base, stops }))?.code).toBe(
        'INVALID_INPUT',
      )
    }
  })
})
