import { nearestTraversable, reachableFrom } from './analysis'
import type { ChunkCoords } from './chunk'
import { generateChunk, MASK_TRAVERSABLE } from './chunk'
import { TerrainError } from './errors'
import type { GridCell, HeightGrid } from './grid'
import { viewshed } from './viewshed'
import type { World } from './world'

/** Radius of a stop disk when none is given: twice the longest segment (250 m). */
export const DEFAULT_STOP_RADIUS = 500

/** How far {@link snapToPathable} looks for a pathable vertex when none is given, metres. */
export const DEFAULT_SNAP_RADIUS = 5

/** Everything the map and the planner need around one stationary point. */
export interface StopDisk {
  /** World metres. */
  center: { x: number; y: number }
  radius: number
  /** Every chunk whose square intersects the disk, sorted by (cy, cx). */
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
  /**
   * Grid vertex the reachability flood fill starts from: the traversable vertex nearest the centre
   * vertex within the radius (lowest (j, i) on ties), or the centre vertex itself when there is none.
   */
  reachableFrom: GridCell
  /** Per grid vertex: 8-connected to {@link StopDisk.reachableFrom} over traversable vertices. */
  reachable: Uint8Array
  /** Per grid vertex: in line of sight from the world's mast height above the centre vertex. */
  visible: Uint8Array
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
 * Computes the disk around a stop. Heights and traversability come from {@link generateChunk}, so
 * the grid agrees bit for bit with the chunk blobs stored for it.
 */
export function computeStopDisk(
  world: World,
  options: { center: { x: number; y: number }; radius?: number },
): StopDisk {
  const center = { x: options.center.x, y: options.center.y }
  const radius = options.radius ?? DEFAULT_STOP_RADIUS
  const chunks = chunksCoveringDisk(world, { center, radius })
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

  const grid: HeightGrid = { heights, width, height, cellSize }
  const vertex = worldToVertex(world, center)
  const viewer: GridCell = { i: vertex.i - origin.i, j: vertex.j - origin.j }
  // The rover stands at the centre, so the ground around it is reachable even when the centre
  // vertex itself is too steep; the viewshed still starts from the centre vertex.
  const seed =
    nearestTraversable(traversable, {
      width,
      height,
      start: viewer,
      maxDistance: radius / cellSize,
    }) ?? viewer
  const reachable = reachableFrom(traversable, { width, height, start: seed })
  const visible = viewshed(grid, { viewer, mastHeight, radius: radius / cellSize })
  return {
    center,
    radius,
    chunks,
    grid,
    origin,
    traversable,
    reachableFrom: seed,
    reachable,
    visible,
  }
}

/**
 * The vertex nearest `point` that is traversable, marked reachable and within the
 * disk radius, searched within `radiusM` (default {@link DEFAULT_SNAP_RADIUS}) of the point;
 * undefined when there is none. Equal distances go to the lowest (j, i).
 */
export function snapToPathable(
  disk: StopDisk,
  point: { x: number; y: number },
  options: { radiusM?: number } = {},
): { x: number; y: number } | undefined {
  assertPoint(point, 'snapToPathable')
  const radiusM = options.radiusM ?? DEFAULT_SNAP_RADIUS
  assertRadius(radiusM, 'snapToPathable')
  const { center, radius, origin, grid, traversable, reachable } = disk
  const { width, height, cellSize } = grid
  const reach = Math.ceil(radiusM / cellSize)
  const ci = Math.round(point.x / cellSize) - origin.i
  const cj = Math.round(point.y / cellSize) - origin.j
  let best: { x: number; y: number } | undefined
  let bestDistance = Infinity
  for (let j = Math.max(0, cj - reach); j <= Math.min(height - 1, cj + reach); j++) {
    for (let i = Math.max(0, ci - reach); i <= Math.min(width - 1, ci + reach); i++) {
      const k = j * width + i
      if (!traversable[k] || !reachable[k]) continue
      const x = (origin.i + i) * cellSize
      const y = (origin.j + j) * cellSize
      const distance = Math.hypot(x - point.x, y - point.y)
      if (distance > radiusM || distance >= bestDistance) continue
      if (Math.hypot(x - center.x, y - center.y) > radius) continue
      best = { x, y }
      bestDistance = distance
    }
  }
  return best
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
