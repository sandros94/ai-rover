import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STOP_MODEL,
  driveLimits,
  driveSegment,
  groundSpeedMps,
  imagingStopsAt,
  rampDurationS,
  rampTimeS,
  steeringTimeS,
  turnDurationS,
} from '#shared/utils/drive'
import { DEFAULT_COST_MAP, planSegment } from '#shared/utils/nav'
import { AUTONAV_EFFECTIVE_MPS } from '#shared/utils/rover'
import { journeyFixture } from '../client/helpers'
import { syntheticDisk as navDisk } from '../nav/helpers'
import { revealedAfterStop, syntheticDisk, syntheticWorld } from './helpers'

describe('groundSpeedMps', () => {
  it('drives at the AutoNav rate on flat ground and half of it at the slope limit and beyond', () => {
    expect(groundSpeedMps(0)).toBe(AUTONAV_EFFECTIVE_MPS)
    expect(groundSpeedMps(0.5)).toBeCloseTo(0.75 * AUTONAV_EFFECTIVE_MPS, 12)
    expect(groundSpeedMps(1)).toBeCloseTo(0.5 * AUTONAV_EFFECTIVE_MPS, 12)
    expect(groundSpeedMps(3)).toBe(groundSpeedMps(1))
    expect(groundSpeedMps(1, { cruiseSpeedMps: 0.04, slopeSlowdown: 0.25 })).toBeCloseTo(0.03, 12)
  })
})

describe('the planned drive time', () => {
  const slopeLimitDeg = 16
  const flat = navDisk({ size: 241, radius: 120 })
  const seen = new Uint8Array(241 * 241).fill(1)

  it('is the path at its speed, an imaging stop every 25 m away from either end, the turns, the steering and the ramps', () => {
    const straight = planSegment(flat, {
      revealed: seen,
      start: { x: -50, y: 0 },
      goal: { x: 50, y: 0 },
      slopeLimitDeg,
    })
    // 100 m at 0.033 m/s, three imaging stops (25, 50 and 75 m), no turn; the stops split the
    // drive into four runs, each a ramp longer than cruising all the way.
    const rampS = rampDurationS(0, AUTONAV_EFFECTIVE_MPS, driveLimits(AUTONAV_EFFECTIVE_MPS))
    expect(straight.metrics.estimatedDriveS).toBeCloseTo(
      100 / AUTONAV_EFFECTIVE_MPS + 3 * 30 + 4 * rampS,
      6,
    )
    const { imagingStopS } = DEFAULT_STOP_MODEL
    expect(imagingStopS).toBe(30)
    // A wall across the way forces a corner turned in place, timed at the turn rate.
    const walled = navDisk({
      size: 241,
      radius: 120,
      blocked: (x, y) => x > -12 && x < 12 && y > -60 && y < 60,
    })
    const around = planSegment(walled, {
      revealed: seen,
      start: { x: -50, y: 0 },
      goal: { x: 50, y: 0 },
      slopeLimitDeg,
      turnInPlaceAboveRad: 0.1,
    })
    let turned = 0
    let turningS = 0
    for (const motion of around.motions) {
      if (motion.type !== 'turn') continue
      turned += Math.abs(motion.angleRad)
      turningS += turnDurationS(motion.angleRad)
    }
    expect(turned).toBeGreaterThan(0)
    const { pathLengthM } = around.metrics
    // Stops at 25 m steps, none in the first or last 5 % of the path.
    let stops = 0
    for (let at = 25; at < pathLengthM; at += 25) {
      if (at >= 0.05 * pathLengthM && pathLengthM - at >= 0.05 * pathLengthM) stops++
    }
    const imaging = stops * imagingStopS
    expect(around.metrics.estimatedDriveS).toBeCloseTo(
      pathLengthM / AUTONAV_EFFECTIVE_MPS +
        imaging +
        turningS +
        steeringTimeS(around.motions) +
        rampTimeS(around.motions, { stopsAtM: imagingStopsAt(pathLengthM, 25) }),
      6,
    )
    expect(imagingStopsAt(pathLengthM, 25)).toHaveLength(stops)
    // Into and out of each turn-in-place stance.
    expect(steeringTimeS(around.motions)).toBeGreaterThan(0)
  })

  it('drives unseen ground at the speed of ground that costs the unrevealed penalty', () => {
    const fog = new Uint8Array(241 * 241)
    const blind = planSegment(flat, {
      revealed: fog,
      start: { x: -50, y: 0 },
      goal: { x: 50, y: 0 },
      slopeLimitDeg,
    })
    // Seen ground costs 1 + 4 · ratio²; the penalty of 3 is the cost at ratio √0.5.
    const { slopeWeight, unrevealedPenalty } = DEFAULT_COST_MAP
    const ratio = Math.sqrt((unrevealedPenalty - 1) / slopeWeight)
    const rampS = rampDurationS(0, AUTONAV_EFFECTIVE_MPS, driveLimits(AUTONAV_EFFECTIVE_MPS))
    expect(blind.metrics.estimatedDriveS).toBeCloseTo(
      100 / groundSpeedMps(ratio) + 3 * 30 + 4 * rampS,
      6,
    )
  })

  it('is 0 for a route not reached', () => {
    const island = navDisk({
      size: 241,
      radius: 120,
      blocked: (x, y) => Math.hypot(x - 50, y) < 10 && Math.hypot(x - 50, y) > 5,
    })
    const plan = planSegment(island, {
      revealed: seen,
      start: { x: -50, y: 0 },
      goal: { x: 50, y: 0 },
      slopeLimitDeg,
    })
    expect(plan.metrics.reached).toBe(false)
    expect(plan.metrics.estimatedDriveS).toBe(0)
  })

  it('matches the recorded drive within 10 % of the time the producer took', () => {
    const { record } = journeyFixture()
    expect(record.outcome.kind).toBe('arrived')
    const { estimatedDriveS } = record.plan.metrics
    expect(Math.abs(estimatedDriveS / record.outcome.durationS - 1)).toBeLessThan(0.1)
  })

  it('matches a drive through a slalom of walls, seven turns in place steered into and out of, within 10 %', () => {
    const world = syntheticWorld({})
    const disk = syntheticDisk(world, {
      blocked: (x, y) =>
        (x > -30 && x < -26 && y < 20) ||
        (x > -6 && x < -2 && y > -20) ||
        (x > 18 && x < 22 && y < 20),
    })
    const { record } = driveSegment(world, {
      disk,
      revealed: revealedAfterStop(world, disk),
      start: { x: -50, y: 0, headingRad: 0 },
      goal: { x: 50, y: 0 },
    })
    expect(record.outcome.kind).toBe('arrived')
    const count = (type: string) => record.events.filter((event) => event.type === type).length
    expect(count('turning')).toBeGreaterThanOrEqual(5)
    expect(count('steering')).toBe(2 * count('turning'))
    const { estimatedDriveS } = record.plan.metrics
    expect(Math.abs(estimatedDriveS / record.outcome.durationS - 1)).toBeLessThan(0.1)
  })
})
