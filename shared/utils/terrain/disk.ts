import { nearestTraversable, reachableFrom } from './analysis'
import type { ChunkCoords } from './chunk'
import { generateChunk, MASK_TRAVERSABLE } from './chunk'
import { TerrainError } from './errors'
import type { GridCell, HeightGrid } from './grid'
import { viewshed } from './viewshed'
import type { World } from './world'

/** Radius of a stop's survey when none is given, metres. */
export const DEFAULT_STOP_RADIUS = 500

/**
 * Ground beyond the survey a stop disk still carries, metres: the chunks reach this much past
 * the circle so shading, contours and the fog surface at its edge read real neighbours.
 */
export const SURVEY_MARGIN_M = 40

/** How far {@link snapToPathable} looks for a pathable vertex when none is given, metres. */
export const DEFAULT_SNAP_RADIUS = 5

/**
 * Everything the map and the planner need around one stationary point. The survey is the circle
 * of `radius` around `center`: nothing beyond it is seen, reached, planned over or picked.
 */
export interface StopDisk {
  /** World metres. */
  center: { x: number; y: number }
  /** The survey's radius, metres. */
  radius: number
  /**
   * Every chunk whose square comes within `radius` + {@link SURVEY_MARGIN_M} of the centre,
   * sorted by (cy, cx).
   */
  chunks: ChunkCoords[]
  /**
   * The listed chunks stitched over their bounding box, shared edges once. Vertices outside every
   * listed chunk (bounding-box corners) hold NaN.
   */
  grid: HeightGrid
  /** World vertex index of grid vertex (0, 0); world x = (origin.i + i) · cellSize. */
  origin: GridCell
  /** Per grid vertex: the chunks' traversable bit, 0 outside every listed chunk. */
  traversable: Uint8Array
  /** Per grid vertex: 1 within the survey, as {@link surveyMask} gives it. */
  inside: Uint8Array
  /**
   * Grid vertex the reachability flood fill starts from: the traversable vertex nearest the centre
   * vertex within the radius (lowest (j, i) on ties), or the centre vertex itself when there is none.
   */
  reachableFrom: GridCell
  /**
   * Per grid vertex: 8-connected to {@link StopDisk.reachableFrom} over traversable vertices
   * within the survey.
   */
  reachable: Uint8Array
  /**
   * Per grid vertex: within the survey and in line of sight from the world's mast height above
   * the centre vertex.
   */
  visible: Uint8Array
}

/**
 * Per vertex of a grid whose vertex (0, 0) is world vertex `origin`: 1 where the vertex lies
 * within `radius` metres of `center` (the survey), else 0.
 */
export function surveyMask(
  layout: { grid: Pick<HeightGrid, 'width' | 'height' | 'cellSize'>; origin: GridCell },
  survey: { center: { x: number; y: number }; radius: number },
): Uint8Array {
  const { width, height, cellSize } = layout.grid
  const { origin } = layout
  const { center, radius } = survey
  assertPoint(center, 'surveyMask')
  assertRadius(radius, 'surveyMask')
  const out = new Uint8Array(width * height)
  const radius2 = radius * radius
  for (let j = 0; j < height; j++) {
    const dy = (origin.j + j) * cellSize - center.y
    for (let i = 0; i < width; i++) {
      const dx = (origin.i + i) * cellSize - center.x
      if (dx * dx + dy * dy <= radius2) out[j * width + i] = 1
    }
  }
  return out
}

/** Nearest world vertex index to a point in world metres. */
export function worldToVertex(world: World, point: { x: number; y: number }): GridCell {
  assertPoint(point, 'worldToVertex')
  const { cellSize } = world.config
  return { i: Math.round(point.x / cellSize), j: Math.round(point.y / cellSize) }
}

/** Every chunk whose closed square comes within `radius` metres of `center`, sorted by (cy, cx). */
export function chunksCoveringDisk(
  world: World,
  options: { center: { x: number; y: number }; radius: number },
): ChunkCoords[] {
  const { center, radius } = options
  assertPoint(center, 'chunksCoveringDisk')
  assertRadius(radius, 'chunksCoveringDisk')
  const size = world.config.chunkSize
  const cy0 = Math.floor((center.y - radius) / size)
  const cy1 = Math.floor((center.y + radius) / size)
  const cx0 = Math.floor((center.x - radius) / size)
  const cx1 = Math.floor((center.x + radius) / size)
  const radius2 = radius * radius
  const chunks: ChunkCoords[] = []
  for (let cy = cy0; cy <= cy1; cy++) {
    const dy = axisGap(center.y, cy * size, (cy + 1) * size)
    for (let cx = cx0; cx <= cx1; cx++) {
      const dx = axisGap(center.x, cx * size, (cx + 1) * size)
      if (dx * dx + dy * dy <= radius2) chunks.push({ cx, cy })
    }
  }
  return chunks
}

/**
 * `chunks` nearest `center` first, measured to chunk centres, ties by `cx` then `cy`: the order a
 * stop's chunks are published in, so a reader streaming them gets the ground around the rover
 * first.
 */
export function chunksNearestFirst(
  chunks: readonly ChunkCoords[],
  options: { center: { x: number; y: number }; chunkSize: number },
): ChunkCoords[] {
  const { center, chunkSize } = options
  assertPoint(center, 'chunksNearestFirst')
  const distance = ({ cx, cy }: ChunkCoords) =>
    Math.hypot((cx + 0.5) * chunkSize - center.x, (cy + 0.5) * chunkSize - center.y)
  return chunks
    .map(({ cx, cy }) => ({ cx, cy, d: distance({ cx, cy }) }))
    .sort((p, q) => p.d - q.d || p.cx - q.cx || p.cy - q.cy)
    .map(({ cx, cy }) => ({ cx, cy }))
}

/** `chunks` sorted by (cy, cx), as a stop disk lists them. */
export function chunksByRow(chunks: readonly ChunkCoords[]): ChunkCoords[] {
  return chunks.map(({ cx, cy }) => ({ cx, cy })).sort((p, q) => p.cy - q.cy || p.cx - q.cx)
}

/**
 * Computes the disk around a stop: the survey of `radius` and its margin. Heights and
 * traversability come from {@link generateChunk}, so the grid agrees bit for bit with the chunk
 * blobs stored for it.
 */
export function computeStopDisk(
  world: World,
  options: { center: { x: number; y: number }; radius?: number },
): StopDisk {
  const center = { x: options.center.x, y: options.center.y }
  const radius = options.radius ?? DEFAULT_STOP_RADIUS
  assertRadius(radius, 'computeStopDisk')
  const chunks = chunksCoveringDisk(world, { center, radius: radius + SURVEY_MARGIN_M })
  const { chunkSize, cellSize, mastHeight } = world.config
  const cells = chunkSize / cellSize
  const vertexCount = cells + 1

  let minCx = Infinity
  let maxCx = -Infinity
  let minCy = Infinity
  let maxCy = -Infinity
  for (const { cx, cy } of chunks) {
    minCx = Math.min(minCx, cx)
    maxCx = Math.max(maxCx, cx)
    minCy = Math.min(minCy, cy)
    maxCy = Math.max(maxCy, cy)
  }
  const width = (maxCx - minCx + 1) * cells + 1
  const height = (maxCy - minCy + 1) * cells + 1
  const origin: GridCell = { i: minCx * cells, j: minCy * cells }
  const heights = new Float32Array(width * height).fill(Number.NaN)
  const traversable = new Uint8Array(width * height)
  for (const coords of chunks) {
    const chunk = generateChunk(world, coords)
    const gi = (coords.cx - minCx) * cells
    const gj = (coords.cy - minCy) * cells
    for (let b = 0; b < vertexCount; b++) {
      const from = b * vertexCount
      const to = (gj + b) * width + gi
      heights.set(chunk.heights.subarray(from, from + vertexCount), to)
      for (let a = 0; a < vertexCount; a++)
        traversable[to + a] = chunk.masks[from + a]! & MASK_TRAVERSABLE ? 1 : 0
    }
  }

  return completeStopDisk(
    { grid: { heights, width, height, cellSize }, origin, traversable },
    { center, radius, chunks, mastHeight },
  )
}

/**
 * A stop disk from its stitched grid: reachability and the viewshed from the centre, computed as
 * {@link computeStopDisk} does. A browser holding the served chunks rebuilds the server's disk
 * bit for bit this way, without generating terrain. `chunks` are the disk's listed chunks, sorted
 * by (cy, cx).
 */
export function completeStopDisk(
  terrain: { grid: HeightGrid; origin: GridCell; traversable: Uint8Array },
  options: {
    center: { x: number; y: number }
    radius: number
    chunks: readonly ChunkCoords[]
    mastHeight: number
  },
): StopDisk {
  const { grid, origin, traversable } = terrain
  const { radius, mastHeight } = options
  assertPoint(options.center, 'completeStopDisk')
  assertRadius(radius, 'completeStopDisk')
  const center = { x: options.center.x, y: options.center.y }
  const { width, height, cellSize } = grid
  const viewer: GridCell = {
    i: Math.round(center.x / cellSize) - origin.i,
    j: Math.round(center.y / cellSize) - origin.j,
  }
  const inside = surveyMask({ grid, origin }, { center, radius })
  const walkable = new Uint8Array(width * height)
  for (let k = 0; k < walkable.length; k++) walkable[k] = traversable[k]! & inside[k]!
  // The rover stands at the centre, so the ground around it is reachable even when the centre
  // vertex itself is too steep; the viewshed still starts from the centre vertex.
  const seed =
    nearestTraversable(walkable, {
      width,
      height,
      start: viewer,
      maxDistance: radius / cellSize,
    }) ?? viewer
  const reachable = reachableFrom(walkable, { width, height, start: seed })
  const visible = viewshed(grid, { viewer, mastHeight, radius: radius / cellSize })
  for (let k = 0; k < visible.length; k++) visible[k]! &= inside[k]!
  return {
    center,
    radius,
    chunks: options.chunks.map(({ cx, cy }) => ({ cx, cy })),
    grid,
    origin,
    traversable,
    inside,
    reachableFrom: seed,
    reachable,
    visible,
  }
}

/**
 * Why {@link snapToPathable} found no vertex. Closed set.
 *
 * - `unrevealed`: no vertex within the search radius has been seen, so nothing there may be picked.
 * - `unpathable`: seen vertices lie within the search radius but none is traversable and
 *   reachable, or no vertex of the disk lies there at all.
 * - `outside`: the point lies beyond the survey.
 */
export type SnapRefusal = 'unpathable' | 'unrevealed' | 'outside'

/**
 * The vertex nearest `point` that is seen, traversable, marked reachable and within the survey,
 * searched within `radiusM` (default {@link DEFAULT_SNAP_RADIUS}) of the point; a point beyond
 * the survey is refused as `outside`. Equal distances go to the lowest (j, i). The refusal is
 * decided from seen vertices and the survey only, so it never tells what unseen ground holds.
 */
export function snapToPathable(
  disk: StopDisk,
  point: { x: number; y: number },
  options: {
    /** One byte per disk-grid vertex, as `revealedOverDisk` gives it. */
    revealed: Uint8Array
    radiusM?: number
  },
): { ok: true; point: { x: number; y: number } } | { ok: false; reason: SnapRefusal } {
  assertPoint(point, 'snapToPathable')
  const { revealed } = options
  const radiusM = options.radiusM ?? DEFAULT_SNAP_RADIUS
  assertRadius(radiusM, 'snapToPathable')
  const { center, radius, origin, grid, traversable, reachable, inside } = disk
  const { width, height, cellSize } = grid
  if (revealed.length !== width * height) {
    throw new TerrainError(
      'INVALID_GRID',
      `snapToPathable: revealed holds ${revealed.length} values; the ${width}×${height} disk grid needs ${width * height}. Pass revealedOverDisk of this disk.`,
    )
  }
  if (Math.hypot(point.x - center.x, point.y - center.y) > radius) {
    return { ok: false, reason: 'outside' }
  }
  const reach = Math.ceil(radiusM / cellSize)
  const ci = Math.round(point.x / cellSize) - origin.i
  const cj = Math.round(point.y / cellSize) - origin.j
  let best: { x: number; y: number } | undefined
  let bestDistance = Infinity
  let candidates = false
  let seen = false
  for (let j = Math.max(0, cj - reach); j <= Math.min(height - 1, cj + reach); j++) {
    for (let i = Math.max(0, ci - reach); i <= Math.min(width - 1, ci + reach); i++) {
      const x = (origin.i + i) * cellSize
      const y = (origin.j + j) * cellSize
      const distance = Math.hypot(x - point.x, y - point.y)
      const k = j * width + i
      if (distance > radiusM || !inside[k]) continue
      candidates = true
      if (!revealed[k]) continue
      seen = true
      if (!traversable[k] || !reachable[k] || distance >= bestDistance) continue
      best = { x, y }
      bestDistance = distance
    }
  }
  if (best) return { ok: true, point: best }
  return { ok: false, reason: candidates && !seen ? 'unrevealed' : 'unpathable' }
}

/** Distance from `value` to the closed interval [lo, hi]. */
function axisGap(value: number, lo: number, hi: number): number {
  if (value < lo) return lo - value
  if (value > hi) return value - hi
  return 0
}

function assertPoint(point: { x: number; y: number }, context: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `${context}: point is (${point.x}, ${point.y}); pass finite world coordinates in metres.`,
    )
  }
}

function assertRadius(radius: number, context: string): void {
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `${context}: radius is ${radius}; pass a finite number of metres greater than 0.`,
    )
  }
}
