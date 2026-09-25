import { describe, expect, it } from 'vitest'
import {
  computeStopDisk,
  createRevealedMask,
  defineWorld,
  revealDisk,
  revealedOverDisk,
} from '#shared/utils/terrain'
import { planSegment } from '#shared/utils/nav'
import { navErrorOf, syntheticDisk } from './helpers'

const world = defineWorld({ seed: 'mars' })
const disk = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 300 })
const revealed = revealedOverDisk(revealDisk(createRevealedMask(world), disk), disk)
const slopeLimitDeg = world.config.slopeLimitDeg
const options = { revealed, start: { x: 0, y: 0 }, goal: { x: 120, y: 90 }, slopeLimitDeg }

describe('planSegment', () => {
  const plan = planSegment(disk, options)

  it('reaches a goal 150 m away with sane metrics', () => {
    const { metrics } = plan
    expect(plan.route.reached).toBe(true)
    expect(metrics.reached).toBe(true)
    expect(metrics.failureReason).toBeUndefined()
    expect(metrics.straightLineM).toBeCloseTo(150, 5)
    expect(metrics.pathLengthM).toBeGreaterThanOrEqual(metrics.straightLineM)
    expect(metrics.detourRatio).toBeGreaterThanOrEqual(1)
    expect(metrics.detourRatio).toBeCloseTo(metrics.pathLengthM / metrics.straightLineM, 12)
    expect(metrics.unrevealedFraction).toBeGreaterThanOrEqual(0)
    expect(metrics.unrevealedFraction).toBeLessThanOrEqual(1)
    expect(metrics.maxSlopeDeg).toBeLessThanOrEqual(slopeLimitDeg + 1)
    expect(metrics.meanSlopeDeg).toBeGreaterThan(0)
    expect(metrics.meanSlopeDeg).toBeLessThanOrEqual(metrics.maxSlopeDeg)
    expect(metrics.expansions).toBe(plan.route.expansions)
    expect(metrics.turnCount).toBe(plan.motions.filter((m) => m.type === 'turn').length)
    expect(metrics.computeMs).toBeGreaterThanOrEqual(0)
  })

  it('returns a world-metre polyline from the start vertex to the goal vertex', () => {
    expect(plan.polyline[0]).toEqual({ x: 0, y: 0 })
    expect(plan.polyline.at(-1)).toEqual({ x: 120, y: 90 })
    expect(plan.polyline).toHaveLength(plan.route.waypoints.length)
    const arcs = plan.motions.reduce((sum, m) => sum + (m.type === 'arc' ? m.lengthM : 0), 0)
    expect(Math.abs(arcs - plan.metrics.pathLengthM) / plan.metrics.pathLengthM).toBeLessThan(0.01)
  })

  it('is deterministic', () => {
    const again = planSegment(disk, options)
    expect(again.route).toEqual(plan.route)
    expect(again.polyline).toEqual(plan.polyline)
    expect(again.motions).toEqual(plan.motions)
    expect({ ...again.metrics, computeMs: 0 }).toEqual({ ...plan.metrics, computeMs: 0 })
  })

  it('refuses a goal outside the disk', () => {
    const error = navErrorOf(() => planSegment(disk, { ...options, goal: { x: 400, y: 0 } }))
    expect(error?.code).toBe('OUT_OF_DISK')
    expect(error?.message).toContain('400')
  })

  it('refuses a revealed mask of the wrong size', () => {
    expect(
      navErrorOf(() => planSegment(disk, { ...options, revealed: new Uint8Array(4) }))?.code,
    ).toBe('INVALID_INPUT')
  })
})

describe('planSegment slope metrics', () => {
  // Flat ground with a 5-degree ramp west of the centre, seen, and a 12-degree ramp east of it,
  // unseen. Unseen ground plans as flat, so the route runs straight across both.
  const size = 301
  const tanOf = (deg: number) => Math.tan((deg * Math.PI) / 180)
  const heightAt = (x: number) =>
    Math.min(Math.max(x + 60, 0), 40) * tanOf(5) + Math.min(Math.max(x - 20, 0), 40) * tanOf(12)
  const disk = syntheticDisk({ size, radius: 150, heightAt })
  const half = (size - 1) / 2
  const seenExcept = (unseen: (x: number) => boolean) => {
    const bytes = new Uint8Array(size * size)
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) bytes[j * size + i] = unseen(i - half) ? 0 : 1
    return bytes
  }
  const start = { x: -100, y: 0 }
  const goal = { x: 100, y: 0 }

  it('reports only the slopes of revealed ground', () => {
    const revealed = seenExcept((x) => x >= 10 && x <= 70)
    const { metrics } = planSegment(disk, { revealed, start, goal, slopeLimitDeg })
    expect(metrics.reached).toBe(true)
    expect(metrics.pathLengthM).toBe(200)
    expect(metrics.unrevealedFraction).toBeGreaterThan(0.25)
    expect(metrics.maxSlopeDeg).toBeCloseTo(5, 3)
    // 40 m of 5 degrees over about 140 m of seen path.
    expect(metrics.meanSlopeDeg).toBeGreaterThan(1.2)
    expect(metrics.meanSlopeDeg).toBeLessThan(1.8)
  })

  it('reports the steep ramp once it is revealed', () => {
    const revealed = seenExcept(() => false)
    const { metrics } = planSegment(disk, { revealed, start, goal, slopeLimitDeg })
    expect(metrics.maxSlopeDeg).toBeCloseTo(12, 3)
  })

  it('reports zero slopes when the path crosses no revealed vertex', () => {
    const revealed = seenExcept(() => true)
    const { metrics } = planSegment(disk, { revealed, start, goal, slopeLimitDeg })
    expect(metrics.reached).toBe(true)
    expect(metrics.unrevealedFraction).toBe(1)
    expect(metrics.maxSlopeDeg).toBe(0)
    expect(metrics.meanSlopeDeg).toBe(0)
  })
})
