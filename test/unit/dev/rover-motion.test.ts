import { describe, expect, it } from 'vitest'
import { ARM_NIGHT, ARM_SEQUENCE_S, framePlacement } from '#shared/utils/client/scene'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'
import { ARM_STOWED, DEFAULT_ROVER_GEOMETRY } from '#shared/utils/rover'
import { MOTION_DEMOS, motionAt } from '~~/modules/dev/runtime/app/playground/rover-motion'

const DEG = Math.PI / 180
const duration = (id: string) => MOTION_DEMOS.find((d) => d.id === id)!.durationS
const spin = (frame: Float32Array, name: (typeof KEYFRAME_FIELDS)[number]) =>
  frame[KEYFRAME_FIELDS.indexOf(name)]!
const heading = (frame: Float32Array) => {
  const q = framePlacement(frame).quaternion
  return 2 * Math.atan2(q.z, q.w)
}

describe('the point turn', () => {
  const mid = motionAt('point-turn', duration('point-turn') / 2)

  it('steers the corners square to the line from the centre, the toe-in stance', () => {
    const { x, y } = DEFAULT_ROVER_GEOMETRY.frontWheel
    // The model steers right for a positive value: the front left toes in to the right.
    expect(mid.joints.steer_lf).toBeCloseTo(Math.atan(x / y), 6)
    expect(mid.joints.steer_rf).toBeCloseTo(-Math.atan(x / y), 6)
    expect(mid.joints.steer_lr! * mid.joints.steer_lf!).toBeLessThan(0)
  })

  it('turns the body in place, each side spinning the other way, then steers straight', () => {
    const start = motionAt('point-turn', 0)
    const end = motionAt('point-turn', duration('point-turn'))
    expect(framePlacement(end.frame).position.x).toBeCloseTo(0, 6)
    expect(heading(end.frame)).toBeCloseTo(90 * DEG, 5)
    expect(heading(start.frame)).toBe(0)
    for (const side of ['F', 'M', 'R'] as const) {
      expect(spin(mid.frame, `spin${side}L`)).toBeLessThan(0)
      expect(spin(mid.frame, `spin${side}R`)).toBeGreaterThan(0)
    }
    expect(end.joints.steer_lf).toBeCloseTo(0, 12)
  })
})

describe('the arc', () => {
  it('steers to double-Ackermann angles, drives round a centre 4 m to the left, each wheel at its radius', () => {
    const mid = motionAt('arc', duration('arc') / 2)
    const { x, y } = DEFAULT_ROVER_GEOMETRY.frontWheel
    expect(-mid.joints.steer_lf!).toBeCloseTo(Math.atan(x / (4 - y)), 6)
    expect(-mid.joints.steer_rf!).toBeCloseTo(Math.atan(x / (4 + y)), 6)
    const rear = DEFAULT_ROVER_GEOMETRY.rearWheel
    expect(-mid.joints.steer_lr!).toBeCloseTo(Math.atan(rear.x / (4 - rear.y)), 6)
    // The outer wheels roll further than the inner ones.
    expect(spin(mid.frame, 'spinMR')).toBeGreaterThan(spin(mid.frame, 'spinML'))
    expect(spin(mid.frame, 'spinFL')).toBeGreaterThan(spin(mid.frame, 'spinML'))
    const p = framePlacement(motionAt('arc', duration('arc')).frame).position
    expect(Math.hypot(p.x, p.y - 4)).toBeCloseTo(4, 5)
    expect(p.x).toBeGreaterThan(2)
  })
})

describe('the scripted rates', () => {
  /** Largest step between samples `dt` apart of each series, and the series at the ends. */
  function series(demo: 'point-turn' | 'arc', read: (t: number) => number, dt = 0.01) {
    const d = duration(demo)
    const at = Array.from({ length: Math.ceil(d / dt) + 1 }, (_, k) => read(k * dt))
    const rate = at.slice(1).map((v, k) => (v - at[k]!) / dt)
    const jumps = rate.slice(1).map((v, k) => Math.abs(v - rate[k]!) / dt)
    return { rate, maxAccel: Math.max(...jumps) }
  }

  it.each(['point-turn', 'arc'] as const)(
    'steers and turns from rest to rest, rates continuous: %s',
    (demo) => {
      const steer = series(demo, (t) => motionAt(demo, t).joints.steer_lf!)
      const turn = series(demo, (t) => heading(motionAt(demo, t).frame))
      for (const { rate, maxAccel } of [steer, turn]) {
        expect(Math.abs(rate[0]!)).toBeLessThan(1e-6)
        expect(Math.abs(rate.at(-1)!)).toBeLessThan(1e-6)
        // Bounded by the scripts' own peak accelerations, 8°/s² for steering.
        expect(maxAccel).toBeLessThan(8.1 * DEG)
      }
      // The steering has settled before the body turns, and starts back only once it stops (rates
      // under 0.006°/s being the instants either side of a switch).
      const moving = turn.rate.map((v) => Math.abs(v) > 1e-4)
      const steering = steer.rate.map((v) => Math.abs(v) > 1e-4)
      expect(moving.some((m, k) => m && steering[k])).toBe(false)
    },
  )

  it('peaks at 3°/s in the point turn and 4 cm/s along the arc', () => {
    const turn = series('point-turn', (t) => heading(motionAt('point-turn', t).frame))
    expect(Math.max(...turn.rate)).toBeCloseTo(3 * DEG, 4)
    const arc = series('arc', (t) => heading(motionAt('arc', t).frame))
    expect(Math.max(...arc.rate) * 4).toBeCloseTo(0.04, 4)
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
