import { describe, expect, it } from 'vitest'
import type { Chunk } from '#shared/utils/terrain'
import { generateChunk } from '#shared/utils/terrain'
import {
  ClientError,
  contourTiles,
  createDiskGround,
  expandRect,
  groundView,
  reliefPixels,
} from '#shared/utils/client'
import { journeyFixture } from './helpers'

const fixture = journeyFixture()
const { stopManifest: manifest, world, disk } = fixture
const chunks: Chunk[] = manifest.chunks.map((c) => generateChunk(world, c))
const at = (cx: number, cy: number) => chunks.find((c) => c.cx === cx && c.cy === cy)!
const [southWest, southEast, northWest, northEast] = [at(-1, -1), at(0, -1), at(-1, 0), at(0, 0)]

/** Heights with NaN made comparable. */
const bits = (heights: Float32Array) => new Uint32Array(heights.slice().buffer)

describe('createDiskGround', () => {
  it('lays the disk out as the server does, NaN until chunks are placed', () => {
    const ground = createDiskGround(manifest)
    expect(ground.origin).toEqual(disk.origin)
    expect([ground.grid.width, ground.grid.height, ground.grid.cellSize]).toEqual([
      disk.grid.width,
      disk.grid.height,
      disk.grid.cellSize,
    ])
    expect(ground.grid.heights.every(Number.isNaN)).toBe(true)
    expect(ground.complete).toBe(false)
    for (const chunk of chunks) ground.place(chunk)
    expect(ground.complete).toBe(true)
    expect(bits(ground.grid.heights)).toEqual(bits(disk.grid.heights))
  })

  it('places each listed chunk once, giving its vertex rectangle', () => {
    const ground = createDiskGround(manifest)
    expect(ground.place(northEast)).toEqual({ i0: 64, j0: 64, i1: 129, j1: 129 })
    expect(ground.place(northEast)).toBeUndefined()
    expect(ground.place(generateChunk(world, { cx: 5, cy: 5 }))).toBeUndefined()
    expect(ground.place(southWest)).toEqual({ i0: 0, j0: 0, i1: 65, j1: 65 })
    expect(ground.placed).toEqual([
      { i0: 64, j0: 64, i1: 129, j1: 129 },
      { i0: 0, j0: 0, i1: 65, j1: 65 },
    ])
    const { heights, width } = ground.grid
    expect(heights[70 * width + 70]).toBe(northEast.heights[6 * 65 + 6])
    expect(heights[10 * width + 100]).toBeNaN()
  })

  it('refuses a chunk of another geometry with DECODE, leaving it to place', () => {
    const ground = createDiskGround(manifest)
    const odd = { ...southWest, vertexCount: 3, heights: new Float32Array(9) }
    expect(() => ground.place(odd)).toThrow(ClientError)
    expect(ground.placed).toEqual([])
    expect(ground.place(southWest)).toBeDefined()
  })

  it('gives views that stay as they were while the ground fills', () => {
    const ground = createDiskGround(manifest)
    ground.place(southWest)
    const view = groundView(ground, manifest.heightRange)
    ground.place(southEast)
    expect(view.placed).toHaveLength(1)
    expect(view.complete).toBe(false)
    expect(view.heightRange).toBe(manifest.heightRange)
    expect(view.grid).toBe(ground.grid)
  })
})

describe('painting a partial disk', () => {
  it('traces only the tiles whose chunks are in, every tile once complete', () => {
    const ground = createDiskGround(manifest)
    const whole = { i0: 0, j0: 0, i1: ground.grid.width, j1: ground.grid.height }
    const tiles = (complete: boolean) =>
      contourTiles(ground.grid, whole, { tile: 64, complete }).map((t) => t.index)
    expect(tiles(false)).toEqual([])
    ground.place(southWest)
    ground.place(northEast)
    expect(tiles(false)).toEqual([0, 3])
    expect(tiles(true)).toEqual([0, 1, 2, 3])
    // An arrival meets its neighbours' tiles along the shared edge too.
    const arrived = ground.place(southEast)!
    expect(contourTiles(ground.grid, arrived, { tile: 64, complete: false })).toEqual([
      { index: 0, rect: { i0: 0, j0: 0, i1: 65, j1: 65 } },
      { index: 1, rect: { i0: 64, j0: 0, i1: 129, j1: 65 } },
      { index: 3, rect: { i0: 64, j0: 64, i1: 129, j1: 129 } },
    ])
  })

  it('paints arrived chunks opaque and the rest transparent', () => {
    const ground = createDiskGround(manifest)
    ground.place(southWest)
    ground.place(northEast)
    const { grid } = ground
    const pixels = reliefPixels(grid, { heightRange: manifest.heightRange })
    const alpha = (i: number, j: number) => pixels[((grid.height - 1 - j) * grid.width + i) * 4 + 3]
    expect(alpha(10, 10)).toBe(255)
    expect(alpha(100, 100)).toBe(255)
    expect(alpha(100, 10)).toBe(0)
    expect(alpha(10, 100)).toBe(0)
  })

  it('paints chunk by chunk to the same pixels as the whole disk at once', () => {
    const range = manifest.heightRange
    const ground = createDiskGround(manifest)
    const { grid } = ground
    const into = new Uint8ClampedArray(grid.width * grid.height * 4)
    reliefPixels(grid, { heightRange: range, into })
    for (const chunk of [northEast, southWest, northWest, southEast]) {
      const rect = ground.place(chunk)!
      // New ground shades the vertex beside it: repaint one vertex around the arrival.
      reliefPixels(grid, { heightRange: range, rect: expandRect(rect, 1, grid), into })
    }
    expect(into).toEqual(reliefPixels(disk.grid, { heightRange: range }))
  })
})
