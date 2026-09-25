import { traversableMask } from './analysis'
import { TerrainError } from './errors'
import type { World } from './world'
import { sampleHeights } from './world'

/** Mask bit: slope at the vertex is within the world's slope limit. */
export const MASK_TRAVERSABLE = 1
/** Mask bit: the vertex has been seen by the rover. Never set by {@link generateChunk}. */
export const MASK_SEEN = 2

/**
 * A square block of terrain. Vertex (i, j), row-major, lies at world
 * `((cx · (vertexCount − 1) + i) · cellSize, (cy · (vertexCount − 1) + j) · cellSize)`, so
 * neighbouring chunks share their edge vertices.
 */
export interface Chunk {
  cx: number
  cy: number
  vertexCount: number
  cellSize: number
  heights: Float32Array
  /** Per-vertex bit set of `MASK_*` flags. */
  masks: Uint8Array
}

/** Chunk coordinates, stored as int32. */
export interface ChunkCoords {
  cx: number
  cy: number
}

/**
 * Generates chunk (cx, cy). Slopes are taken over a one-vertex apron, so edge masks use central
 * differences and match the neighbouring chunk's edge exactly.
 */
export function generateChunk(world: World, coords: ChunkCoords): Chunk {
  const { cx, cy } = coords
  assertChunkCoord('cx', cx)
  assertChunkCoord('cy', cy)
  const { chunkSize, cellSize, slopeLimitDeg } = world.config
  const cells = chunkSize / cellSize
  const vertexCount = cells + 1
  const apron = vertexCount + 2
  const apronHeights = sampleHeights(world, {
    originI: cx * cells - 1,
    originJ: cy * cells - 1,
    width: apron,
    height: apron,
  })
  const apronMask = traversableMask(
    { heights: apronHeights, width: apron, height: apron, cellSize },
    { slopeLimitDeg },
  )
  const heights = new Float32Array(vertexCount * vertexCount)
  const masks = new Uint8Array(vertexCount * vertexCount)
  for (let j = 0; j < vertexCount; j++) {
    const from = (j + 1) * apron + 1
    heights.set(apronHeights.subarray(from, from + vertexCount), j * vertexCount)
    for (let i = 0; i < vertexCount; i++)
      masks[j * vertexCount + i] = apronMask[from + i]! ? MASK_TRAVERSABLE : 0
  }
  return { cx, cy, vertexCount, cellSize, heights, masks }
}

export function assertChunkCoord(name: string, value: number): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `Chunk coordinate ${name} is ${value}; pass an integer within the int32 range.`,
    )
  }
}
