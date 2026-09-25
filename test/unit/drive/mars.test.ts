import { describe, expect, it } from 'vitest'
import { computeStopDisk, defineWorld, revealedOverDisk } from '#shared/utils/terrain'
import { mulberry32 } from '#shared/utils/terrain/seed'
import { DEFAULT_ROVER_GEOMETRY, poseOnTerrain } from '#shared/utils/rover'
import { driveSegment, interpolatePose } from '#shared/utils/drive'
import { wheelsFromPose } from '../rover/helpers'
import { F, frame, poseOfFrame, revealedAfterStop, yawOf } from './helpers'

const world = defineWorld({ seed: 'mars' })
const disk = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 500 })
const revealed = revealedAfterStop(world, disk)
const options = {
  disk,
  revealed,
  start: { x: 0, y: 0, headingRad: 0 },
  goal: { x: 120, y: 90 },
  revealRadiusM: 50,
}
const { record } = driveSegment(world, options)
const { keyframes, outcome } = record
const r = DEFAULT_ROVER_GEOMETRY.wheelRadius

describe('driveSegment on seed mars, 150 m', () => {
  it('ends in one of the three outcomes', () => {
    expect(['arrived', 'stopped-short', 'failed']).toContain(outcome.kind)
    expect(outcome.distanceM).toBeGreaterThan(0)
    expect(keyframes.count).toBeGreaterThan(1)
  })

  it('is deterministic', () => {
    expect(driveSegment(world, options).record).toEqual(record)
  })

  it('stores frames that re-solve to the same pose', () => {
    let worst = 0
    for (let k = 0; k < keyframes.count; k++) {
      const f = frame(keyframes, k)
      const q = { x: f[F.qx]!, y: f[F.qy]!, z: f[F.qz]!, w: f[F.qw]! }
      const pose = poseOnTerrain(world.heightAt, { x: f[F.x]!, y: f[F.y]!, headingRad: yawOf(q) })
      const pairs: [number, number][] = [
        [pose.position.z, f[F.z]!],
        [pose.quaternion.x, q.x],
        [pose.quaternion.y, q.y],
        [pose.quaternion.z, q.z],
        [pose.quaternion.w, q.w],
        [pose.rocker.left, f[F.rockerL]!],
        [pose.rocker.right, f[F.rockerR]!],
        [pose.bogie.left, f[F.bogieL]!],
        [pose.bogie.right, f[F.bogieR]!],
      ]
      for (const [solved, stored] of pairs) worst = Math.max(worst, Math.abs(solved - stored))
    }
    expect(worst).toBeLessThan(1e-5)
  })

  it('reveals each vertex once, near the rover, never one already revealed', () => {
    const { width, cellSize } = disk.grid
    const before = revealedOverDisk(revealed, disk)
    const seen = new Set<number>()
    let last = -Infinity
    for (const { t, vertices } of record.reveals) {
      expect(t).toBeGreaterThanOrEqual(last)
      last = t
      const f = frame(keyframes, Math.min(keyframes.count - 1, Math.round(t * keyframes.hz)))
      for (const k of vertices) {
        expect(seen.has(k)).toBe(false)
        expect(before[k]).toBe(0)
        seen.add(k)
        const i = k % width
        const x = (disk.origin.i + i) * cellSize
        const y = (disk.origin.j + (k - i) / width) * cellSize
        expect(Math.hypot(x - f[F.x]!, y - f[F.y]!)).toBeLessThanOrEqual(options.revealRadiusM + 1)
      }
    }
    expect(seen.size).toBeGreaterThan(0)
  })
})

describe('interpolatePose on the mars drive', () => {
  const random = mulberry32(7)
  const samples = Array.from({ length: 500 }, () => random() * outcome.durationS)

  it('keeps interpolated wheels within 3 cm of a re-solved pose at 2 Hz', () => {
    let worstWheel = 0
    let worstGround = 0
    for (const t of samples) {
      const tuple = interpolatePose(keyframes, t)
      expect(tuple[F.t]).toBeCloseTo(t, 3)
      const drawn = poseOfFrame(tuple)
      const solved = poseOnTerrain(world.heightAt, {
        x: tuple[F.x]!,
        y: tuple[F.y]!,
        headingRad: drawn.headingRad,
      })
      const wheels = wheelsFromPose(drawn, DEFAULT_ROVER_GEOMETRY)
      for (const [k, wheel] of wheels.entries()) {
        worstWheel = Math.max(worstWheel, Math.abs(wheel.z - solved.wheels[k]!.z))
        worstGround = Math.max(
          worstGround,
          Math.abs(wheel.z - r - world.heightAt(wheel.x, wheel.y)),
        )
        const contact = solved.contacts[k]!
        expect(Math.abs(contact.z - world.heightAt(contact.x, contact.y))).toBeLessThan(1e-9)
      }
    }
    expect(worstWheel).toBeLessThan(0.03)
    expect(worstGround).toBeLessThan(0.03)
  })

  it('clamps to the first and last frames', () => {
    expect(interpolatePose(keyframes, -5)).toEqual(frame(keyframes, 0))
    expect(interpolatePose(keyframes, outcome.durationS + 100)).toEqual(
      frame(keyframes, keyframes.count - 1),
    )
  })
})
