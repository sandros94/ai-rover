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
