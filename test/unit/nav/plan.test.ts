import { describe, expect, it } from 'vitest'
import {
  computeStopDisk,
  createRevealedMask,
  defineWorld,
  revealDisk,
  revealedOverDisk,
} from '#shared/utils/terrain'
import { planSegment } from '#shared/utils/nav'
import { navErrorOf } from './helpers'

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
