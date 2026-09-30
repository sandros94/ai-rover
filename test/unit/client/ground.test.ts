import { describe, expect, it } from 'vitest'
import type { Chunk } from '#shared/utils/terrain'
import { generateChunk } from '#shared/utils/terrain'
import {
  ClientError,
  contourTiles,
  createDiskGround,
  expandRect,
  groundAround,
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
    // The disk's sixteen chunks run from cx, cy = -2: the four round the origin sit in the middle.
    expect(ground.place(northEast)).toEqual({ i0: 128, j0: 128, i1: 193, j1: 193 })
    expect(ground.place(northEast)).toBeUndefined()
    expect(ground.place(generateChunk(world, { cx: 5, cy: 5 }))).toBeUndefined()
    expect(ground.place(southWest)).toEqual({ i0: 64, j0: 64, i1: 129, j1: 129 })
    expect(ground.placed).toEqual([
      { i0: 128, j0: 128, i1: 193, j1: 193 },
      { i0: 64, j0: 64, i1: 129, j1: 129 },
    ])
    const { heights, width } = ground.grid
    expect(heights[134 * width + 134]).toBe(northEast.heights[6 * 65 + 6])
    expect(heights[74 * width + 164]).toBeNaN()
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

describe('groundAround', () => {
  const options = { chunkVertices: 65, survey: { center: { x: 0, y: 0 }, radius: 60 } }

  it('holds once the chunk under the point and those around it within the survey are in', () => {
    const ground = createDiskGround(manifest)
    const point = { x: 10, y: 10 }
    ground.place(northEast)
    ground.place(southWest)
    ground.place(southEast)
    expect(groundAround(groundView(ground), point, options)).toBe(false)
    ground.place(northWest)
    // The chunks east and north of these four lie beyond the 60 m survey.
    expect(groundAround(groundView(ground), point, options)).toBe(true)
    expect(ground.complete).toBe(false)
  })

  it('holds for a whole grid, and for one complete', () => {
    const ground = createDiskGround(manifest)
    expect(
      groundAround({ grid: ground.grid, origin: ground.origin }, { x: 0, y: 0 }, options),
    ).toBe(true)
    for (const chunk of chunks) ground.place(chunk)
    expect(groundAround(groundView(ground), { x: -50, y: 20 }, options)).toBe(true)
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
    expect(tiles(false)).toEqual([5, 10])
    expect(tiles(true)).toEqual(Array.from({ length: 16 }, (_, k) => k))
    // An arrival meets its neighbours' tiles along the shared edge too.
    const arrived = ground.place(southEast)!
    expect(contourTiles(ground.grid, arrived, { tile: 64, complete: false })).toEqual([
      { index: 5, rect: { i0: 64, j0: 64, i1: 129, j1: 129 } },
      { index: 6, rect: { i0: 128, j0: 64, i1: 193, j1: 129 } },
      { index: 10, rect: { i0: 128, j0: 128, i1: 193, j1: 193 } },
    ])
  })

  it('paints arrived chunks opaque and the rest transparent', () => {
    const ground = createDiskGround(manifest)
    ground.place(southWest)
    ground.place(northEast)
    const { grid } = ground
    const pixels = reliefPixels(grid, { heightRange: manifest.heightRange })
    const alpha = (i: number, j: number) => pixels[((grid.height - 1 - j) * grid.width + i) * 4 + 3]
    expect(alpha(74, 74)).toBe(255)
    expect(alpha(164, 164)).toBe(255)
    expect(alpha(164, 74)).toBe(0)
    expect(alpha(74, 164)).toBe(0)
  })

  it('paints chunk by chunk to the same pixels as the whole disk at once', () => {
    const range = manifest.heightRange
    const ground = createDiskGround(manifest)
    const { grid } = ground
    const into = new Uint8ClampedArray(grid.width * grid.height * 4)
    reliefPixels(grid, { heightRange: range, into })
    // The four round the origin first, then the rest; each chunk lands once.
    for (const chunk of [northEast, southWest, northWest, southEast, ...chunks]) {
      const rect = ground.place(chunk)
      if (!rect) continue
      // New ground shades the vertex beside it: repaint one vertex around the arrival.
      reliefPixels(grid, { heightRange: range, rect: expandRect(rect, 1, grid), into })
    }
    expect(ground.complete).toBe(true)
    expect(into).toEqual(reliefPixels(disk.grid, { heightRange: range }))
  })
})
