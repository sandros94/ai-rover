import { describe, expect, it } from 'vitest'
import { defineWorld, generateChunk, TerrainError } from '#shared/utils/terrain'

/** The TerrainError thrown by `fn`, or undefined when it throws nothing or something else. */
function terrainErrorOf(fn: () => unknown): TerrainError | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof TerrainError) return error
  }
  return undefined
}

describe('defineWorld', () => {
  it('fills defaults for scale parameters', () => {
    const world = defineWorld({ seed: 'mars' })
    expect(world.config.chunkSize).toBe(64)
    expect(world.config.cellSize).toBe(1)
    expect(world.config.mastHeight).toBe(2)
    expect(world.config.slopeLimitDeg).toBe(16)
    expect(world.config.craters.cellSize).toBe(256)
    expect(world.config.relief.octaves).toBe(6)
  })

  it('refuses an empty seed', () => {
    expect(terrainErrorOf(() => defineWorld({ seed: '' }))?.code).toBe('INVALID_CONFIG')
  })

  it('refuses a chunk size that is not a positive multiple of the cell size', () => {
    expect(
      terrainErrorOf(() => defineWorld({ seed: 'mars', chunkSize: 10, cellSize: 3 }))?.code,
    ).toBe('INVALID_CONFIG')
    expect(terrainErrorOf(() => defineWorld({ seed: 'mars', chunkSize: 0 }))?.code).toBe(
      'INVALID_CONFIG',
    )
    expect(terrainErrorOf(() => defineWorld({ seed: 'mars', chunkSize: -64 }))?.code).toBe(
      'INVALID_CONFIG',
    )
    expect(terrainErrorOf(() => defineWorld({ seed: 'mars', cellSize: 0 }))?.code).toBe(
      'INVALID_CONFIG',
    )
  })

  it('refuses craters whose reach exceeds the 3×3 crater-cell neighbourhood', () => {
    expect(
      terrainErrorOf(() => defineWorld({ seed: 'mars', craters: { cellSize: 100, maxRadius: 60 } }))
        ?.code,
    ).toBe('INVALID_CONFIG')
  })

  it('names the offending field in the message', () => {
    expect(
      terrainErrorOf(() => defineWorld({ seed: 'mars', slopeLimitDeg: 95 }))?.message,
    ).toContain('slopeLimitDeg')
  })
})

describe('heightAt', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = defineWorld({ seed: 'mars' })
    const b = defineWorld({ seed: 'mars' })
    const c = defineWorld({ seed: 'phobos' })
    const points = [
      [0, 0],
      [12.5, -40],
      [1000, 2000],
      [-513, 77],
    ] as const
    for (const [x, y] of points) expect(a.heightAt(x, y)).toBe(b.heightAt(x, y))
    expect(points.some(([x, y]) => a.heightAt(x, y) !== c.heightAt(x, y))).toBe(true)
  })

  it('agrees with generated chunk vertices', () => {
    const world = defineWorld({ seed: 'mars' })
    const chunk = generateChunk(world, { cx: 1, cy: -1 })
    const n = chunk.vertexCount
    for (const [i, j] of [
      [0, 0],
      [5, 17],
      [64, 64],
      [33, 0],
    ] as const) {
      const x = 64 + i
      const y = -64 + j
      expect(chunk.heights[j * n + i]).toBe(Math.fround(world.heightAt(x, y)))
    }
  })

  it('stays in a plausible band and shows at least one crater over 512 m', () => {
    const world = defineWorld({ seed: 'mars' })
    const size = 512
    const h = new Float64Array(size * size)
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) h[j * size + i] = world.heightAt(i, j)
    let min = Infinity
    let max = -Infinity
    for (const v of h) {
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(min).toBeGreaterThan(-200)
    expect(max).toBeLessThan(200)
    expect(max - min).toBeGreaterThan(2)

    // A crater: a local minimum whose surrounding ring at 6 cells sits well above it on every side.
    let craters = 0
    const ring = 6
    for (let j = ring; j < size - ring; j++) {
      for (let i = ring; i < size - ring; i++) {
        const c = h[j * size + i]!
        let isMin = true
        for (let dj = -1; dj <= 1 && isMin; dj++)
          for (let di = -1; di <= 1; di++) if (h[(j + dj) * size + i + di]! < c) isMin = false
        if (!isMin) continue
        let lowestRing = Infinity
        for (let k = -ring; k <= ring; k++) {
          lowestRing = Math.min(
            lowestRing,
            h[(j - ring) * size + i + k]!,
            h[(j + ring) * size + i + k]!,
            h[(j + k) * size + i - ring]!,
            h[(j + k) * size + i + ring]!,
          )
        }
        if (lowestRing - c > 1.5) craters++
      }
    }
    expect(craters).toBeGreaterThan(0)
  })
})
