import { describe, expect, it } from 'vitest'
import { ARM_JOINTS, ARM_STOWED } from '#shared/utils/rover'
import {
  ARM_JOINT_RATE,
  ARM_LEGS,
  ARM_NIGHT,
  ARM_SEQUENCE_S,
  ARM_UNSTOW,
  armPoseAlong,
  armPoseAt,
  armSequenceSeconds,
} from '#shared/utils/client/scene/night-arm'
import { sunCrossings } from '#shared/utils/client/scene/sun'
import { MARS_SOL_SECONDS } from '#shared/utils/client/instruments/sol-clock'

const second = 1 / MARS_SOL_SECONDS
const { rise, set } = sunCrossings()

describe('the arm unstow', () => {
  it('starts at the stowed pose and ends at the night pose', () => {
    expect(ARM_UNSTOW[0]).toEqual(ARM_STOWED)
    expect(ARM_UNSTOW.at(-1)).toEqual(ARM_NIGHT)
    expect(armPoseAlong(0)).toEqual(ARM_STOWED)
    expect(armPoseAlong(-5)).toEqual(ARM_STOWED)
    expect(armPoseAlong(ARM_SEQUENCE_S)).toEqual(ARM_NIGHT)
    expect(armPoseAlong(ARM_SEQUENCE_S + 5)).toEqual(ARM_NIGHT)
  })

  it('keeps every joint within its URDF limits, the legs being straight between waypoints within them', () => {
    for (const pose of ARM_UNSTOW) {
      for (const { node, limit } of ARM_JOINTS) {
        expect(pose[node]).toBeGreaterThanOrEqual(limit[0])
        expect(pose[node]).toBeLessThanOrEqual(limit[1])
      }
    }
  })

  it('turns the widest-moving joint of each leg at the joint rate, a few minutes in all', () => {
    for (const leg of ARM_LEGS) {
      const widest = Math.max(
        ...ARM_JOINTS.map(({ node }) => Math.abs(leg.to[node] - leg.from[node])),
      )
      expect(widest / leg.durationS).toBeCloseTo(ARM_JOINT_RATE, 12)
      // Mid-leg, every joint is on the straight line between the leg's ends.
      const mid = armPoseAlong(leg.startS + leg.durationS / 2)
      for (const { node } of ARM_JOINTS) {
        expect(mid[node]).toBeCloseTo((leg.from[node] + leg.to[node]) / 2, 12)
      }
    }
    expect(ARM_SEQUENCE_S).toBeGreaterThan(120)
    expect(ARM_SEQUENCE_S).toBeLessThan(600)
  })

  it('moves continuously: no joint jumps between two poses a second apart', () => {
    for (let t = 0; t <= ARM_SEQUENCE_S + 1; t += 1) {
      const a = armPoseAlong(t)
      const b = armPoseAlong(t + 1)
      for (const { node } of ARM_JOINTS) {
        expect(Math.abs(b[node] - a[node])).toBeLessThanOrEqual(ARM_JOINT_RATE + 1e-12)
      }
    }
  })
})

describe('armSequenceSeconds', () => {
  it('holds the arm stowed by day and raised by night', () => {
    expect(armSequenceSeconds(0.5)).toBe(0)
    expect(armSequenceSeconds(set - second)).toBe(0)
    expect(armSequenceSeconds(0)).toBe(ARM_SEQUENCE_S)
    expect(armSequenceSeconds(rise - second)).toBe(ARM_SEQUENCE_S)
    expect(armPoseAt(0.5)).toEqual(ARM_STOWED)
    expect(armPoseAt(0)).toEqual(ARM_NIGHT)
  })

  it('runs forward from sunset and backward from sunrise, one sol second per second', () => {
    const steps = Math.ceil(ARM_SEQUENCE_S) + 2
    const dusk = Array.from({ length: steps }, (_, k) => armSequenceSeconds(set + k * second))
    const dawn = Array.from({ length: steps }, (_, k) => armSequenceSeconds(rise + k * second))
    dusk.slice(1).forEach((v, k) => expect(v).toBeGreaterThanOrEqual(dusk[k]!))
    dawn.slice(1).forEach((v, k) => expect(v).toBeLessThanOrEqual(dawn[k]!))
    expect(dusk[10]).toBeCloseTo(10, 6)
    expect(dawn[10]).toBeCloseTo(ARM_SEQUENCE_S - 10, 6)
  })

  it('stows at dawn by the exact mirror of the unstow at dusk', () => {
    for (let s = 0; s <= ARM_SEQUENCE_S; s += 7) {
      const dawn = armSequenceSeconds(rise + s * second)
      expect(armPoseAt(rise + s * second)).toEqual(armPoseAlong(dawn))
      expect(dawn).toBeCloseTo(ARM_SEQUENCE_S - armSequenceSeconds(set + s * second), 6)
      const dusk = armPoseAt(set + (ARM_SEQUENCE_S - s) * second)
      const back = armPoseAt(rise + s * second)
      for (const { node } of ARM_JOINTS) expect(back[node]).toBeCloseTo(dusk[node], 6)
    }
  })

  it('reads any sol fraction, whole sols included', () => {
    expect(armSequenceSeconds(3.5)).toBe(0)
    expect(armSequenceSeconds(-0.1)).toBe(armSequenceSeconds(0.9))
  })
})
