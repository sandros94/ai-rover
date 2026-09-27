import { describe, expect, it } from 'vitest'
import { currentSight, EYE_SNAP_CELLS, maskChange } from '#shared/utils/client/sight'
import type { HeightGrid } from '#shared/utils/terrain'

function grid(size: number, heightAt: (i: number, j: number) => number): HeightGrid {
  const heights = new Float32Array(size * size)
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) heights[j * size + i] = heightAt(i, j)
  return { heights, width: size, height: size, cellSize: 1 }
}

/** Vertices in sight that are not revealed. */
const leaks = (sight: Uint8Array, revealed: Uint8Array) =>
  Array.from(sight.keys()).filter((k) => sight[k] && !revealed[k])

const all = (size: number) => new Uint8Array(size * size).fill(1)
const OPTIONS = { mastHeight: 2, radiusM: 15 }

/** Deterministic [0, 1) numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('currentSight', () => {
  it('sees every revealed vertex of flat ground within the radius, and nothing past it', () => {
    const size = 41
    const sight = currentSight(
      grid(size, () => 0),
      all(size),
      { i: 20, j: 20 },
      OPTIONS,
    )
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++)
        expect(sight[j * size + i]).toBe(Math.hypot(i - 20, j - 20) <= 15 ? 1 : 0)
    }
  })

  it('reads the radius in metres over the cell size', () => {
    const size = 41
    const coarse = { ...grid(size, () => 0), cellSize: 2 }
    const sight = currentSight(coarse, all(size), { i: 20, j: 20 }, OPTIONS)
    expect(sight[20 * size + 27]).toBe(1)
    expect(sight[20 * size + 28]).toBe(0)
  })

  it('hides the far side of a ridge', () => {
    const size = 61
    const g = grid(size, (i) => (i >= 35 && i <= 37 ? 10 : 0))
    const sight = currentSight(g, all(size), { i: 10, j: 30 }, { mastHeight: 2, radiusM: 60 })
    expect(sight[30 * size + 20]).toBe(1)
    expect(sight[30 * size + 35]).toBe(1)
    for (let i = 39; i < size; i++) expect(sight[30 * size + i]).toBe(0)
  })

  it('never marks an unrevealed vertex in sight, whatever the heights', () => {
    const size = 33
    const next = random(42)
    for (let trial = 0; trial < 40; trial++) {
      const g = grid(size, () => (next() - 0.5) * 40 * next())
      const revealed = new Uint8Array(size * size).map(() => (next() < 0.6 ? 1 : 0))
      const eye = { i: Math.floor(next() * size), j: Math.floor(next() * size) }
      const sight = currentSight(g, revealed, eye, { mastHeight: 2, radiusM: 30 })
      expect(sight).toHaveLength(size * size)
      expect(leaks(sight, revealed)).toEqual([])
    }
  })

  it('lets unrevealed ground hide nothing, whatever lies there', () => {
    const size = 41
    const revealed = all(size)
    for (let j = 0; j < size; j++) for (let i = 22; i <= 26; i++) revealed[j * size + i] = 0
    const wall = grid(size, (i) => (i >= 22 && i <= 26 ? 100 : 0))
    const sight = currentSight(wall, revealed, { i: 10, j: 20 }, { mastHeight: 2, radiusM: 30 })
    expect(sight[20 * size + 30]).toBe(1)
    expect(sight[20 * size + 24]).toBe(0)
  })

  it('treats ground with no height yet as neither seen nor hiding', () => {
    const size = 41
    const g = grid(size, (i) => (i >= 22 && i <= 26 ? Number.NaN : 0))
    const sight = currentSight(g, all(size), { i: 10, j: 20 }, { mastHeight: 2, radiusM: 30 })
    expect(sight[20 * size + 24]).toBe(0)
    expect(sight[20 * size + 30]).toBe(1)
  })

  it('stands an eye on unrevealed ground on the nearest revealed vertex beside it', () => {
    const size = 41
    const revealed = all(size)
    revealed[20 * size + 20] = 0
    const g = grid(size, () => 0)
    const sight = currentSight(g, revealed, { i: 20, j: 20 }, OPTIONS)
    expect(sight[20 * size + 20]).toBe(0)
    expect(sight[20 * size + 30]).toBe(1)
    expect(leaks(sight, revealed)).toEqual([])
  })

  it('sees nothing from an eye with no revealed ground within reach', () => {
    const size = 41
    const revealed = new Uint8Array(size * size)
    // Revealed ground, but farther from the eye than it looks for ground to stand on.
    for (let j = 0; j < size; j++) for (let i = 0; i < 10; i++) revealed[j * size + i] = 1
    const eye = { i: 10 + EYE_SNAP_CELLS + 1, j: 20 }
    const sight = currentSight(
      grid(size, () => 0),
      revealed,
      eye,
      OPTIONS,
    )
    expect(sight.every((v) => v === 0)).toBe(true)
  })

  it('sees nothing from an eye off the grid', () => {
    const sight = currentSight(
      grid(9, () => 0),
      all(9),
      { i: -10, j: 4 },
      OPTIONS,
    )
    expect(sight.every((v) => v === 0)).toBe(true)
  })
})

describe('maskChange', () => {
  it('bounds every vertex that differs', () => {
    const before = new Uint8Array(6 * 5)
    const after = before.slice()
    after[1 * 6 + 4] = 1
    after[3 * 6 + 2] = 1
    expect(maskChange(before, after, 6)).toEqual({ i0: 2, j0: 1, i1: 5, j1: 4 })
  })

  it('is undefined when nothing differs', () => {
    const mask = new Uint8Array(12).fill(1)
    expect(maskChange(mask, mask.slice(), 4)).toBeUndefined()
  })

  it('refuses masks of different grids', () => {
    expect(() => maskChange(new Uint8Array(4), new Uint8Array(6), 2)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })
})
