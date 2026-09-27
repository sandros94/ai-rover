import { describe, expect, it } from 'vitest'
import type { HeightGrid } from '#shared/utils/terrain'
import { defineWorld, sampleHeights, viewshed } from '#shared/utils/terrain'

function gridOf(width: number, height: number, fn: (i: number, j: number) => number): HeightGrid {
  const heights = new Float32Array(width * height)
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) heights[j * width + i] = fn(i, j)
  return { heights, width, height, cellSize: 1 }
}

/** Accuracy oracle: bilinear samples every half cell along each ray, O(cells × radius). */
function naiveViewshed(
  grid: HeightGrid,
  vi: number,
  vj: number,
  mastHeight: number,
  radius: number,
): Uint8Array {
  const { heights, width, height, cellSize } = grid
  const sample = (x: number, y: number): number => {
    const x0 = Math.min(Math.floor(x), width - 2)
    const y0 = Math.min(Math.floor(y), height - 2)
    const fx = x - x0
    const fy = y - y0
    const h = (i: number, j: number): number => heights[j * width + i]!
    return (
      h(x0, y0) * (1 - fx) * (1 - fy) +
      h(x0 + 1, y0) * fx * (1 - fy) +
      h(x0, y0 + 1) * (1 - fx) * fy +
      h(x0 + 1, y0 + 1) * fx * fy
    )
  }
  const z0 = heights[vj * width + vi]! + mastHeight
  const out = new Uint8Array(width * height)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const dist = Math.hypot(i - vi, j - vj)
      if (dist > radius) continue
      if (dist === 0) {
        out[j * width + i] = 1
        continue
      }
      const target = (heights[j * width + i]! - z0) / (dist * cellSize)
      const steps = Math.ceil(dist * 2)
      let visible = true
      for (let s = 1; s < steps; s++) {
        const t = s / steps
        const tan = (sample(vi + (i - vi) * t, vj + (j - vj) * t) - z0) / (dist * t * cellSize)
        if (tan > target) {
          visible = false
          break
        }
      }
      out[j * width + i] = visible ? 1 : 0
    }
  }
  return out
}

describe('viewshed', () => {
  it('always sees the viewer cell', () => {
    const grid = gridOf(9, 9, () => 0)
    const seen = viewshed(grid, { viewer: { i: 4, j: 4 }, mastHeight: 0, radius: 4 })
    expect(seen[4 * 9 + 4]).toBe(1)
  })

  it('sees all of a flat plain within the radius and nothing beyond it', () => {
    const size = 41
    const seen = viewshed(
      gridOf(size, size, () => 0),
      { viewer: { i: 20, j: 20 }, mastHeight: 2, radius: 15 },
    )
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++)
        expect(seen[j * size + i]).toBe(Math.hypot(i - 20, j - 20) <= 15 ? 1 : 0)
    }
  })

  it('hides the far side of a ridge', () => {
    const size = 61
    const grid = gridOf(size, size, (i) => (i >= 35 && i <= 37 ? 10 : 0))
    const seen = viewshed(grid, { viewer: { i: 10, j: 30 }, mastHeight: 2, radius: 60 })
    expect(seen[30 * size + 35]).toBe(1)
    expect(seen[30 * size + 20]).toBe(1)
    for (let i = 39; i < size; i++) expect(seen[30 * size + i]).toBe(0)
  })

  it('agrees with the per-ray oracle on at least 98.5 % of a 200×200 generated terrain disk', () => {
    const size = 200
    const world = defineWorld({ seed: 'mars' })
    const grid: HeightGrid = {
      heights: sampleHeights(world, { originI: -100, originJ: -100, width: size, height: size }),
      width: size,
      height: size,
      cellSize: 1,
    }
    const radius = 99
    const fast = viewshed(grid, { viewer: { i: 100, j: 100 }, mastHeight: 2, radius })
    const oracle = naiveViewshed(grid, 100, 100, 2, radius)
    let inside = 0
    let seenOutside = 0
    let agree = 0
    let visible = 0
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const k = j * size + i
        if (Math.hypot(i - 100, j - 100) > radius) {
          if (fast[k]) seenOutside++
          continue
        }
        inside++
        if (fast[k] === oracle[k]) agree++
        if (oracle[k]) visible++
      }
    }
    expect(visible).toBeGreaterThan(inside * 0.05)
    expect(visible).toBeLessThan(inside * 0.95)
    expect(seenOutside).toBe(0)
    expect(agree / inside).toBeGreaterThanOrEqual(0.985)
  })

  it('with a revealed mask, never reads an unrevealed height and never sees an unrevealed vertex', () => {
    const size = 41
    // Revealed: the west half, and a far patch east of a band of unrevealed ground.
    const revealed = new Uint8Array(size * size)
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++)
        if (i <= 20 || (i >= 30 && j >= 15 && j <= 25)) revealed[j * size + i] = 1
    }
    const flat = gridOf(size, size, () => 0)
    // The same ground with a wall and pits, and a NaN, where nothing is revealed.
    const hidden = gridOf(size, size, (i, j) =>
      revealed[j * size + i] ? 0 : (i + j) % 3 === 0 ? 50 : -50,
    )
    hidden.heights[5 * size + 25] = Number.NaN
    const options = { viewer: { i: 10, j: 20 }, mastHeight: 2, radius: 40, revealed }
    const a = viewshed(flat, options)
    const b = viewshed(hidden, options)
    expect(Array.from(b)).toEqual(Array.from(a))
    expect(Array.from(a.keys()).filter((k) => a[k] && !revealed[k])).toEqual([])
    // The far patch shows through the unrevealed band: it blocks nothing.
    expect(a[20 * size + 35]).toBe(1)
  })

  it('with a revealed mask, sees nothing from an unrevealed viewer', () => {
    const revealed = new Uint8Array(81).fill(1)
    revealed[4 * 9 + 4] = 0
    const seen = viewshed(
      gridOf(9, 9, () => 0),
      { viewer: { i: 4, j: 4 }, mastHeight: 2, radius: 4, revealed },
    )
    expect(seen.every((v) => v === 0)).toBe(true)
  })

  it('refuses a revealed mask of the wrong length', () => {
    expect(() =>
      viewshed(
        gridOf(4, 4, () => 0),
        { viewer: { i: 1, j: 1 }, mastHeight: 2, radius: 3, revealed: new Uint8Array(15) },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_GRID' }))
  })

  it('refuses a viewer outside the grid', () => {
    expect(() =>
      viewshed(
        gridOf(4, 4, () => 0),
        { viewer: { i: 4, j: 0 }, mastHeight: 2, radius: 3 },
      ),
    ).toThrow(expect.objectContaining({ code: 'OUT_OF_BOUNDS' }))
  })
})
