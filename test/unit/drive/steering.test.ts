import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPEED_MODEL,
  minArcRadiusM,
  STEER_LIMIT_RAD,
  STEER_THRESHOLD_RAD,
  steerDurationS,
  steeringFor,
  steeringTimeS,
  STRAIGHT_WHEELS,
} from '#shared/utils/drive'
import { DEFAULT_ROVER_GEOMETRY, ROVER_MAX_SPEED_MPS } from '#shared/utils/rover'
import { driveErrorOf } from './helpers'

const DEG = Math.PI / 180
const { frontWheel: f, middleWheel: m, rearWheel: r } = DEFAULT_ROVER_GEOMETRY
/** Body-frame corner wheel mounts, order FL, FR, RL, RR. */
const CORNERS = [
  [f.x, f.y],
  [f.x, -f.y],
  [r.x, r.y],
  [r.x, -r.y],
] as const

describe('steeringFor', () => {
  it('keeps every wheel straight on a straight arc, each rolling the arc length', () => {
    const { angles, roll } = steeringFor({ type: 'arc', lengthM: 5, curvature: 0 })
    expect(angles).toEqual([0, 0, 0, 0])
    expect(roll).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('turns in place with each corner wheel across its diagonal, the same stance either way', () => {
    const left = steeringFor({ type: 'turn', angleRad: 1 })
    const right = steeringFor({ type: 'turn', angleRad: -1 })
    for (const [k, a] of right.angles.entries()) expect(a).toBeCloseTo(left.angles[k]!, 12)
    const [fl, fr, rl, rr] = left.angles
    // Front wheels toe in, rear wheels toe out, mirrored side to side.
    expect(fl).toBeCloseTo(-Math.atan2(f.x, f.y), 12)
    expect(fr).toBeCloseTo(-fl, 12)
    expect(rl).toBeCloseTo(Math.atan2(-r.x, r.y), 12)
    expect(rr).toBeCloseTo(-rl, 12)
    // About 45° off the forward axis, the rear ones a little less than the front.
    expect(fl / DEG).toBeCloseTo(-48.05, 1)
    expect(rl / DEG).toBeCloseTo(45.26, 1)
    // Each wheel's axle points at the centre: its rolling direction is square to its radius.
    for (const [k, [x, y]] of CORNERS.entries()) {
      const a = left.angles[k]!
      expect(Math.cos(a) * x + Math.sin(a) * y).toBeCloseTo(0, 12)
    }
  })

  it('rolls the sides opposite ways in a turn in place, in proportion to each wheel radius', () => {
    const { roll } = steeringFor({ type: 'turn', angleRad: 1 })
    const radii = [Math.hypot(f.x, f.y), Math.hypot(m.x, m.y), Math.hypot(r.x, r.y)]
    // Left turn: left wheels back, right wheels forward, metres per radian of turn.
    expect(roll[0]).toBeCloseTo(-radii[0]!, 12)
    expect(roll[1]).toBeCloseTo(radii[0]!, 12)
    expect(roll[2]).toBeCloseTo(-radii[1]!, 12)
    expect(roll[3]).toBeCloseTo(radii[1]!, 12)
    expect(roll[4]).toBeCloseTo(-radii[2]!, 12)
    expect(roll[5]).toBeCloseTo(radii[2]!, 12)
    const reversed = steeringFor({ type: 'turn', angleRad: -1 }).roll
    for (const [k, v] of reversed.entries()) expect(v).toBeCloseTo(-roll[k]!, 12)
  })

  it('steers an arc on Ackermann angles about the common centre, the inner wheels harder', () => {
    const R = 2
    const { angles, roll } = steeringFor({ type: 'arc', lengthM: 1, curvature: 1 / R })
    const [fl, fr, rl, rr] = angles
    // A left arc: centre at (0, R); the left side is inner.
    expect(fl).toBeCloseTo(Math.atan2(f.x, R - f.y), 12)
    expect(fr).toBeCloseTo(Math.atan2(f.x, R + f.y), 12)
    expect(fl).toBeGreaterThan(fr)
    expect(fr).toBeGreaterThan(0)
    expect(rl).toBeCloseTo(Math.atan2(r.x, R - r.y), 12)
    expect(rl).toBeLessThan(rr)
    expect(rr).toBeLessThan(0)
    // Each wheel's axle line passes through the turn centre.
    for (const [k, [x, y]] of CORNERS.entries()) {
      const a = angles[k]!
      expect(Math.cos(a) * x + Math.sin(a) * (y - R)).toBeCloseTo(0, 12)
    }
    // Each wheel rolls its own circle: its distance from the centre over R per metre of arc.
    for (const [k, [x, y]] of [
      [f.x, f.y],
      [f.x, -f.y],
      [m.x, m.y],
      [m.x, -m.y],
      [r.x, r.y],
      [r.x, -r.y],
    ].entries()) {
      expect(roll[k]).toBeCloseTo(Math.hypot(x!, y! - R) / R, 12)
    }
    const mirrored = steeringFor({ type: 'arc', lengthM: 1, curvature: -1 / R })
    const expected = [-fr, -fl, -rr, -rl]
    for (const [k, a] of mirrored.angles.entries()) expect(a).toBeCloseTo(expected[k]!, 12)
  })

  it('reaches arcs down to the radius the 85° steering limit allows, and refuses tighter', () => {
    const tightest = minArcRadiusM()
    expect(STEER_LIMIT_RAD).toBeCloseTo(85 * DEG, 12)
    expect(tightest).toBeCloseTo(f.y + f.x / Math.tan(STEER_LIMIT_RAD), 12)
    expect(tightest).toBeLessThan(2)
    const at = steeringFor({ type: 'arc', lengthM: 1, curvature: 1 / tightest })
    expect(at.angles[0]).toBeCloseTo(STEER_LIMIT_RAD, 9)
    expect(
      driveErrorOf(() => steeringFor({ type: 'arc', lengthM: 1, curvature: 1 / (tightest - 0.02) }))
        ?.code,
    ).toBe('INVALID_INPUT')
  })
})

describe('steering time', () => {
  const { steerRateRadPerS, turnRateRadPerS } = DEFAULT_SPEED_MODEL

  it('uses the published rates: 0.168 rad/s steering, the outer corner at 0.042 m/s in a turn', () => {
    expect(steerRateRadPerS).toBe(0.168)
    expect(turnRateRadPerS).toBeCloseTo(ROVER_MAX_SPEED_MPS / Math.hypot(f.x, f.y), 12)
    expect(turnRateRadPerS / DEG).toBeCloseTo(1.51, 2)
  })

  it('takes the largest wheel change at the steering rate, nothing within the threshold', () => {
    const stance = steeringFor({ type: 'turn', angleRad: 1 }).angles
    expect(steerDurationS(STRAIGHT_WHEELS, stance)).toBeCloseTo(
      Math.atan2(f.x, f.y) / steerRateRadPerS,
      12,
    )
    expect(steerDurationS(stance, STRAIGHT_WHEELS, 0.1)).toBeCloseTo(Math.atan2(f.x, f.y) / 0.1, 12)
    const nudged = STRAIGHT_WHEELS.map((a) => a + STEER_THRESHOLD_RAD * 0.9) as typeof stance
    expect(steerDurationS(STRAIGHT_WHEELS, nudged)).toBe(0)
  })

  it('steers into and out of each turn in place and each blend arc along a motion list', () => {
    const stance = steerDurationS(
      STRAIGHT_WHEELS,
      steeringFor({ type: 'turn', angleRad: 1 }).angles,
    )
    const arc = { type: 'arc', lengthM: 3, curvature: 0.5 } as const
    const intoArc = steerDurationS(STRAIGHT_WHEELS, steeringFor(arc).angles)
    const total = steeringTimeS([
      { type: 'arc', lengthM: 10, curvature: 0 },
      { type: 'turn', angleRad: 1 },
      { type: 'arc', lengthM: 10, curvature: 0 },
      arc,
      { type: 'arc', lengthM: 10, curvature: 0 },
    ])
    expect(total).toBeCloseTo(2 * stance + 2 * intoArc, 12)
    expect(steeringTimeS([{ type: 'arc', lengthM: 10, curvature: 0 }])).toBe(0)
  })
})
