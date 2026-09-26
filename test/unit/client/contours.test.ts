import { describe, expect, it } from 'vitest'
import type { HeightGrid } from '#shared/utils/terrain'
import { contourLines } from '#shared/utils/client/contours'

/** A cone 10.5 m high on a flat plain, centred on vertex (20, 20) of a 41 × 41 grid. */
const cone: HeightGrid = (() => {
  const size = 41
  const heights = new Float32Array(size * size)
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++)
      heights[j * size + i] = Math.max(0, 10.5 - Math.hypot(i - 20, j - 20))
  return { heights, width: size, height: size, cellSize: 1 }
})()

const key = (x: number, y: number) => `${x.toFixed(5)},${y.toFixed(5)}`

describe('contourLines', () => {
  it('rings a cone once per metre, every fifth ring major', () => {
    const levels = contourLines(cone)
    expect(levels.map((l) => l.height)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(levels.filter((l) => l.major).map((l) => l.height)).toEqual([5, 10])
  })

  it('draws each ring as a closed loop around the summit at its own radius', () => {
    for (const level of contourLines(cone)) {
      const { segments } = level
      expect(segments.length % 4).toBe(0)
      const ends = new Map<string, number>()
      for (let s = 0; s < segments.length; s += 4) {
        const [x0, y0, x1, y1] = segments.slice(s, s + 4) as [number, number, number, number]
        for (const [x, y] of [
          [x0, y0],
          [x1, y1],
        ] as const) {
          ends.set(key(x, y), (ends.get(key(x, y)) ?? 0) + 1)
          expect(Math.hypot(x - 20, y - 20)).toBeCloseTo(10.5 - level.height, 0)
        }
      }
      // Every endpoint is shared by two segments: no loose ends.
      for (const count of ends.values()) expect(count).toBe(2)
      expect(ends.size).toBeGreaterThan(3)
    }
  })

  it('draws nothing where the mask does not clear all four corners of a cell', () => {
    const mask = new Uint8Array(41 * 41)
    for (let j = 0; j < 41; j++) for (let i = 0; i < 20; i++) mask[j * 41 + i] = 1
    for (const level of contourLines(cone, { mask })) {
      for (let s = 0; s < level.segments.length; s += 2)
        expect(level.segments[s]).toBeLessThanOrEqual(19)
    }
    expect(contourLines(cone, { mask: new Uint8Array(41 * 41) })).toEqual([])
  })

  it('keeps to a rectangle of vertices and honours the interval', () => {
    const levels = contourLines(cone, { interval: 2, rect: { i0: 20, j0: 0, i1: 41, j1: 41 } })
    expect(levels.map((l) => l.height)).toEqual([2, 4, 6, 8, 10])
    expect(levels.filter((l) => l.major).map((l) => l.height)).toEqual([10])
    for (const level of levels)
      for (let s = 0; s < level.segments.length; s += 2)
        expect(level.segments[s]).toBeGreaterThanOrEqual(20)
  })
})
