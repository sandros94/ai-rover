import { describe, expect, it } from 'vitest'
import type { HeightGrid } from '#shared/utils/terrain'
import { reachableFrom, slopeAt, TerrainError, traversableMask } from '#shared/utils/terrain'

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
