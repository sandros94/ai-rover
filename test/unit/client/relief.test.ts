import { describe, expect, it } from 'vitest'
import type { HeightGrid } from '#shared/utils/terrain'
import { FOG_DIM, LUMA, reliefPixels } from '#shared/utils/client/relief'

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

  it('lights a face turned to the north-west more than one turned to the south-east', () => {
    // Rising east and south: the face looks north-west, towards the light.
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

  it('dims unseen vertices by FOG_DIM and greys them, without hiding them', () => {
    const g = grid(5, (i, j) => i * 0.2 + j * 0.1)
    const seen = new Uint8Array(25).fill(1)
    seen[2 * 5 + 2] = 0
    const clear = reliefPixels(g)
    const fogged = reliefPixels(g, { seen })
    const before = pixel(clear, g, 2, 2)
    const after = pixel(fogged, g, 2, 2)
    expect(after[3]).toBe(255)
    expect(Math.abs(luma(after) - FOG_DIM * luma(before))).toBeLessThan(1.5)
    const spread = (c: number[]) => Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!)
    expect(spread(after)).toBeLessThan(FOG_DIM * spread(before))
    expect(pixel(fogged, g, 1, 1)).toEqual(pixel(clear, g, 1, 1))
  })

  it('draws without the hillshade when asked, height ramp only', () => {
    const northWest = grid(9, (i, j) => (i - j) * 0.3)
    const southEast = grid(9, (i, j) => (j - i) * 0.3)
    const a = pixel(reliefPixels(northWest, { hillshade: false }), northWest, 4, 4)
    const b = pixel(reliefPixels(southEast, { hillshade: false }), southEast, 4, 4)
    expect(a).toEqual(b)
  })

  it('refuses a mask of the wrong length', () => {
    expect(() =>
      reliefPixels(
        grid(3, () => 0),
        { seen: new Uint8Array(4) },
      ),
    ).toThrow(/9/)
  })
})
