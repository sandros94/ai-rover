import { describe, expect, it } from 'vitest'
import type { GridCell } from '#shared/utils/terrain'
import { findRoute } from '#shared/utils/nav'
import { navErrorOf } from './helpers'

const W = 50
const H = 50

function grid(blocked: (i: number, j: number) => boolean = () => false): Float32Array {
  const costs = new Float32Array(W * H)
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) costs[j * W + i] = blocked(i, j) ? Infinity : 1
  return costs
}

function length(points: GridCell[]): number {
  let total = 0
  for (let k = 1; k < points.length; k++)
    total += Math.hypot(points[k]!.i - points[k - 1]!.i, points[k]!.j - points[k - 1]!.j)
  return total
}

describe('findRoute', () => {
  it('goes straight across an empty grid', () => {
    const start = { i: 3, j: 4 }
    const goal = { i: 45, j: 31 }
    const route = findRoute(grid(), { width: W, height: H, start, goal })
    expect(route.reached).toBe(true)
    expect(route.failureReason).toBeUndefined()
    expect(route.waypoints).toEqual([start, goal])
    const straight = Math.hypot(goal.i - start.i, goal.j - start.j)
    expect(length(route.waypoints)).toBeLessThanOrEqual(straight * 1.005)
    expect(route.expansions).toBeGreaterThan(0)
  })

  it('threads the single gap of a wall', () => {
    const wallI = 25
    const gapJ = 40
    const costs = grid((i, j) => i === wallI && j !== gapJ)
    const route = findRoute(costs, {
      width: W,
      height: H,
      start: { i: 5, j: 10 },
      goal: { i: 45, j: 10 },
    })
    expect(route.reached).toBe(true)
    let crossing: number | undefined
    for (let k = 1; k < route.waypoints.length; k++) {
      const a = route.waypoints[k - 1]!
      const b = route.waypoints[k]!
      if ((a.i - wallI) * (b.i - wallI) > 0 || a.i === b.i) continue
      crossing = a.j + ((wallI - a.i) / (b.i - a.i)) * (b.j - a.j)
    }
    expect(crossing).toBeDefined()
    expect(Math.abs(crossing! - gapJ)).toBeLessThanOrEqual(0.5)
    // Two legs to the gap and away from it. Theta* keeps waypoints on vertices and the gap's
    // wall cells are a cell thick, so it may run a little longer; beyond 2 % it wandered.
    const best = Math.hypot(20, 30) * 2
    expect(length(route.waypoints)).toBeLessThanOrEqual(best * 1.02)
  })

  it('reports an enclosed goal as unreachable', () => {
    const goal = { i: 40, j: 40 }
    const costs = grid((i, j) => Math.max(Math.abs(i - goal.i), Math.abs(j - goal.j)) === 3)
    const route = findRoute(costs, { width: W, height: H, start: { i: 2, j: 2 }, goal })
    expect(route).toMatchObject({
      reached: false,
      failureReason: 'goal-unreachable',
      waypoints: [],
    })
  })

  it('reports a blocked start or goal before searching', () => {
    const costs = grid((i, j) => (i === 2 && j === 2) || (i === 30 && j === 30))
    expect(
      findRoute(costs, { width: W, height: H, start: { i: 2, j: 2 }, goal: { i: 10, j: 10 } }),
    ).toEqual({
      reached: false,
      failureReason: 'start-blocked',
      waypoints: [],
      expansions: 0,
    })
    expect(
      findRoute(costs, { width: W, height: H, start: { i: 5, j: 5 }, goal: { i: 30, j: 30 } }),
    ).toEqual({
      reached: false,
      failureReason: 'goal-blocked',
      waypoints: [],
      expansions: 0,
    })
  })

  it('stops at the expansion cap', () => {
    const costs = grid((i, j) => i === 25 && j !== 48)
    const route = findRoute(costs, {
      width: W,
      height: H,
      start: { i: 5, j: 5 },
      goal: { i: 45, j: 5 },
      maxExpansions: 50,
    })
    expect(route).toMatchObject({
      reached: false,
      failureReason: 'expansion-cap',
      waypoints: [],
      expansions: 50,
    })
  })

  it('returns the start alone when it is the goal', () => {
    const route = findRoute(grid(), {
      width: W,
      height: H,
      start: { i: 7, j: 7 },
      goal: { i: 7, j: 7 },
    })
    expect(route.reached).toBe(true)
    expect(route.waypoints).toEqual([{ i: 7, j: 7 }])
  })

  it('is deterministic', () => {
    const costs = grid((i, j) => (i * 7 + j * 13) % 11 === 0)
    for (let k = 0; k < costs.length; k++)
      if (costs[k] === 1) costs[k] = 1 + ((k * 2654435761) % 97) / 50
    const options = { width: W, height: H, start: { i: 1, j: 1 }, goal: { i: 48, j: 46 } }
    const a = findRoute(costs, options)
    const b = findRoute(costs, options)
    expect(a.reached).toBe(true)
    expect(b).toEqual(a)
  })

  it('refuses malformed input', () => {
    const costs = grid()
    expect(
      navErrorOf(() =>
        findRoute(new Float32Array(10), {
          width: W,
          height: H,
          start: { i: 0, j: 0 },
          goal: { i: 1, j: 1 },
        }),
      )?.code,
    ).toBe('INVALID_INPUT')
    expect(
      navErrorOf(() =>
        findRoute(costs, { width: W, height: H, start: { i: -1, j: 0 }, goal: { i: 1, j: 1 } }),
      )?.code,
    ).toBe('INVALID_INPUT')
    expect(
      navErrorOf(() =>
        findRoute(costs, {
          width: W,
          height: H,
          start: { i: 0, j: 0 },
          goal: { i: 1, j: 1 },
          maxExpansions: 0,
        }),
      )?.code,
    ).toBe('INVALID_INPUT')
    const negative = grid()
    negative[3] = 0.5
    expect(
      navErrorOf(() =>
        findRoute(negative, { width: W, height: H, start: { i: 0, j: 0 }, goal: { i: 1, j: 1 } }),
      )?.code,
    ).toBe('INVALID_INPUT')
  })
})
