import { describe, expect, it } from 'vitest'
import type { HeightGrid } from '#shared/utils/terrain'
import {
  FOG_FILL,
  FOG_GRAIN,
  HILLSHADE_EXAGGERATION,
  hillshade,
  liftSeen,
  LUMA,
  reliefPixels,
} from '#shared/utils/client/relief'
import { REVEAL_FADE_MS, revealTimes } from '#shared/utils/client/fog'

function grid(size: number, heightAt: (i: number, j: number) => number): HeightGrid {
  const heights = new Float32Array(size * size)
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) heights[j * size + i] = heightAt(i, j)
  return { heights, width: size, height: size, cellSize: 1 }
}

/** RGBA of grid vertex (i, j): rows run north to south in the image. */
function pixel(pixels: Uint8ClampedArray, g: HeightGrid, i: number, j: number): number[] {
  const p = ((g.height - 1 - j) * g.width + i) * 4
  return Array.from(pixels.subarray(p, p + 4))
}

const luma = ([r, g, b]: number[]) => LUMA[0] * r! + LUMA[1] * g! + LUMA[2] * b!

describe('hillshade', () => {
  it('darkens monotonically as a slope facing away from the light steepens', () => {
    // Rising to the north-west: the face looks south-east, away from the sun, lit until its
    // exaggerated slope passes the sun's 45° altitude.
    let previous = Infinity
    for (const rise of [0, 0.02, 0.05, 0.1, 0.15, 0.19]) {
      const g = grid(5, (i, j) => rise * (j - i))
      const shade = hillshade(g)[2 * 5 + 2]!
      expect(shade).toBeLessThan(previous)
      previous = shade
    }
  })

  it('applies the vertical exaggeration', () => {
    const gentle = grid(5, (i, j) => 0.04 * i - 0.03 * j)
    const steep = grid(5, (i, j) => HILLSHADE_EXAGGERATION * (0.04 * i - 0.03 * j))
    expect(hillshade(gentle)[12]).toBeCloseTo(hillshade(steep, 1)[12]!, 6)
    expect(hillshade(gentle, 1)[12]).not.toBeCloseTo(hillshade(gentle)[12]!, 3)
  })
})

describe('reliefPixels', () => {
  it('shades a flat grid uniformly and opaque', () => {
    const g = grid(9, () => 3)
    const pixels = reliefPixels(g)
    expect(pixels).toHaveLength(9 * 9 * 4)
    const first = pixel(pixels, g, 0, 0)
    expect(first[3]).toBe(255)
    for (let j = 0; j < 9; j++)
      for (let i = 0; i < 9; i++) expect(pixel(pixels, g, i, j)).toEqual(first)
  })

  it('tints higher ground lighter', () => {
    const g = grid(9, (i) => i)
    const pixels = reliefPixels(g, { hillshade: false })
    for (let i = 1; i < 9; i++)
      expect(luma(pixel(pixels, g, i, 4))).toBeGreaterThan(luma(pixel(pixels, g, i - 1, 4)))
  })

  it('lights a face turned to the north-west more than one turned to the south-east', () => {
    const northWest = grid(9, (i, j) => (i - j) * 0.3)
    const southEast = grid(9, (i, j) => (j - i) * 0.3)
    const lit = pixel(reliefPixels(northWest), northWest, 4, 4)
    const shadowed = pixel(reliefPixels(southEast), southEast, 4, 4)
    expect(luma(lit)).toBeGreaterThan(luma(shadowed) + 20)
  })

  it('leaves NaN vertices transparent', () => {
    const g = grid(5, (i, j) => (i === 0 && j === 0 ? Number.NaN : 1))
    const pixels = reliefPixels(g)
    expect(pixel(pixels, g, 0, 0)[3]).toBe(0)
    expect(pixel(pixels, g, 4, 4)[3]).toBe(255)
  })

  it('draws without the hillshade when asked, height ramp only', () => {
    const northWest = grid(9, (i, j) => (i - j) * 0.3)
    const southEast = grid(9, (i, j) => (j - i) * 0.3)
    const a = pixel(reliefPixels(northWest, { hillshade: false }), northWest, 4, 4)
    const b = pixel(reliefPixels(southEast, { hillshade: false }), southEast, 4, 4)
    expect(a).toEqual(b)
  })

  it('hides fogged ground: its pixels carry the fog texture and no relief', () => {
    // Revealed west of i = 8 only.
    const seen = new Uint8Array(16 * 16)
    for (let j = 0; j < 16; j++) for (let i = 0; i < 8; i++) seen[j * 16 + i] = 1
    const bumpy = grid(16, (i, j) => Math.sin(i) * 4 + Math.cos(j * 1.3) * 3)
    const flat = grid(16, () => 0)
    const fog = { seen, rgb: FOG_FILL.dark, seed: 7 }
    const a = reliefPixels(bumpy, { fog })
    const b = reliefPixels(flat, { fog })
    for (let j = 0; j < 16; j++) {
      for (let i = 8; i < 16; i++) {
        const p = pixel(a, bumpy, i, j)
        expect(p).toEqual(pixel(b, flat, i, j))
        expect(p[3]).toBe(255)
        for (let c = 0; c < 3; c++)
          expect(Math.abs(p[c]! - FOG_FILL.dark[c]!)).toBeLessThanOrEqual(
            FOG_FILL.dark[c]! * FOG_GRAIN + 1,
          )
      }
    }
    // Revealed ground well inside the edge still shows its relief.
    expect(pixel(a, bumpy, 2, 5)).toEqual(pixel(reliefPixels(bumpy), bumpy, 2, 5))
  })

  it('textures the fog with seeded noise, the same for the same seed', () => {
    const seen = new Uint8Array(64 * 64)
    const g = grid(64, () => 0)
    const one = reliefPixels(g, { fog: { seen, rgb: FOG_FILL.light, seed: 1 } })
    const again = reliefPixels(g, { fog: { seen, rgb: FOG_FILL.light, seed: 1 } })
    const other = reliefPixels(g, { fog: { seen, rgb: FOG_FILL.light, seed: 2 } })
    expect(Array.from(again)).toEqual(Array.from(one))
    expect(Array.from(other)).not.toEqual(Array.from(one))
    const lumas = new Set<number>()
    for (let k = 0; k < 64 * 64; k++) lumas.add(one[4 * k]!)
    expect(lumas.size).toBeGreaterThan(4)
  })

  it('fades a fresh reveal: half way through, half fog and half relief', () => {
    const g = grid(9, (i, j) => i * 0.4 + j * 0.2)
    const seen = new Uint8Array(81).fill(1)
    const revealedAt = revealTimes(seen)
    revealedAt[4 * 9 + 4] = 2000
    const clear = pixel(reliefPixels(g), g, 4, 4)
    const fogged = pixel(
      reliefPixels(g, { fog: { seen: new Uint8Array(81), rgb: FOG_FILL.dark, seed: 3 } }),
      g,
      4,
      4,
    )
    const fog = { seen, revealedAt, rgb: FOG_FILL.dark, seed: 3 }
    const mid = pixel(reliefPixels(g, { fog: { ...fog, now: 2000 + REVEAL_FADE_MS / 2 } }), g, 4, 4)
    for (let c = 0; c < 3; c++) expect(mid[c]).toBeCloseTo((clear[c]! + fogged[c]!) / 2, -0.5)
    const done = pixel(reliefPixels(g, { fog: { ...fog, now: 2000 + REVEAL_FADE_MS } }), g, 4, 4)
    expect(done).toEqual(clear)
  })

  it('paints only the asked rectangle into an existing buffer', () => {
    const g = grid(8, (i) => i)
    const into = new Uint8ClampedArray(8 * 8 * 4)
    const out = reliefPixels(g, { into, rect: { i0: 2, j0: 3, i1: 4, j1: 5 } })
    expect(out).toBe(into)
    const full = reliefPixels(g)
    expect(pixel(out, g, 2, 3)).toEqual(pixel(full, g, 2, 3))
    expect(pixel(out, g, 3, 4)).toEqual(pixel(full, g, 3, 4))
    expect(pixel(out, g, 4, 4)).toEqual([0, 0, 0, 0])
    expect(pixel(out, g, 2, 5)).toEqual([0, 0, 0, 0])
  })

  it('refuses a mask of the wrong length', () => {
    expect(() =>
      reliefPixels(
        grid(3, () => 0),
        { fog: { seen: new Uint8Array(4) } },
      ),
    ).toThrow(/9/)
  })
})

describe('liftSeen', () => {
  it('marks every revealed disk vertex as seen on a copy, ignoring indices past the grid', () => {
    const base = new Uint8Array([0, 1, 0, 0])
    const lifted = liftSeen(base, [{ vertices: [0] }, { vertices: new Uint32Array([3, 9]) }])
    expect(Array.from(lifted)).toEqual([1, 1, 0, 1])
    expect(Array.from(base)).toEqual([0, 1, 0, 0])
  })

  it('hands back the base itself when nothing is revealed', () => {
    const base = new Uint8Array(4)
    expect(liftSeen(base, [])).toBe(base)
  })
})
