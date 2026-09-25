import { describe, expect, it } from 'vitest'
import { checkLimits, DEFAULT_ROVER_GEOMETRY, poseOnTerrain } from '#shared/utils/rover'
import type { SegmentRecord } from '#shared/utils/drive'
import { driveSegment } from '#shared/utils/drive'
import { F, frame, revealedAfterStop, syntheticDisk, syntheticWorld, yawOf } from './helpers'

const TAN30 = Math.tan(Math.PI / 6)
const WALL_FOOT = -20

/**
 * A 2 m ridge with 30° flanks across x ∈ [−20, −10], `halfWidth` metres either side of y = 0,
 * its ends sloping down over 2 m.
 */
function ridge(halfWidth: number): (x: number, y: number) => number {
  return (x, y) => {
    const profile = Math.max(0, Math.min(2, TAN30 * (x - WALL_FOOT), TAN30 * (-10 - x)))
    const taper = Math.max(0, Math.min(1, (halfWidth - Math.abs(y)) / 2))
    return profile * taper
  }
}

const hidden = (x: number): boolean => x >= -22 && x <= -8

/** Keyframes that, re-solved at their planar pose, grade `fail`. */
function failingFrames(record: SegmentRecord, heightAt: (x: number, y: number) => number): number {
  const { keyframes } = record
  let failing = 0
  for (let k = 0; k < keyframes.count; k++) {
    const f = frame(keyframes, k)
    const pose = poseOnTerrain(heightAt, {
      x: f[F.x]!,
      y: f[F.y]!,
      headingRad: yawOf({ x: f[F.qx]!, y: f[F.qy]!, z: f[F.qz]!, w: f[F.qw]! }),
    })
    if (checkLimits(pose).level === 'fail') failing++
  }
  return failing
}

describe('driveSegment toward a hidden wall', () => {
  const start = { x: -60, y: 0, headingRad: 0 }
  const goal = { x: 60, y: 0 }

  describe.each([
    { label: 'seen by the per-metre viewshed', halfWidth: 50, revealRadiusM: 50 },
    { label: 'found by the lookahead probe', halfWidth: 5, revealRadiusM: 0.5 },
  ])('when $label', ({ halfWidth, revealRadiusM }) => {
    const world = syntheticWorld({ heightAt: ridge(halfWidth) })
    const disk = syntheticDisk(world, { hidden })
    const revealed = revealedAfterStop(world, disk)
    const { record, stats } = driveSegment(world, { disk, revealed, start, goal, revealRadiusM })

    it('first plans straight through the unseen ridge', () => {
      expect(record.plan.metrics.reached).toBe(true)
      expect(record.plan.polyline[0]).toEqual({ x: -60, y: 0 })
      expect(record.plan.polyline.at(-1)).toEqual({ x: 60, y: 0 })
      for (const point of record.plan.polyline) expect(point.y).toBe(0)
    })

    it('replans before reaching the wall and still arrives', () => {
      const replan = record.events.find((event) => event.type === 'replan')
      expect(replan).toBeDefined()
      expect(replan!.x).toBeLessThan(WALL_FOOT)
      expect(stats.replans).toBeGreaterThanOrEqual(1)
      expect(record.outcome.kind).toBe('arrived')
    })

    it('never stands in a failing pose', () => {
      expect(failingFrames(record, world.heightAt)).toBe(0)
    })
  })

  describe('when the wall spans the whole disk', () => {
    const world = syntheticWorld({ heightAt: ridge(1000) })
    const disk = syntheticDisk(world, { hidden })
    const revealed = revealedAfterStop(world, disk)
    const { record } = driveSegment(world, { disk, revealed, start, goal })

    it('stops short before the wall with a blocked event', () => {
      expect(record.outcome.kind).toBe('stopped-short')
      const blocked = record.events.find((event) => event.type === 'blocked')
      expect(blocked).toBeDefined()
      expect(blocked!.x).toBeLessThan(WALL_FOOT)
      expect(record.outcome.endPose.x).toBeLessThan(WALL_FOOT)
      expect(record.outcome.reasons.length).toBeGreaterThan(0)
    })

    it('never stands in a failing pose', () => {
      expect(failingFrames(record, world.heightAt)).toBe(0)
    })
  })
})

describe('driveSegment on a loose 14° ramp', () => {
  const tan14 = Math.tan((14 * Math.PI) / 180)
  const heightAt = (x: number): number => tan14 * x
  const drive = (loose: number): SegmentRecord => {
    const world = syntheticWorld({ heightAt, looseAt: () => loose })
    const disk = syntheticDisk(world)
    return driveSegment(world, {
      disk,
      revealed: revealedAfterStop(world, disk),
      start: { x: 0, y: 0, headingRad: 0 },
      goal: { x: 40, y: 0 },
    }).record
  }

  it('gets stuck within stuckAfterM + 1 m of commanded travel on fully loose ground', () => {
    const record = drive(1)
    expect(record.outcome.kind).toBe('failed')
    expect(record.outcome.reasons).toContain('stuck')
    expect(record.events.at(-1)?.type).toBe('stuck')
    expect(record.events.some((event) => event.type === 'slip')).toBe(true)
    const last = frame(record.keyframes, record.keyframes.count - 1)
    // Straight drive: the middle wheels roll exactly the commanded distance.
    const commanded = last[F.spinML]! * DEFAULT_ROVER_GEOMETRY.wheelRadius
    expect(commanded).toBeGreaterThanOrEqual(3)
    expect(commanded).toBeLessThanOrEqual(4)
    expect(record.outcome.distanceM).toBeLessThan(commanded)
  })

  it('arrives on firm ground', () => {
    const record = drive(0)
    expect(record.outcome.kind).toBe('arrived')
    expect(record.events.some((event) => event.type === 'slip')).toBe(false)
  })
})
