import { describe, expect, it } from 'vitest'
import type { ChunkCoords, World } from '#shared/utils/terrain'
import {
  chunksCoveringDisk,
  computeStopDisk,
  defineWorld,
  generateChunk,
  MASK_TRAVERSABLE,
  snapToPathable,
  TerrainError,
  worldToVertex,
} from '#shared/utils/terrain'

/** The TerrainError thrown by `fn`, or undefined when it throws nothing or something else. */
function terrainErrorOf(fn: () => unknown): TerrainError | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof TerrainError) return error
  }
  return undefined
}

/**
 * Chunks whose square comes within `radius` of `center`, found by sampling each square's
 * boundary every 1/16 m over a generous box: independent of the implementation's closed form.
 */
function bruteForceChunks(
  world: World,
  center: { x: number; y: number },
  radius: number,
): ChunkCoords[] {
  const size = world.config.chunkSize
  const span = Math.ceil(radius / size) + 2
  const ccx = Math.floor(center.x / size)
  const ccy = Math.floor(center.y / size)
  const found: ChunkCoords[] = []
  for (let cy = ccy - span; cy <= ccy + span; cy++) {
    for (let cx = ccx - span; cx <= ccx + span; cx++) {
      const x0 = cx * size
      const y0 = cy * size
      let hit = center.x >= x0 && center.x <= x0 + size && center.y >= y0 && center.y <= y0 + size
      for (let s = 0; !hit && s <= size * 16; s++) {
        const t = s / 16
        for (const [x, y] of [
          [x0 + t, y0],
          [x0 + t, y0 + size],
          [x0, y0 + t],
          [x0 + size, y0 + t],
        ] as const) {
          if (Math.hypot(x - center.x, y - center.y) <= radius) hit = true
        }
      }
      if (hit) found.push({ cx, cy })
    }
  }
  return found
}

describe('worldToVertex', () => {
  it('rounds to the nearest vertex', () => {
    const world = defineWorld({ seed: 'mars', cellSize: 0.5, chunkSize: 32 })
    expect(worldToVertex(world, { x: 1.2, y: -0.8 })).toEqual({ i: 2, j: -2 })
    expect(worldToVertex(world, { x: 0, y: 0 })).toEqual({ i: 0, j: 0 })
  })

  it('refuses non-finite points', () => {
    const world = defineWorld({ seed: 'mars' })
    expect(terrainErrorOf(() => worldToVertex(world, { x: Number.NaN, y: 0 }))?.code).toBe(
      'OUT_OF_BOUNDS',
    )
  })
})

describe('chunksCoveringDisk', () => {
  const world = defineWorld({ seed: 'mars' })

  it('lists the four chunks meeting at the origin for a 1 m disk', () => {
    expect(chunksCoveringDisk(world, { center: { x: 0, y: 0 }, radius: 1 })).toEqual([
      { cx: -1, cy: -1 },
      { cx: 0, cy: -1 },
      { cx: -1, cy: 0 },
      { cx: 0, cy: 0 },
    ])
  })

  it('covers a 500 m disk at the origin with its bounding box minus the far corners', () => {
    const chunks = chunksCoveringDisk(world, { center: { x: 0, y: 0 }, radius: 500 })
    const xs = chunks.map((c) => c.cx)
    const ys = chunks.map((c) => c.cy)
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([
      -8, 7, -8, 7,
    ])
    expect(chunks.length).toBeLessThan(16 * 16)
    for (const corner of [
      { cx: -8, cy: -8 },
      { cx: 7, cy: -8 },
      { cx: -8, cy: 7 },
      { cx: 7, cy: 7 },
    ])
      expect(chunks).not.toContainEqual(corner)
    expect(chunks).toContainEqual({ cx: -8, cy: 0 })
    expect(chunks).toEqual(bruteForceChunks(world, { x: 0, y: 0 }, 500))
  })

  it('matches a brute-force search off the grid, sorted by (cy, cx)', () => {
    const center = { x: 137.3, y: -241.9 }
    const chunks = chunksCoveringDisk(world, { center, radius: 211.4 })
    expect(chunks).toEqual(bruteForceChunks(world, center, 211.4))
    const sorted = [...chunks].sort((a, b) => a.cy - b.cy || a.cx - b.cx)
    expect(chunks).toEqual(sorted)
  })

  it('refuses a non-positive radius', () => {
    expect(
      terrainErrorOf(() => chunksCoveringDisk(world, { center: { x: 0, y: 0 }, radius: 0 }))?.code,
    ).toBe('OUT_OF_BOUNDS')
  })
})

describe('computeStopDisk', () => {
  const world = defineWorld({ seed: 'mars' })
  const center = { x: 40.4, y: -90.6 }
  const disk = computeStopDisk(world, { center, radius: 120 })
  const n = world.config.chunkSize / world.config.cellSize
  const vertexCount = n + 1

  it('describes the disk it was asked for', () => {
    expect(disk.center).toEqual(center)
    expect(disk.radius).toBe(120)
    expect(disk.chunks).toEqual(chunksCoveringDisk(world, { center, radius: 120 }))
  })

  it('sizes the grid to the chunks’ bounding box with shared edges once', () => {
    const xs = disk.chunks.map((c) => c.cx)
    const ys = disk.chunks.map((c) => c.cy)
    const cols = Math.max(...xs) - Math.min(...xs) + 1
    const rows = Math.max(...ys) - Math.min(...ys) + 1
    expect(disk.grid.width).toBe(cols * n + 1)
    expect(disk.grid.height).toBe(rows * n + 1)
    expect(disk.grid.cellSize).toBe(world.config.cellSize)
    expect(disk.origin).toEqual({ i: Math.min(...xs) * n, j: Math.min(...ys) * n })
    const cells = disk.grid.width * disk.grid.height
    expect(disk.grid.heights).toHaveLength(cells)
    expect(disk.traversable).toHaveLength(cells)
    expect(disk.reachable).toHaveLength(cells)
    expect(disk.visible).toHaveLength(cells)
  })

  it('agrees with every chunk’s heights and traversable bits at every vertex', () => {
    let mismatches = 0
    for (const coords of disk.chunks) {
      const chunk = generateChunk(world, coords)
      for (let b = 0; b < vertexCount; b++) {
        for (let a = 0; a < vertexCount; a++) {
          const gi = coords.cx * n + a - disk.origin.i
          const gj = coords.cy * n + b - disk.origin.j
          const g = gj * disk.grid.width + gi
          const c = b * vertexCount + a
          if (!Object.is(disk.grid.heights[g], chunk.heights[c])) mismatches++
          if (disk.traversable[g] !== (chunk.masks[c]! & MASK_TRAVERSABLE ? 1 : 0)) mismatches++
        }
      }
    }
    expect(mismatches).toBe(0)
  })

  it('marks vertices outside every listed chunk as NaN and untraversable', () => {
    const listed = new Set(disk.chunks.map((c) => `${c.cx},${c.cy}`))
    let outside = 0
    for (let gj = 0; gj < disk.grid.height; gj++) {
      for (let gi = 0; gi < disk.grid.width; gi++) {
        const i = gi + disk.origin.i
        const j = gj + disk.origin.j
        const owners = [
          [Math.floor(i / n), Math.floor(j / n)],
          [Math.ceil(i / n) - 1, Math.floor(j / n)],
          [Math.floor(i / n), Math.ceil(j / n) - 1],
          [Math.ceil(i / n) - 1, Math.ceil(j / n) - 1],
        ]
        if (owners.some(([cx, cy]) => listed.has(`${cx},${cy}`))) continue
        outside++
        const g = gj * disk.grid.width + gi
        expect(disk.grid.heights[g]).toBeNaN()
        expect(disk.traversable[g]).toBe(0)
        expect(disk.reachable[g]).toBe(0)
        expect(disk.visible[g]).toBe(0)
      }
    }
    expect(outside).toBeGreaterThan(0)
  })

  it('sees and reaches its own centre vertex', () => {
    const v = worldToVertex(world, center)
    const g = (v.j - disk.origin.j) * disk.grid.width + (v.i - disk.origin.i)
    expect(disk.visible[g]).toBe(1)
    expect(disk.reachable[g]).toBe(disk.traversable[g])
    expect(disk.traversable[g]).toBe(1)
  })

  it('sees nothing beyond the radius', () => {
    const v = worldToVertex(world, center)
    const r = disk.radius / world.config.cellSize
    let seenBeyond = 0
    for (let gj = 0; gj < disk.grid.height; gj++) {
      for (let gi = 0; gi < disk.grid.width; gi++) {
        const di = gi + disk.origin.i - v.i
        const dj = gj + disk.origin.j - v.j
        if (di * di + dj * dj > r * r) seenBeyond += disk.visible[gj * disk.grid.width + gi]!
      }
    }
    expect(seenBeyond).toBe(0)
  })

  it('reaches only traversable vertices', () => {
    let stranded = 0
    for (let k = 0; k < disk.reachable.length; k++)
      if (disk.reachable[k] && !disk.traversable[k]) stranded++
    expect(stranded).toBe(0)
  })

  it('is deterministic', () => {
    const again = computeStopDisk(defineWorld({ seed: 'mars' }), { center, radius: 120 })
    expect(again).toEqual(disk)
  })

  it('defaults the radius to 500 m', () => {
    const full = computeStopDisk(world, { center: { x: 0, y: 0 } })
    expect(full.radius).toBe(500)
    expect(full.chunks).toEqual(chunksCoveringDisk(world, { center: { x: 0, y: 0 }, radius: 500 }))
    expect(full.grid.width).toBe(16 * n + 1)
    expect(full.visible).toHaveLength(full.grid.width * full.grid.height)
  })
})

describe('snapToPathable', () => {
  const world = defineWorld({ seed: 'mars' })
  const base = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 100 })
  const { width } = base.grid
  const at = (x: number, y: number) => (y - base.origin.j) * width + (x - base.origin.i)
  /** The disk with the given world vertices made untraversable and unreachable. */
  function blocked(vertices: [number, number][]) {
    const traversable = base.traversable.slice()
    const reachable = base.reachable.slice()
    for (const [x, y] of vertices) traversable[at(x, y)] = reachable[at(x, y)] = 0
    return { ...base, traversable, reachable }
  }

  it('keeps a point on a pathable vertex at that vertex', () => {
    expect(base.reachable[at(30, 40)]).toBe(1)
    expect(snapToPathable(base, { x: 30.4, y: 39.6 })).toEqual({ x: 30, y: 40 })
  })

  it('moves a point off a blocked vertex to the nearest pathable one', () => {
    const disk = blocked([
      [30, 40],
      [31, 40],
      [30, 41],
      [30, 39],
    ])
    // (29, 40) is 1.2 m away; the diagonal (31, 39) and (31, 41) are 1.28 m away.
    expect(snapToPathable(disk, { x: 30.2, y: 40 })).toEqual({ x: 29, y: 40 })
  })

  it('refuses when nothing pathable lies within the search radius', () => {
    const square: [number, number][] = []
    for (let y = 30; y <= 50; y++) for (let x = 20; x <= 40; x++) square.push([x, y])
    expect(snapToPathable(blocked(square), { x: 30, y: 40 })).toBeUndefined()
    // A larger radius reaches past the blocked square.
    expect(snapToPathable(blocked(square), { x: 30, y: 40 }, { radiusM: 12 })).toBeDefined()
  })

  it('refuses a point outside the disk', () => {
    expect(snapToPathable(base, { x: 0, y: 400 })).toBeUndefined()
    // Vertices beyond the disk radius are never candidates, even within the search radius.
    expect(snapToPathable(base, { x: 0, y: 106 })).toBeUndefined()
    expect(terrainErrorOf(() => snapToPathable(base, { x: Number.NaN, y: 0 }))?.code).toBe(
      'OUT_OF_BOUNDS',
    )
  })
})
