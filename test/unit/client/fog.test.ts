import { describe, expect, it } from 'vitest'
import type { HeightGrid } from '#shared/utils/terrain'
import {
  FOG_EDGE_CELLS,
  fogCover,
  gridHeightAt,
  fogSurface,
  FOG_HEIGHT_RADIUS_M,
  REVEAL_FADE_MS,
  revealTimes,
  updateRevealTimes,
} from '#shared/utils/client/fog'

function grid(
  width: number,
  height: number,
  heightAt: (i: number, j: number) => number,
): HeightGrid {
  const heights = new Float32Array(width * height)
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) heights[j * width + i] = heightAt(i, j)
  return { heights, width, height, cellSize: 1 }
}

function mask(width: number, height: number, on: (i: number, j: number) => boolean): Uint8Array {
  const out = new Uint8Array(width * height)
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) out[j * width + i] = +on(i, j)
  return out
}

describe('revealTimes', () => {
  it('marks seen vertices as revealed long ago and unseen ones as fogged', () => {
    const times = revealTimes(new Uint8Array([1, 0]))
    expect(times[0]).toBe(-Infinity)
    expect(times[1]).toBeNaN()
  })

  it('stamps newly revealed vertices, re-fogs dropped ones and bounds the change', () => {
    const width = 6
    const times = revealTimes(mask(width, 4, (i) => i === 0))
    const next = mask(width, 4, (i, j) => i === 0 || (i === 3 && j === 1) || (i === 4 && j === 2))
    next[0] = 0
    const rect = updateRevealTimes(times, next, 500, width)
    expect(times[1 * width + 3]).toBe(500)
    expect(times[2 * width + 4]).toBe(500)
    expect(times[0]).toBeNaN()
    expect(times[width]).toBe(-Infinity)
    expect(rect).toEqual({ i0: 0, j0: 0, i1: 5, j1: 3 })
    expect(updateRevealTimes(times, next, 900, width)).toBeUndefined()
    expect(times[1 * width + 3]).toBe(500)
  })

  it('settles at once the newly revealed vertices flagged settled', () => {
    const width = 6
    const times = revealTimes(mask(width, 4, () => false))
    const next = mask(width, 4, (i, j) => j === 1 && (i === 2 || i === 3))
    const settled = mask(width, 4, (i, j) => j === 1 && i === 2)
    const rect = updateRevealTimes(times, next, 500, width, settled)
    expect(times[width + 2]).toBe(-Infinity)
    expect(times[width + 3]).toBe(500)
    expect(rect).toEqual({ i0: 2, j0: 1, i1: 4, j1: 2 })
    expect(() => updateRevealTimes(times, next, 900, width, new Uint8Array(3))).toThrow(
      /settled flags/,
    )
  })
})

describe('fogCover', () => {
  const size = { width: 12, height: 5 }
  // Revealed west of i = 6.
  const seen = mask(12, 5, (i) => i < 6)

  it('covers fogged vertices fully and clears revealed ground away from the edge', () => {
    const cover = fogCover({ seen }, size)
    expect(cover[2 * 12 + 8]).toBe(1)
    expect(cover[2 * 12 + 6]).toBe(1)
    expect(cover[2 * 12 + 1]).toBe(0)
  })

  it('softens the edge over the revealed side only, falling with distance', () => {
    const cover = fogCover({ seen }, size)
    const at = (i: number) => cover[2 * 12 + i]!
    expect(at(5)).toBeGreaterThan(at(4))
    expect(at(4)).toBeGreaterThan(at(6 - FOG_EDGE_CELLS - 1))
    expect(at(5)).toBeLessThan(1)
    expect(at(6 - FOG_EDGE_CELLS - 1)).toBe(0)
  })

  it('fades a fresh reveal: half covered half way through the fade', () => {
    const all = new Uint8Array(12 * 5).fill(1)
    const revealedAt = revealTimes(all)
    revealedAt[2 * 12 + 3] = 1000
    const cover = fogCover({ seen: all, revealedAt, now: 1000 + REVEAL_FADE_MS / 2 }, size)
    expect(cover[2 * 12 + 3]).toBeCloseTo(0.5, 6)
    const later = fogCover({ seen: all, revealedAt, now: 1000 + REVEAL_FADE_MS }, size)
    expect(later[2 * 12 + 3]).toBe(0)
  })

  it('leaves ground beyond the survey uncovered, with no soft edge towards it', () => {
    // The survey ends east of i = 6: seen ground meets the edge, not the fog.
    const inside = mask(12, 5, (i) => i < 6)
    const cover = fogCover({ seen }, size, { inside })
    for (let i = 0; i < 12; i++) expect(cover[2 * 12 + i]).toBe(0)
    // Fog within the survey still softens the seen ground beside it.
    const partly = mask(12, 5, (i) => i < 3)
    const fogged = fogCover({ seen: partly }, size, { inside })
    expect(fogged[2 * 12 + 4]).toBe(1)
    expect(fogged[2 * 12 + 2]).toBeGreaterThan(0)
    expect(fogged[2 * 12 + 8]).toBe(0)
  })

  it('computes a rectangle identically to the whole grid', () => {
    const full = fogCover({ seen }, size)
    const rect = { i0: 3, j0: 1, i1: 9, j1: 4 }
    const part = fogCover({ seen }, size, { rect })
    expect(part).toHaveLength(6 * 3)
    for (let j = 1; j < 4; j++)
      for (let i = 3; i < 9; i++) expect(part[(j - 1) * 6 + (i - 3)]).toBe(full[j * 12 + i])
  })
})

describe('fogSurface', () => {
  // A 100 × 9 strip, 1 m cells: revealed patch i < 10 at 10 m, true ground elsewhere wild.
  const width = 100
  const height = 9
  const g = grid(width, height, (i) => (i < 10 ? 10 : 50 + 20 * Math.sin(i)))
  const seen = mask(width, height, (i) => i < 10)

  it('keeps revealed vertices at their true height, and fogged ones hide theirs', () => {
    const { heights, amount } = fogSurface(g, { seen })
    expect(heights[4 * width + 5]).toBe(10)
    expect(amount[4 * width + 5]).toBe(0)
    // Within 24 m of the patch: its average; beyond, the revealed mean, also 10 here.
    expect(heights[4 * width + 20]).toBeCloseTo(10, 5)
    expect(heights[4 * width + 80]).toBeCloseTo(10, 5)
    expect(amount[4 * width + 20]).toBe(1)
  })

  it('averages the revealed ground within the radius, else falls back', () => {
    const sloped = grid(width, height, (i) => (i < 10 ? i : 99))
    const { heights } = fogSurface(sloped, { seen }, { fallback: -7 })
    // i = 30 sees revealed columns 6…9 within 24 m: their mean.
    expect(heights[4 * width + 30]).toBeCloseTo(7.5, 5)
    expect(heights[4 * width + 60]).toBe(-7)
  })

  it('blends across the edge band so the frontier has no cliff', () => {
    const sloped = grid(width, height, (i) => (i < 10 ? 3 * i : 99))
    const { heights } = fogSurface(sloped, { seen }, { fallback: 0 })
    const h = (i: number) => heights[4 * width + i]!
    const fogH = h(10 + FOG_EDGE_CELLS + 5) // past the band, the plain window average
    // Stepping out from the last revealed column (27 m), heights move monotonically to fogH.
    expect(h(9)).toBe(27)
    expect(h(10)).toBeLessThan(27)
    expect(h(10)).toBeGreaterThan(h(11))
    expect(Math.abs(h(10) - 27)).toBeLessThan(Math.abs(fogH - 27) / 2)
    expect(h(10 + FOG_EDGE_CELLS)).toBeCloseTo(fogH, 0)
  })

  it('rises from the fog to the true height during a reveal, and sits on it after', () => {
    const lifted = seen.slice()
    const k = 4 * width + 12
    lifted[k] = 1
    const revealedAt = revealTimes(seen)
    updateRevealTimes(revealedAt, lifted, 1000, width)
    const before = fogSurface(g, { seen }).heights[k]!
    const mid = fogSurface(g, { seen: lifted, revealedAt, now: 1000 + REVEAL_FADE_MS / 2 })
    expect(mid.amount[k]).toBeCloseTo(0.5, 6)
    expect(mid.heights[k]).toBeGreaterThan(Math.min(before, g.heights[k]!))
    expect(mid.heights[k]).toBeLessThan(Math.max(before, g.heights[k]!))
    const after = fogSurface(g, { seen: lifted, revealedAt, now: 1000 + REVEAL_FADE_MS })
    expect(after.heights[k]).toBe(g.heights[k])
    expect(after.amount[k]).toBe(0)
  })

  it('updates in place around a change identically to a full recompute', () => {
    const lifted = seen.slice()
    for (let j = 2; j < 6; j++) lifted[j * width + 10] = 1
    const into = fogSurface(g, { seen }, { fallback: 10 })
    const changed = { i0: 10, j0: 2, i1: 11, j1: 6 }
    const updated = fogSurface(g, { seen: lifted }, { fallback: 10, changed, into })
    expect(updated.heights).toBe(into.heights)
    // The written area reaches the averaging radius past the change, clamped to the grid.
    expect(updated.rect).toEqual({ i0: 0, j0: 0, i1: 11 + FOG_HEIGHT_RADIUS_M, j1: height })
    const full = fogSurface(g, { seen: lifted }, { fallback: 10 })
    for (let k = 0; k < width * height; k++) {
      expect(into.heights[k]).toBeCloseTo(full.heights[k]!, 4)
      expect(into.amount[k]).toBe(full.amount[k])
    }
  })
})

describe('gridHeightAt', () => {
  const place = { width: 3, height: 2, cellSize: 2, origin: { i: 5, j: -1 } }
  const heights = new Float32Array([0, 2, 4, 10, 12, Number.NaN])

  it('interpolates bilinearly in world metres', () => {
    expect(gridHeightAt(heights, place, 10, -2)).toBe(0)
    expect(gridHeightAt(heights, place, 11, -1)).toBeCloseTo(6, 6)
    expect(gridHeightAt(heights, place, 12, 0)).toBe(12)
  })

  it('is undefined off the grid or beside a missing height', () => {
    expect(gridHeightAt(heights, place, 9, -2)).toBeUndefined()
    expect(gridHeightAt(heights, place, 10, 1)).toBeUndefined()
    expect(gridHeightAt(heights, place, 13, -1)).toBeUndefined()
  })
})
