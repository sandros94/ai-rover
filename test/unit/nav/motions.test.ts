import { describe, expect, it } from 'vitest'
import type { Motion } from '#shared/utils/nav'
import { motionsFromPolyline } from '#shared/utils/nav'
import { navErrorOf } from './helpers'

interface Pose {
  x: number
  y: number
  heading: number
}

/** Advances a pose through turns in place and constant-curvature arcs. */
function integrate(motions: Motion[], start: Pose): Pose {
  let { x, y, heading } = start
  for (const motion of motions) {
    if (motion.type === 'turn') {
      heading += motion.angleRad
      continue
    }
    const { lengthM, curvature } = motion
    if (curvature === 0) {
      x += lengthM * Math.cos(heading)
      y += lengthM * Math.sin(heading)
    } else {
      const next = heading + curvature * lengthM
      x += (Math.sin(next) - Math.sin(heading)) / curvature
      y -= (Math.cos(next) - Math.cos(heading)) / curvature
      heading = next
    }
  }
  return { x, y, heading }
}

function polylineLength(points: { x: number; y: number }[]): number {
  let total = 0
  for (let k = 1; k < points.length; k++)
    total += Math.hypot(points[k]!.x - points[k - 1]!.x, points[k]!.y - points[k - 1]!.y)
  return total
}

function motionLength(motions: Motion[]): number {
  return motions.reduce((sum, m) => sum + (m.type === 'arc' ? m.lengthM : 0), 0)
}

describe('motionsFromPolyline', () => {
  it('turns in place at a right angle', () => {
    const motions = motionsFromPolyline([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ])
    expect(motions).toEqual([
      { type: 'arc', lengthM: 10, curvature: 0 },
      { type: 'turn', angleRad: Math.PI / 2 },
      { type: 'arc', lengthM: 10, curvature: 0 },
    ])
  })

  it('blends a shallow bend with an arc of the blend radius', () => {
    const bend = (20 * Math.PI) / 180
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10 + 10 * Math.cos(bend), y: -10 * Math.sin(bend) },
    ]
    const motions = motionsFromPolyline(points)
    expect(motions.map((m) => m.type)).toEqual(['arc', 'arc', 'arc'])
    const curve = motions[1] as Extract<Motion, { type: 'arc' }>
    expect(curve.curvature).toBeCloseTo(-1 / 2, 12)
    expect(curve.lengthM).toBeCloseTo(2 * bend, 12)
    expect(motions.filter((m) => m.type === 'turn')).toHaveLength(0)
  })

  it('turns in place when the blend radius exceeds half the shorter segment', () => {
    const bend = (20 * Math.PI) / 180
    const motions = motionsFromPolyline([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3 + 10 * Math.cos(bend), y: 10 * Math.sin(bend) },
    ])
    expect(motions.map((m) => m.type)).toEqual(['arc', 'turn', 'arc'])
  })

  it('turns first to the path when an initial heading is given', () => {
    const motions = motionsFromPolyline(
      [
        { x: 0, y: 0 },
        { x: 0, y: 5 },
      ],
      { initialHeadingRad: 0 },
    )
    expect(motions).toEqual([
      { type: 'turn', angleRad: Math.PI / 2 },
      { type: 'arc', lengthM: 5, curvature: 0 },
    ])
  })

  it('keeps total length within 1 % and reproduces the end point', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 12, y: 1 },
      { x: 25, y: 5 },
      { x: 30, y: 20 },
      { x: 44, y: 24 },
      { x: 60, y: 22 },
      { x: 61, y: 40 },
    ]
    const heading = Math.atan2(1, 12)
    const motions = motionsFromPolyline(points)
    expect(motions.some((m) => m.type === 'turn')).toBe(true)
    expect(motions.some((m) => m.type === 'arc' && m.curvature !== 0)).toBe(true)
    const total = polylineLength(points)
    expect(Math.abs(motionLength(motions) - total) / total).toBeLessThan(0.01)
    const end = integrate(motions, { x: 0, y: 0, heading })
    expect(Math.hypot(end.x - 61, end.y - 40)).toBeLessThan(0.05)
  })

  it('returns nothing for a single point and drops repeated points', () => {
    expect(motionsFromPolyline([{ x: 1, y: 1 }])).toEqual([])
    expect(
      motionsFromPolyline([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ]),
    ).toEqual([{ type: 'arc', lengthM: 4, curvature: 0 }])
  })

  it('refuses malformed input', () => {
    expect(navErrorOf(() => motionsFromPolyline([]))?.code).toBe('INVALID_INPUT')
    expect(navErrorOf(() => motionsFromPolyline([{ x: Number.NaN, y: 0 }]))?.code).toBe(
      'INVALID_INPUT',
    )
    expect(navErrorOf(() => motionsFromPolyline([{ x: 0, y: 0 }], { blendRadiusM: 0 }))?.code).toBe(
      'INVALID_INPUT',
    )
    expect(
      navErrorOf(() => motionsFromPolyline([{ x: 0, y: 0 }], { turnInPlaceAboveRad: -1 }))?.code,
    ).toBe('INVALID_INPUT')
  })
})
