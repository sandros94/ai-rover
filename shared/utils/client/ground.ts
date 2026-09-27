import type { Chunk } from '../terrain/chunk'
import type { GridCell, HeightGrid } from '../terrain/grid'
import type { StopManifest } from '../terrain/manifest'
import { ClientError } from './errors'
import type { GridRect } from './fog'

/**
 * A stop disk's grid filled in as its chunks arrive, laid out as `assembleDiskGrid` lays out the
 * whole disk: NaN wherever no chunk is placed yet.
 */
export interface DiskGround {
  readonly grid: HeightGrid
  readonly origin: GridCell
  /** The stop, world metres, and the radius of its survey: the manifest's. */
  readonly center: { x: number; y: number }
  readonly radius: number
  /** Vertex rectangles of the chunks placed, in the order placed; only ever grows. */
  readonly placed: readonly GridRect[]
  /** Every listed chunk is placed. */
  readonly complete: boolean
  /**
   * Copies the chunk's heights in and gives its vertex rectangle; undefined for a chunk the
   * manifest does not list or one already placed.
   */
  place(chunk: Chunk): GridRect | undefined
}

/** Vertices per side of the manifest's chunks. */
export function chunkVerticesOf(manifest: {
  world: Pick<StopManifest['world'], 'chunkSize' | 'cellSize'>
}): number {
  const { chunkSize, cellSize } = manifest.world
  const cells = chunkSize / cellSize
  if (!Number.isSafeInteger(cells) || cells < 1) {
    throw new ClientError(
      'INVALID_INPUT',
      `Chunks of ${chunkSize} m at ${cellSize} m cells; pass a manifest whose chunks hold a whole number of cells.`,
    )
  }
  return cells + 1
}

/** The disk the manifest lists, with no chunk placed. */
export function createDiskGround(
  manifest: Pick<StopManifest, 'chunks' | 'radius'> & {
    stop: { x: number; y: number }
    world: Pick<StopManifest['world'], 'chunkSize' | 'cellSize'>
  },
): DiskGround {
  const { cellSize } = manifest.world
  if (manifest.chunks.length === 0) {
    throw new ClientError('INVALID_INPUT', 'createDiskGround: the manifest lists no chunk.')
  }
  const vertexCount = chunkVerticesOf(manifest)
  const cells = vertexCount - 1
  let minCx = Infinity
  let maxCx = -Infinity
  let minCy = Infinity
  let maxCy = -Infinity
  for (const { cx, cy } of manifest.chunks) {
    minCx = Math.min(minCx, cx)
    maxCx = Math.max(maxCx, cx)
    minCy = Math.min(minCy, cy)
    maxCy = Math.max(maxCy, cy)
  }
  const width = (maxCx - minCx + 1) * cells + 1
  const height = (maxCy - minCy + 1) * cells + 1
  const grid: HeightGrid = {
    heights: new Float32Array(width * height).fill(Number.NaN),
    width,
    height,
    cellSize,
  }
  const pending = new Set(manifest.chunks.map(({ cx, cy }) => `${cx},${cy}`))
  const placed: GridRect[] = []

  function place(chunk: Chunk): GridRect | undefined {
    const key = `${chunk.cx},${chunk.cy}`
    if (!pending.has(key)) return undefined
    if (chunk.vertexCount !== vertexCount || chunk.cellSize !== cellSize) {
      throw new ClientError(
        'DECODE',
        `Chunk (${chunk.cx}, ${chunk.cy}) has ${chunk.vertexCount} vertices at ${chunk.cellSize} m; the manifest's chunks have ${vertexCount} at ${cellSize} m.`,
      )
    }
    pending.delete(key)
    const i0 = (chunk.cx - minCx) * cells
    const j0 = (chunk.cy - minCy) * cells
    for (let b = 0; b < vertexCount; b++) {
      const from = b * vertexCount
      grid.heights.set(chunk.heights.subarray(from, from + vertexCount), (j0 + b) * width + i0)
    }
    const rect = { i0, j0, i1: i0 + vertexCount, j1: j0 + vertexCount }
    placed.push(rect)
    return rect
  }

  return {
    grid,
    origin: { i: minCx * cells, j: minCy * cells },
    center: { x: manifest.stop.x, y: manifest.stop.y },
    radius: manifest.radius,
    placed,
    get complete() {
      return pending.size === 0
    },
    place,
  }
}

/**
 * Ground as a view draws it at one moment: a whole grid, or one still arriving with the
 * rectangles that hold heights so far.
 */
export interface GroundView {
  grid: HeightGrid
  origin: GridCell
  /** Heights at the ends of the tint, fixed for the disk; by default the grid's own span. */
  heightRange?: { min: number; max: number }
  /**
   * Vertex rectangles holding heights, in arrival order; for one grid a later view only adds to
   * them. Absent: the whole grid holds heights.
   */
  placed?: readonly GridRect[]
  /** Every rectangle the grid will hold is in `placed`; implied when `placed` is absent. */
  complete?: boolean
}

/** A snapshot of `ground` to hand a view, `placed` copied so the view it gives never changes. */
export function groundView(
  ground: DiskGround,
  heightRange?: { min: number; max: number },
): GroundView {
  return {
    grid: ground.grid,
    origin: ground.origin,
    heightRange,
    placed: ground.placed.slice(),
    complete: ground.complete,
  }
}

/** One square of contour lines: `tile` cells a side, its vertices up to the far edge included. */
export interface ContourTile {
  /** Row-major over the grid's tiles. */
  index: number
  rect: GridRect
}

/**
 * The contour tiles of `tile` cells sharing a vertex with `area`, those that may be drawn now:
 * every tile of a `complete` grid, else only tiles whose vertices all hold heights, so a tile is
 * traced once its chunks are in rather than again with each chunk.
 */
export function contourTiles(
  grid: Pick<HeightGrid, 'heights' | 'width' | 'height'>,
  area: GridRect,
  options: { tile: number; complete: boolean },
): ContourTile[] {
  const { width, height, heights } = grid
  const { tile, complete } = options
  const tilesX = Math.ceil((width - 1) / tile)
  // A tile holds cells [t·T, (t+1)·T): the vertices up to (t+1)·T inclusive.
  const first = (v: number) => Math.max(0, Math.floor((v - 1) / tile))
  const last = (v: number, size: number) =>
    Math.min(Math.ceil((size - 1) / tile), Math.ceil(v / tile)) - 1
  const tiles: ContourTile[] = []
  for (let ty = first(area.j0); ty <= last(area.j1, height); ty++) {
    for (let tx = first(area.i0); tx <= last(area.i1, width); tx++) {
      const rect = {
        i0: tx * tile,
        j0: ty * tile,
        i1: Math.min(width, (tx + 1) * tile + 1),
        j1: Math.min(height, (ty + 1) * tile + 1),
      }
      if (complete || filled(heights, width, rect)) tiles.push({ index: ty * tilesX + tx, rect })
    }
  }
  return tiles
}

function filled(heights: Float32Array, width: number, rect: GridRect): boolean {
  for (let j = rect.j0; j < rect.j1; j++) {
    for (let i = rect.i0; i < rect.i1; i++) if (Number.isNaN(heights[j * width + i]!)) return false
  }
  return true
}
