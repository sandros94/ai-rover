import { describe, expect, it } from 'vitest'
import type { ChunkCoords, World } from '#shared/utils/terrain'
import {
  chunksNearestFirst,
  chunksCoveringDisk,
  computeStopDisk,
  defineWorld,
  generateChunk,
  MASK_TRAVERSABLE,
  reachableFrom,
  snapToPathable,
  SURVEY_MARGIN_M,
  surveyMask,
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

describe('chunksNearestFirst', () => {
  const world = defineWorld({ seed: 'mars' })
  const size = world.config.chunkSize
  const center = { x: 100, y: -30 }
  const listed = chunksCoveringDisk(world, { center, radius: 500 })
  const ordered = chunksNearestFirst(listed, { center, chunkSize: size })
  const distance = ({ cx, cy }: ChunkCoords) =>
    Math.hypot((cx + 0.5) * size - center.x, (cy + 0.5) * size - center.y)

  it('puts the stop’s own chunk first, then the rest by growing distance', () => {
    expect(ordered[0]).toEqual({ cx: Math.floor(center.x / size), cy: Math.floor(center.y / size) })
    for (let k = 1; k < ordered.length; k++) {
      expect(distance(ordered[k]!)).toBeGreaterThanOrEqual(distance(ordered[k - 1]!))
    }
    const key = ({ cx, cy }: ChunkCoords) => `${cx},${cy}`
    expect(ordered.map(key).toSorted()).toEqual(listed.map(key).toSorted())
  })

  it('breaks ties by cx, then cy', () => {
    const tied = [
      { cx: 0, cy: 0 },
      { cx: 0, cy: -1 },
      { cx: -1, cy: 0 },
      { cx: -1, cy: -1 },
    ]
    expect(chunksNearestFirst(tied, { center: { x: 0, y: 0 }, chunkSize: 64 })).toEqual([
      { cx: -1, cy: -1 },
      { cx: -1, cy: 0 },
      { cx: 0, cy: -1 },
      { cx: 0, cy: 0 },
    ])
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

  /** The disk's traversable vertices within its survey: what reachability floods over. */
  const walkable = disk.traversable.map((t, k) => t & disk.inside[k]!)

  it('describes the disk it was asked for', () => {
    expect(disk.center).toEqual(center)
    expect(disk.radius).toBe(120)
    expect(disk.chunks).toEqual(
      chunksCoveringDisk(world, { center, radius: 120 + SURVEY_MARGIN_M }),
    )
  })

  it('covers the survey and its margin with chunks, and no chunk beyond them', () => {
    expect(disk.chunks).toEqual(bruteForceChunks(world, center, 120 + SURVEY_MARGIN_M))
    expect(disk.chunks.length).toBeGreaterThan(
      chunksCoveringDisk(world, { center, radius: 120 }).length,
    )
  })

  it('marks the survey: every vertex within the radius of the centre, none beyond', () => {
    expect(disk.inside).toEqual(surveyMask(disk, disk))
    let within = 0
    let mismatches = 0
    for (let gj = 0; gj < disk.grid.height; gj++) {
      for (let gi = 0; gi < disk.grid.width; gi++) {
        const x = gi + disk.origin.i
        const y = gj + disk.origin.j
        const expected = Math.hypot(x - center.x, y - center.y) <= 120 ? 1 : 0
        if (disk.inside[gj * disk.grid.width + gi] !== expected) mismatches++
        within += expected
      }
    }
    expect(mismatches).toBe(0)
    expect(within).toBeGreaterThan(0)
  })

  it('sees and reaches nothing beyond the survey, however open the ground', () => {
    let beyond = 0
    for (let k = 0; k < disk.inside.length; k++) {
      if (!disk.inside[k] && (disk.visible[k] || disk.reachable[k])) beyond++
    }
    expect(beyond).toBe(0)
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

  it('seeds reachability from its traversable centre vertex, as a plain flood fill from it', () => {
    const v = worldToVertex(world, center)
    const start = { i: v.i - disk.origin.i, j: v.j - disk.origin.j }
    expect(disk.reachableFrom).toEqual(start)
    const { width, height } = disk.grid
    const flood = reachableFrom(walkable, { width, height, start })
    expect(disk.reachable.every((r, k) => r === flood[k])).toBe(true)
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

  it('defaults the radius to 500 m, and refuses a goal 501 m away as outside', () => {
    const full = computeStopDisk(world, { center: { x: 0, y: 0 } })
    expect(full.radius).toBe(500)
    expect(full.chunks).toEqual(
      chunksCoveringDisk(world, { center: { x: 0, y: 0 }, radius: 500 + SURVEY_MARGIN_M }),
    )
    expect(full.grid.width).toBe(18 * n + 1)
    expect(full.visible).toHaveLength(full.grid.width * full.grid.height)
    const revealed = new Uint8Array(full.visible.length).fill(1)
    expect(snapToPathable(full, { x: 0, y: 501 }, { revealed })).toEqual({
      ok: false,
      reason: 'outside',
    })
  })
})

describe('computeStopDisk on an untraversable centre vertex', () => {
  const world = defineWorld({ seed: 'mars' })
  const survey = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 100 })
  const traversableAt = (x: number, y: number) =>
    survey.traversable[(y - survey.origin.j) * survey.grid.width + (x - survey.origin.i)] === 1
  // A blocked vertex with a traversable 8-neighbour, found by scanning outward from the origin.
  let blockedCentre: { x: number; y: number } | undefined
  for (let y = -40; y <= 40 && !blockedCentre; y++) {
    for (let x = -40; x <= 40 && !blockedCentre; x++) {
      if (traversableAt(x, y)) continue
      let neighbour = false
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if (traversableAt(x + dx, y + dy)) neighbour = true
      if (neighbour) blockedCentre = { x, y }
    }
  }
  const disk = computeStopDisk(world, { center: blockedCentre!, radius: 100 })
  const { width, height } = disk.grid
  const centreVertex = {
    i: blockedCentre!.x / world.config.cellSize - disk.origin.i,
    j: blockedCentre!.y / world.config.cellSize - disk.origin.j,
  }
  const k = (c: { i: number; j: number }) => c.j * width + c.i

  it('finds a blocked centre with traversable neighbours to test against', () => {
    expect(blockedCentre).toBeDefined()
    expect(disk.traversable[k(centreVertex)]).toBe(0)
  })

  it('seeds from the traversable vertex nearest the centre, lowest (j, i) on ties', () => {
    let best: { i: number; j: number } | undefined
    let bestDistance = Infinity
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const c = { i: centreVertex.i + di, j: centreVertex.j + dj }
        if (!disk.traversable[k(c)]) continue
        const distance = Math.hypot(di, dj)
        if (distance < bestDistance) {
          best = c
          bestDistance = distance
        }
      }
    }
    expect(disk.reachableFrom).toEqual(best)
  })

  it('reaches a non-empty region holding the seed, the same as a flood fill from the seed', () => {
    expect(disk.reachable[k(disk.reachableFrom)]).toBe(1)
    expect(disk.reachable.some((r) => r === 1)).toBe(true)
    const walkable = disk.traversable.map((t, n) => t & disk.inside[n]!)
    const flood = reachableFrom(walkable, { width, height, start: disk.reachableFrom })
    expect(disk.reachable.every((r, n) => r === flood[n])).toBe(true)
  })

  it('still sees from the centre vertex itself', () => {
    expect(disk.visible[k(centreVertex)]).toBe(1)
  })

  it('snaps a goal 30 m away on pathable ground', () => {
    let goal: { x: number; y: number } | undefined
    for (let a = 0; a < 360 && !goal; a++) {
      const x = Math.round(blockedCentre!.x + 30 * Math.cos((a * Math.PI) / 180))
      const y = Math.round(blockedCentre!.y + 30 * Math.sin((a * Math.PI) / 180))
      const g = (y - disk.origin.j) * width + (x - disk.origin.i)
      if (disk.traversable[g] && disk.reachable[g]) goal = { x, y }
    }
    expect(goal).toBeDefined()
    expect(
      snapToPathable(disk, goal!, { revealed: new Uint8Array(disk.traversable.length).fill(1) }),
    ).toEqual({ ok: true, point: goal })
  })
})

describe('computeStopDisk with nothing traversable within the radius', () => {
  // A near-zero slope limit blocks almost every vertex; a 2 m disk then holds none traversable.
  const world = defineWorld({ seed: 'mars', slopeLimitDeg: 0.01 })
  const survey = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 60 })
  const { width } = survey.grid
  let bare: { x: number; y: number } | undefined
  for (let y = -40; y <= 40 && !bare; y += 4) {
    for (let x = -40; x <= 40 && !bare; x += 4) {
      let any = false
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (survey.traversable[(y + dy - survey.origin.j) * width + (x + dx - survey.origin.i)])
            any = true
      if (!any) bare = { x, y }
    }
  }

  it('reaches nothing and records the centre vertex as the seed', () => {
    expect(bare).toBeDefined()
    const disk = computeStopDisk(world, { center: bare!, radius: 2 })
    expect(disk.reachable.every((r) => r === 0)).toBe(true)
    expect(disk.reachableFrom).toEqual({
      i: bare!.x / world.config.cellSize - disk.origin.i,
      j: bare!.y / world.config.cellSize - disk.origin.j,
    })
  })
})

describe('snapToPathable', () => {
  const world = defineWorld({ seed: 'mars' })
  const base = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 100 })
  const { width } = base.grid
  const at = (x: number, y: number) => (y - base.origin.j) * width + (x - base.origin.i)
  /** Every vertex seen, so only traversability and reachability decide. */
  const seen = new Uint8Array(base.traversable.length).fill(1)
  /** The disk with the given world vertices made untraversable and unreachable. */
  function blocked(vertices: [number, number][]) {
    const traversable = base.traversable.slice()
    const reachable = base.reachable.slice()
    for (const [x, y] of vertices) traversable[at(x, y)] = reachable[at(x, y)] = 0
    return { ...base, traversable, reachable }
  }
  /** `seen` with the given world vertices unseen. */
  function fogged(vertices: [number, number][]) {
    const revealed = seen.slice()
    for (const [x, y] of vertices) revealed[at(x, y)] = 0
    return revealed
  }
  const square = (x0: number, y0: number, x1: number, y1: number) => {
    const out: [number, number][] = []
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y])
    return out
  }

  it('keeps a point on a pathable vertex at that vertex', () => {
    expect(base.reachable[at(30, 40)]).toBe(1)
    expect(snapToPathable(base, { x: 30.4, y: 39.6 }, { revealed: seen })).toEqual({
      ok: true,
      point: { x: 30, y: 40 },
    })
  })

  it('moves a point off a blocked vertex to the nearest pathable one', () => {
    const disk = blocked([
      [30, 40],
      [31, 40],
      [30, 41],
      [30, 39],
    ])
    // (29, 40) is 1.2 m away; the diagonal (31, 39) and (31, 41) are 1.28 m away.
    expect(snapToPathable(disk, { x: 30.2, y: 40 }, { revealed: seen })).toEqual({
      ok: true,
      point: { x: 29, y: 40 },
    })
  })

  it('refuses when nothing pathable lies within the search radius', () => {
    const disk = blocked(square(20, 30, 40, 50))
    expect(snapToPathable(disk, { x: 30, y: 40 }, { revealed: seen })).toEqual({
      ok: false,
      reason: 'unpathable',
    })
    // A larger radius reaches past the blocked square.
    expect(snapToPathable(disk, { x: 30, y: 40 }, { revealed: seen, radiusM: 12 }).ok).toBe(true)
  })

  it('refuses a point beyond the survey as outside', () => {
    const out = { ok: false, reason: 'outside' }
    expect(snapToPathable(base, { x: 0, y: 400 }, { revealed: seen })).toEqual(out)
    expect(snapToPathable(base, { x: 0, y: 100.01 }, { revealed: seen })).toEqual(out)
    expect(
      terrainErrorOf(() => snapToPathable(base, { x: Number.NaN, y: 0 }, { revealed: seen }))?.code,
    ).toBe('OUT_OF_BOUNDS')
  })

  it('never snaps to a vertex beyond the survey, however pathable', () => {
    // Everything within the survey near the point is blocked; the pathable margin lies beyond.
    const near = square(-5, 94, 5, 100).filter(([x, y]) => Math.hypot(x, y) <= 100)
    const disk = blocked(near)
    expect(base.traversable[at(0, 102)]).toBe(1)
    expect(snapToPathable(disk, { x: 0, y: 99 }, { revealed: seen })).toEqual({
      ok: false,
      reason: 'unpathable',
    })
  })

  it('never snaps to an unseen vertex, however pathable', () => {
    // (30, 40) and its four neighbours are pathable but unseen: the nearest seen one wins.
    const revealed = fogged([
      [30, 40],
      [31, 40],
      [29, 40],
      [30, 41],
      [30, 39],
    ])
    const snapped = snapToPathable(base, { x: 30, y: 40 }, { revealed })
    expect(snapped.ok).toBe(true)
    if (!snapped.ok) return
    const { x, y } = snapped.point
    expect(revealed[at(x, y)]).toBe(1)
    expect(Math.hypot(x - 30, y - 40)).toBeCloseTo(Math.SQRT2, 9)
  })

  it('refuses a point with only unseen ground within the search radius as unrevealed', () => {
    const revealed = fogged(square(20, 30, 40, 50))
    expect(snapToPathable(base, { x: 30, y: 40 }, { revealed })).toEqual({
      ok: false,
      reason: 'unrevealed',
    })
    // Unseen ground is refused whatever it holds: blocked and unseen is still unrevealed.
    expect(snapToPathable(blocked(square(20, 30, 40, 50)), { x: 30, y: 40 }, { revealed })).toEqual(
      { ok: false, reason: 'unrevealed' },
    )
  })

  it('refuses seen blocked ground as unpathable even beside unseen pathable ground', () => {
    // Seen vertices within reach are all blocked; the pathable ones there are unseen.
    const disk = blocked(square(28, 38, 32, 42))
    const revealed = fogged(
      square(20, 30, 40, 50).filter(([x, y]) => x < 28 || x > 32 || y < 38 || y > 42),
    )
    expect(snapToPathable(disk, { x: 30, y: 40 }, { revealed })).toEqual({
      ok: false,
      reason: 'unpathable',
    })
  })

  it('refuses a revealed mask of another size', () => {
    expect(
      terrainErrorOf(() => snapToPathable(base, { x: 0, y: 0 }, { revealed: new Uint8Array(4) }))
        ?.code,
    ).toBe('INVALID_GRID')
  })
})
