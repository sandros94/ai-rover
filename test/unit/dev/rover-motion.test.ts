import { describe, expect, it } from 'vitest'
import { ARM_NIGHT, ARM_SEQUENCE_S, framePlacement } from '#shared/utils/client/scene'
import {
  DEFAULT_SPEED_MODEL,
  KEYFRAME_FIELDS,
  steeringFor,
  steerLimits,
  turnLimits,
} from '#shared/utils/drive'
import { ARM_STOWED, DEFAULT_ROVER_GEOMETRY } from '#shared/utils/rover'
import { MOTION_DEMOS, motionAt } from '~~/modules/dev/runtime/app/playground/rover-motion'

const DEG = Math.PI / 180
const duration = (id: string) => MOTION_DEMOS.find((d) => d.id === id)!.durationS
const read = (frame: Float32Array, name: (typeof KEYFRAME_FIELDS)[number]) =>
  frame[KEYFRAME_FIELDS.indexOf(name)]!
const heading = (frame: Float32Array) => {
  const q = framePlacement(frame).quaternion
  return 2 * Math.atan2(q.z, q.w)
}

describe('the point turn', () => {
  const mid = motionAt('point-turn', duration('point-turn') / 2)

  it("steers the corners to the producer's turn-in-place angles, the toe-in stance", () => {
    const { x, y } = DEFAULT_ROVER_GEOMETRY.frontWheel
    const { angles } = steeringFor({ type: 'turn', angleRad: 90 * DEG })
    // Counter-clockwise positive: the front left toes in to the right.
    expect(read(mid.frame, 'steerFL')).toBeCloseTo(-Math.atan(x / y), 6)
    expect(read(mid.frame, 'steerFR')).toBeCloseTo(Math.atan(x / y), 6)
    for (const [k, name] of (['steerFL', 'steerFR', 'steerRL', 'steerRR'] as const).entries())
      expect(read(mid.frame, name)).toBeCloseTo(angles[k]!, 6)
  })

  it('turns the body in place, each side spinning the other way, then steers straight', () => {
    const start = motionAt('point-turn', 0)
    const end = motionAt('point-turn', duration('point-turn'))
    expect(framePlacement(end.frame).position.x).toBeCloseTo(0, 6)
    expect(heading(end.frame)).toBeCloseTo(90 * DEG, 5)
    expect(heading(start.frame)).toBe(0)
    for (const side of ['F', 'M', 'R'] as const) {
      expect(read(mid.frame, `spin${side}L`)).toBeLessThan(0)
      expect(read(mid.frame, `spin${side}R`)).toBeGreaterThan(0)
    }
    expect(read(end.frame, 'steerFL')).toBeCloseTo(0, 12)
    expect(end.joints).toEqual(ARM_STOWED)
  })
})

describe('the arc', () => {
  it('steers to double-Ackermann angles, drives round a centre 4 m to the left, each wheel at its radius', () => {
    const mid = motionAt('arc', duration('arc') / 2)
    const { x, y } = DEFAULT_ROVER_GEOMETRY.frontWheel
    expect(read(mid.frame, 'steerFL')).toBeCloseTo(Math.atan(x / (4 - y)), 6)
    expect(read(mid.frame, 'steerFR')).toBeCloseTo(Math.atan(x / (4 + y)), 6)
    const rear = DEFAULT_ROVER_GEOMETRY.rearWheel
    expect(read(mid.frame, 'steerRL')).toBeCloseTo(Math.atan(rear.x / (4 - rear.y)), 6)
    // The outer wheels roll further than the inner ones.
    expect(read(mid.frame, 'spinMR')).toBeGreaterThan(read(mid.frame, 'spinML'))
    expect(read(mid.frame, 'spinFL')).toBeGreaterThan(read(mid.frame, 'spinML'))
    expect(read(mid.frame, 'speed')).toBeCloseTo(DEFAULT_SPEED_MODEL.cruiseSpeedMps, 6)
    const p = framePlacement(motionAt('arc', duration('arc')).frame).position
    expect(Math.hypot(p.x, p.y - 4)).toBeCloseTo(4, 5)
    expect(Math.atan2(p.x, 4 - p.y)).toBeCloseTo(3.6 / 4, 5)
  })
})

describe("the producer's rates", () => {
  /**
   * Rate and largest acceleration of a series sampled `dt` apart over the whole demo: 50 ms, as
   * the frame's float32 heading differenced twice at 10 ms reads noise of a few mrad/s².
   */
  function series(demo: 'point-turn' | 'arc', value: (t: number) => number, dt = 0.05) {
    const d = duration(demo)
    const at = Array.from({ length: Math.ceil(d / dt) + 1 }, (_, k) => value(k * dt))
    const rate = at.slice(1).map((v, k) => (v - at[k]!) / dt)
    const jumps = rate.slice(1).map((v, k) => Math.abs(v - rate[k]!) / dt)
    return { rate, maxAccel: Math.max(...jumps) }
  }

  it.each([
    ['point-turn', turnLimits().accel],
    ['arc', DEFAULT_SPEED_MODEL.accelMps2 / 4],
  ] as const)(
    'steers and turns from rest to rest, rates continuous and within the limits: %s',
    (demo, headingAccel) => {
      const steer = series(demo, (t) => read(motionAt(demo, t).frame, 'steerFL'))
      const turn = series(demo, (t) => heading(motionAt(demo, t).frame))
      for (const [{ rate, maxAccel }, limit] of [
        [steer, steerLimits().accel],
        [turn, headingAccel],
      ] as const) {
        expect(Math.abs(rate[0]!)).toBeLessThan(1e-6)
        expect(Math.abs(rate.at(-1)!)).toBeLessThan(1e-6)
        expect(maxAccel).toBeLessThan(limit * 1.05)
      }
      // The steering has settled before the body turns, and starts back only once it stops (rates
      // under 0.006°/s being the instants either side of a switch).
      const moving = turn.rate.map((v) => Math.abs(v) > 1e-4)
      const steering = steer.rate.map((v) => Math.abs(v) > 1e-4)
      expect(moving.some((m, k) => m && steering[k])).toBe(false)
    },
  )

  it('peaks at the turn-in-place rate in the point turn and the cruise speed along the arc', () => {
    const turn = series('point-turn', (t) => heading(motionAt('point-turn', t).frame))
    expect(Math.max(...turn.rate)).toBeCloseTo(turnLimits().rate, 4)
    const arc = series('arc', (t) => heading(motionAt('arc', t).frame))
    expect(Math.max(...arc.rate) * 4).toBeCloseTo(DEFAULT_SPEED_MODEL.cruiseSpeedMps, 4)
  })
})

describe('dusk and dawn', () => {
  it('unstows the arm after sunset with the lamp coming on, and stows it after sunrise', () => {
    const d = duration('dusk-dawn')
    expect(motionAt('dusk-dawn', 0).joints).toMatchObject(ARM_STOWED)
    expect(motionAt('dusk-dawn', 0).lamp).toBe(0)
    const dusk = motionAt('dusk-dawn', 60 + ARM_SEQUENCE_S + 1)
    for (const [node, value] of Object.entries(ARM_NIGHT))
      expect(dusk.joints[node]).toBeCloseTo(value, 9)
    expect(motionAt('dusk-dawn', 900).lamp).toBeCloseTo(1, 1)
    expect(motionAt('dusk-dawn', d).joints).toMatchObject(ARM_STOWED)
    expect(motionAt('dusk-dawn', d).lamp).toBe(0)
  })
})
