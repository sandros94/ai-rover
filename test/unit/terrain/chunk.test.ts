import { describe, expect, it } from 'vitest'
import {
  defineWorld,
  encodeChunk,
  generateChunk,
  MASK_SEEN,
  MASK_TRAVERSABLE,
} from '#shared/utils/terrain'

describe('generateChunk', () => {
  it('produces a (size+1)² vertex grid with world scale', () => {
    const chunk = generateChunk(defineWorld({ seed: 'mars' }), { cx: 0, cy: 0 })
    expect(chunk.vertexCount).toBe(65)
    expect(chunk.cellSize).toBe(1)
    expect(chunk.heights).toHaveLength(65 * 65)
    expect(chunk.masks).toHaveLength(65 * 65)
  })

  it('is byte-identical across world instances with the same seed', () => {
    const a = encodeChunk(generateChunk(defineWorld({ seed: 'mars' }), { cx: 3, cy: -2 }))
    const b = encodeChunk(generateChunk(defineWorld({ seed: 'mars' }), { cx: 3, cy: -2 }))
    expect(a).toEqual(b)
  })

  it('differs across seeds', () => {
    const a = encodeChunk(generateChunk(defineWorld({ seed: 'mars' }), { cx: 3, cy: -2 }))
    const b = encodeChunk(generateChunk(defineWorld({ seed: 'deimos' }), { cx: 3, cy: -2 }))
    expect(a).not.toEqual(b)
  })

  it('shares edge vertices and edge masks exactly with its neighbours', () => {
    const world = defineWorld({ seed: 'mars' })
    const origin = generateChunk(world, { cx: 0, cy: 0 })
    const east = generateChunk(world, { cx: 1, cy: 0 })
    const north = generateChunk(world, { cx: 0, cy: 1 })
    const n = origin.vertexCount
    for (let k = 0; k < n; k++) {
      expect(east.heights[k * n]).toBe(origin.heights[k * n + n - 1])
      expect(east.masks[k * n]).toBe(origin.masks[k * n + n - 1])
      expect(north.heights[k]).toBe(origin.heights[(n - 1) * n + k])
      expect(north.masks[k]).toBe(origin.masks[(n - 1) * n + k])
    }
  })

  it('sets only the traversable bit on fresh chunks', () => {
    const chunk = generateChunk(defineWorld({ seed: 'mars' }), { cx: -4, cy: 7 })
    let traversable = 0
    for (const m of chunk.masks) {
      expect(m & MASK_SEEN).toBe(0)
      expect(m & ~(MASK_TRAVERSABLE | MASK_SEEN)).toBe(0)
      if (m & MASK_TRAVERSABLE) traversable++
    }
    expect(traversable).toBeGreaterThan(0)
  })

  it('refuses non-integer chunk coordinates', () => {
    expect(() => generateChunk(defineWorld({ seed: 'mars' }), { cx: 0.5, cy: 0 })).toThrow(
      expect.objectContaining({ code: 'OUT_OF_BOUNDS' }),
    )
  })
})
