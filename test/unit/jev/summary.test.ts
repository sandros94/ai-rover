import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  compassPoint,
  detourLabel,
  looseGroundLabel,
  meanSlopeLabel,
  planSegment,
  slopeLabel,
  straightLineLabel,
  SubmissionSummarySchema,
  summarizeSubmission,
  unseenLabel,
} from '#shared/utils/nav'
import { syntheticDisk } from '../nav/helpers'

describe('summary labels', () => {
  it('bands the straight-line distance at 100 and 180 m', () => {
    expect(straightLineLabel(50)).toBe('short')
    expect(straightLineLabel(99.99)).toBe('short')
    expect(straightLineLabel(100)).toBe('medium')
    expect(straightLineLabel(179.99)).toBe('medium')
    expect(straightLineLabel(180)).toBe('long')
    expect(straightLineLabel(250)).toBe('long')
  })

  it('bands the detour ratio at 1.1 and 1.4', () => {
    expect(detourLabel(1)).toBe('nearly straight')
    expect(detourLabel(1.0999)).toBe('nearly straight')
    expect(detourLabel(1.1)).toBe('moderate detour')
    expect(detourLabel(1.3999)).toBe('moderate detour')
    expect(detourLabel(1.4)).toBe('long detour')
  })

  it('bands the steepest slope at 6 and 12 degrees and the mean at half of those', () => {
    expect(slopeLabel(5.99)).toBe('gentle')
    expect(slopeLabel(6)).toBe('moderate')
    expect(slopeLabel(11.99)).toBe('moderate')
    expect(slopeLabel(12)).toBe('near the limit')
    expect(meanSlopeLabel(2.99)).toBe('gentle')
    expect(meanSlopeLabel(3)).toBe('moderate')
    expect(meanSlopeLabel(5.99)).toBe('moderate')
    expect(meanSlopeLabel(6)).toBe('near the limit')
  })

  it('bands the unseen share at 0.2 and 0.6', () => {
    expect(unseenLabel(0)).toBe('mostly seen')
    expect(unseenLabel(0.1999)).toBe('mostly seen')
    expect(unseenLabel(0.2)).toBe('partly unseen')
    expect(unseenLabel(0.5999)).toBe('partly unseen')
    expect(unseenLabel(0.6)).toBe('mostly unseen')
  })

  it('bands the mean looseness at 0.3 and 0.6', () => {
    expect(looseGroundLabel(0.2999)).toBe('firm')
    expect(looseGroundLabel(0.3)).toBe('some loose ground')
    expect(looseGroundLabel(0.5999)).toBe('some loose ground')
    expect(looseGroundLabel(0.6)).toBe('mostly loose')
  })

  it('names the eight compass points with x east and y north', () => {
    const from = { x: 10, y: 10 }
    const at = (dx: number, dy: number) => compassPoint(from, { x: 10 + dx, y: 10 + dy })
    expect(at(0, 5)).toBe('north')
    expect(at(5, 5)).toBe('north-east')
    expect(at(5, 0)).toBe('east')
    expect(at(5, -5)).toBe('south-east')
    expect(at(0, -5)).toBe('south')
    expect(at(-5, -5)).toBe('south-west')
    expect(at(-5, 0)).toBe('west')
    expect(at(-5, 5)).toBe('north-west')
    // 22.5 degrees east of north rounds half away from north.
    expect(at(Math.tan(Math.PI / 8) * 5 - 1e-9, 5)).toBe('north')
    expect(at(Math.tan(Math.PI / 8) * 5 + 1e-9, 5)).toBe('north-east')
  })
})

describe('summarizeSubmission', () => {
  const size = 301
  const all = new Uint8Array(size * size).fill(1)
  const slopeLimitDeg = 16
  const firm = { looseAt: () => 0.1 }

  it('describes a straight, gentle, fully seen drive', () => {
    const disk = syntheticDisk({ size, radius: 150 })
    const start = { x: -60, y: 0 }
    const goal = { x: 60, y: 0 }
    const plan = planSegment(disk, { revealed: all, start, goal, slopeLimitDeg })
    const summary = summarizeSubmission(plan, { world: firm, disk, revealed: all, start, goal })
    expect(summary.destination).toEqual({
      straight_line_m: 120,
      straight_line_label: 'medium',
      bearing: 'east',
    })
    expect(summary.route).toEqual({
      reached: true,
      path_length_m: 120,
      detour_label: 'nearly straight',
      max_slope_deg: 0,
      max_slope_label: 'gentle',
      mean_slope_label: 'gentle',
      unseen_label: 'mostly seen',
      turns_in_place: 0,
      loose_ground_label: 'firm',
      estimated_drive_minutes: Math.round(120 / 0.033 / 60),
    })
    expect(summary.failure_reason).toBeUndefined()
    expect(summary.rover.limits).toContain('16 degrees')
    expect(v.is(SubmissionSummarySchema, summary)).toBe(true)
    expect(JSON.stringify(summary).length).toBeLessThan(1500)
  })

  it('reports slope and looseness over seen ground only', () => {
    // A 9-degree ramp everywhere, loose ground east of x = 0, and nothing seen east of x = 0.
    const tan = Math.tan((9 * Math.PI) / 180)
    const disk = syntheticDisk({ size, radius: 150, heightAt: (x) => (x < 0 ? x * tan : 0) })
    const revealed = new Uint8Array(size * size)
    const half = (size - 1) / 2
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) revealed[j * size + i] = i - half < 0 ? 1 : 0
    const world = { looseAt: (x: number) => (x < 0 ? 0.4 : 1) }
    const start = { x: -100, y: 0 }
    const goal = { x: 100, y: 0 }
    const plan = planSegment(disk, { revealed, start, goal, slopeLimitDeg })
    const summary = summarizeSubmission(plan, { world, disk, revealed, start, goal })
    expect(summary.route.reached).toBe(true)
    if (!summary.route.reached) return
    expect(summary.route.max_slope_deg).toBe(9)
    expect(summary.route.max_slope_label).toBe('moderate')
    expect(summary.route.mean_slope_label).toBe('near the limit')
    expect(summary.route.loose_ground_label).toBe('some loose ground')
    expect(summary.route.unseen_label).toBe('partly unseen')
    expect(summary.destination.straight_line_label).toBe('long')
  })

  it('describes an unreachable destination without path facts', () => {
    const disk = syntheticDisk({
      size,
      radius: 150,
      blocked: (x, y) => Math.hypot(x - 80, y - 80) < 6,
    })
    const start = { x: 0, y: 0 }
    const goal = { x: 80, y: 80 }
    const plan = planSegment(disk, { revealed: all, start, goal, slopeLimitDeg })
    const summary = summarizeSubmission(plan, { world: firm, disk, revealed: all, start, goal })
    expect(summary.route).toEqual({ reached: false })
    expect(summary.failure_reason).toMatch(/destination/)
    expect(summary.destination.bearing).toBe('north-east')
    expect(v.is(SubmissionSummarySchema, summary)).toBe(true)
  })

  it('refuses revealed bytes that do not match the disk grid', () => {
    const disk = syntheticDisk({ size, radius: 150 })
    const start = { x: -60, y: 0 }
    const goal = { x: 60, y: 0 }
    const plan = planSegment(disk, { revealed: all, start, goal, slopeLimitDeg })
    expect(() =>
      summarizeSubmission(plan, { world: firm, disk, revealed: new Uint8Array(4), start, goal }),
    ).toThrow(/revealed/)
  })
})
