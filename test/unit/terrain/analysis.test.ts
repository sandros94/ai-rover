import { describe, expect, it } from 'vitest'
import type { HeightGrid } from '#shared/utils/terrain'
import {
  nearestTraversable,
  reachableFrom,
  slopeAt,
  TerrainError,
  traversableMask,
} from '#shared/utils/terrain'

function gridOf(width: number, height: number, fn: (i: number, j: number) => number): HeightGrid {
  const heights = new Float32Array(width * height)
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) heights[j * width + i] = fn(i, j)
  return { heights, width, height, cellSize: 1 }
}

describe('slopeAt', () => {
  it('measures the gradient magnitude with central and one-sided differences', () => {
    const ramp = gridOf(5, 5, (i, j) => 0.5 * i + 0.25 * j)
    expect(slopeAt(ramp, { i: 2, j: 2 })).toBeCloseTo(Math.hypot(0.5, 0.25), 6)
    expect(slopeAt(ramp, { i: 0, j: 0 })).toBeCloseTo(Math.hypot(0.5, 0.25), 6)
    expect(slopeAt(ramp, { i: 4, j: 4 })).toBeCloseTo(Math.hypot(0.5, 0.25), 6)
  })

  it('refuses a cell outside the grid', () => {
    expect(() =>
      slopeAt(
        gridOf(3, 3, () => 0),
        { i: 3, j: 0 },
      ),
    ).toThrow(TerrainError)
  })
})

describe('traversableMask', () => {
  it('marks a flat grid fully traversable', () => {
    const mask = traversableMask(
      gridOf(16, 16, () => 3),
      { slopeLimitDeg: 16 },
    )
    expect(mask.every((v) => v === 1)).toBe(true)
  })

  it('marks a 30° ramp untraversable', () => {
    const rise = Math.tan((30 * Math.PI) / 180)
    const mask = traversableMask(
      gridOf(16, 16, (i) => rise * i),
      { slopeLimitDeg: 16 },
    )
    expect(mask.every((v) => v === 0)).toBe(true)
  })

  it('refuses heights whose length does not match the grid', () => {
    expect(() =>
      traversableMask(
        { heights: new Float32Array(10), width: 4, height: 4, cellSize: 1 },
        { slopeLimitDeg: 16 },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_GRID' }))
  })
})

describe('reachableFrom', () => {
  it('stays on the start side of a wall', () => {
    const width = 20
    const height = 10
    const traversable = new Uint8Array(width * height).fill(1)
    for (let j = 0; j < height; j++) traversable[j * width + 10] = 0
    const reach = reachableFrom(traversable, { width, height, start: { i: 2, j: 5 } })
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) expect(reach[j * width + i]).toBe(i < 10 ? 1 : 0)
    }
  })

  it('crosses diagonal gaps (8-connected)', () => {
    const traversable = Uint8Array.from([1, 0, 0, 1])
    const reach = reachableFrom(traversable, { width: 2, height: 2, start: { i: 0, j: 0 } })
    expect([...reach]).toEqual([1, 0, 0, 1])
  })

  it('returns an empty mask when the start is not traversable', () => {
    const reach = reachableFrom(new Uint8Array(4), { width: 2, height: 2, start: { i: 1, j: 1 } })
    expect([...reach]).toEqual([0, 0, 0, 0])
  })

  it('refuses a start outside the grid', () => {
    expect(() =>
      reachableFrom(new Uint8Array(4), { width: 2, height: 2, start: { i: -1, j: 0 } }),
    ).toThrow(expect.objectContaining({ code: 'OUT_OF_BOUNDS' }))
  })
})

describe('nearestTraversable', () => {
  /** A width × height mask with the listed (i, j) cells set. */
  function maskOf(width: number, height: number, cells: [number, number][]): Uint8Array {
    const mask = new Uint8Array(width * height)
    for (const [i, j] of cells) mask[j * width + i] = 1
    return mask
  }

  it('returns the start when it is traversable', () => {
    const mask = maskOf(5, 5, [
      [2, 2],
      [1, 2],
    ])
    expect(
      nearestTraversable(mask, { width: 5, height: 5, start: { i: 2, j: 2 }, maxDistance: 3 }),
    ).toEqual({ i: 2, j: 2 })
  })

  it('steps off an untraversable start to the nearest neighbour, ties to the lowest (j, i)', () => {
    const mask = maskOf(7, 7, [
      [4, 3],
      [3, 4],
      [2, 3],
      [3, 2],
      [2, 2],
    ])
    expect(
      nearestTraversable(mask, { width: 7, height: 7, start: { i: 3, j: 3 }, maxDistance: 3 }),
    ).toEqual({ i: 3, j: 2 })
  })

  it('prefers a nearer vertex on an outer ring over a farther ring corner', () => {
    // (8, 8) sits on ring 3 but is 4.24 away; (9, 5) sits on ring 4 but is 4 away.
    const mask = maskOf(11, 11, [
      [8, 8],
      [9, 5],
    ])
    expect(
      nearestTraversable(mask, { width: 11, height: 11, start: { i: 5, j: 5 }, maxDistance: 5 }),
    ).toEqual({ i: 9, j: 5 })
  })

  it('ignores vertices beyond the distance limit and returns undefined without one', () => {
    const mask = maskOf(11, 11, [[9, 5]])
    expect(
      nearestTraversable(mask, { width: 11, height: 11, start: { i: 5, j: 5 }, maxDistance: 3.9 }),
    ).toBeUndefined()
    expect(
      nearestTraversable(mask, { width: 11, height: 11, start: { i: 5, j: 5 }, maxDistance: 4 }),
    ).toEqual({ i: 9, j: 5 })
    expect(
      nearestTraversable(new Uint8Array(25), {
        width: 5,
        height: 5,
        start: { i: 2, j: 2 },
        maxDistance: 10,
      }),
    ).toBeUndefined()
  })

  it('stays inside the grid when the start is near an edge', () => {
    const mask = maskOf(4, 4, [[3, 3]])
    expect(
      nearestTraversable(mask, { width: 4, height: 4, start: { i: 0, j: 0 }, maxDistance: 10 }),
    ).toEqual({ i: 3, j: 3 })
  })

  it('refuses a start outside the grid and a non-numeric limit', () => {
    expect(() =>
      nearestTraversable(new Uint8Array(9), {
        width: 3,
        height: 3,
        start: { i: 3, j: 0 },
        maxDistance: 1,
      }),
    ).toThrow(TerrainError)
    expect(() =>
      nearestTraversable(new Uint8Array(9), {
        width: 3,
        height: 3,
        start: { i: 1, j: 1 },
        maxDistance: Number.NaN,
      }),
    ).toThrow(TerrainError)
  })
})
