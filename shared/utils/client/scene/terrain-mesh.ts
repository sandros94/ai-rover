import type { Chunk } from '../../terrain/chunk'
import type { GridCell, HeightGrid } from '../../terrain/grid'
import { ClientError } from '../errors'
import type { Rgb } from './palette'
import { fogRgb, hillshadeAt, reliefLight, reliefRgb, srgbToLinear } from './palette'

/** Vertex strides of the terrain levels: full resolution, then one vertex in four each way. */
export const LOD_STEPS = [1, 4] as const
export type LodLevel = 0 | 1
/** Chunks farther than this from the rover drop to the coarse level. */
export const LOD_FAR_M = 150
/** Extra distance a coarse chunk must close, or a fine one open, before it switches. */
export const LOD_HYSTERESIS_M = 16
/** Skirt depth below chunk edges: covers the gap where a coarse chunk meets a fine one. */
export const DEFAULT_SKIRT_M = 3

export type TerrainChunk = Pick<Chunk, 'cx' | 'cy' | 'vertexCount' | 'cellSize' | 'heights'>

export interface ChunkMeshOptions {
  /** Height mapped to the ends of the colour ramp; the same for every chunk of a scene. */
  heightRange: { min: number; max: number }
  /** Vertex stride; must divide the chunk's cells. Default 1. */
  step?: number
  /** Depth of the skirt hung below the edges; 0 (the default) hangs none. */
  skirtM?: number
  /** One byte per chunk vertex, 0 where the rover has not seen; absent means all seen. */
  seen?: Uint8Array
  /**
   * Height at a world vertex index outside the chunk, so edge shading uses the neighbour's
   * ground and matches it across the seam; undefined falls back to a one-sided difference.
   */
  heightOutside?: (i: number, j: number) => number | undefined
}

export interface ChunkMesh {
  /** World metres of the chunk's (0, 0) vertex; positions are relative to it for float32 precision. */
  origin: { x: number; y: number }
  /** Vertices per side of the surface grid, before the skirt. */
  side: number
  /** x, y, z per vertex: the surface grid row by row, then the skirt. */
  positions: Float32Array
  /** Linear r, g, b per vertex: ramp × hillshade, fogged where unseen. */
  colors: Float32Array
  indices: Uint16Array | Uint32Array
}

/**
 * Triangle mesh of a chunk at a vertex stride. The surface is one indexed grid, so each vertex
 * is shared by every triangle around it; with a skirt, the edge vertices are repeated `skirtM`
 * lower and joined to the edge by outward-facing walls. Shading is baked into the colours with
 * the 2D map's hillshade, so the scene needs no terrain lighting.
 */
export function chunkMesh(chunk: TerrainChunk, options: ChunkMeshOptions): ChunkMesh {
  const { vertexCount: n, cellSize, heights, cx, cy } = chunk
  const { heightRange, step = 1, skirtM = 0, seen, heightOutside } = options
  const cells = n - 1
  if (!Number.isInteger(step) || step < 1 || cells % step !== 0) {
    throw new ClientError(
      'INVALID_INPUT',
      `chunkMesh: step ${step} does not divide the chunk's ${cells} cells; pass a divisor.`,
    )
  }
  if (heights.length !== n * n || (seen && seen.length !== n * n)) {
    throw new ClientError(
      'INVALID_INPUT',
      `chunkMesh: chunk (${cx}, ${cy}) has ${heights.length} heights and ${seen?.length ?? n * n} seen flags for ${n}×${n} vertices; pass one per vertex.`,
    )
  }
  const side = cells / step + 1
  const baseI = cx * cells
  const baseJ = cy * cells
  const span = heightRange.max - heightRange.min || 1

  const heightAt = (a: number, b: number): number | undefined => {
    if (a >= 0 && a < n && b >= 0 && b < n) return heights[b * n + a]
    return heightOutside?.(baseI + a, baseJ + b)
  }
  /** Central difference over the step, one-sided where the far side has no height. */
  const gradient = (a: number, b: number, da: number, db: number): number => {
    const here = heights[b * n + a]!
    const ahead = heightAt(a + da * step, b + db * step)
    const behind = heightAt(a - da * step, b - db * step)
    if (ahead !== undefined && behind !== undefined) return (ahead - behind) / (2 * step * cellSize)
    if (ahead !== undefined) return (ahead - here) / (step * cellSize)
    if (behind !== undefined) return (here - behind) / (step * cellSize)
    return 0
  }

  const edge = boundary(side)
  const skirt = skirtM > 0 ? edge.length : 0
  const total = side * side + skirt
  const positions = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)
  for (let q = 0; q < side; q++) {
    for (let p = 0; p < side; p++) {
      const a = p * step
      const b = q * step
      const k = q * side + p
      const h = heights[b * n + a]!
      positions[3 * k] = a * cellSize
      positions[3 * k + 1] = b * cellSize
      positions[3 * k + 2] = h
      const light = reliefLight(hillshadeAt(gradient(a, b, 1, 0), gradient(a, b, 0, 1)))
      const ramp = reliefRgb((h - heightRange.min) / span)
      let rgb: Rgb = [ramp[0] * light, ramp[1] * light, ramp[2] * light]
      if (seen && !seen[b * n + a]) rgb = fogRgb(rgb)
      colors[3 * k] = srgbToLinear(rgb[0])
      colors[3 * k + 1] = srgbToLinear(rgb[1])
      colors[3 * k + 2] = srgbToLinear(rgb[2])
    }
  }
  for (let e = 0; e < skirt; e++) {
    const from = edge[e]!
    const to = side * side + e
    positions[3 * to] = positions[3 * from]!
    positions[3 * to + 1] = positions[3 * from + 1]!
    positions[3 * to + 2] = positions[3 * from + 2]! - skirtM
    colors.copyWithin(3 * to, 3 * from, 3 * from + 3)
  }

  const count = (side - 1) * (side - 1) * 6 + skirt * 6
  const indices = total > 0xffff ? new Uint32Array(count) : new Uint16Array(count)
  let t = 0
  for (let q = 0; q < side - 1; q++) {
    for (let p = 0; p < side - 1; p++) {
      const k00 = q * side + p
      const k10 = k00 + 1
      const k01 = k00 + side
      const k11 = k01 + 1
      indices.set([k00, k10, k11, k00, k11, k01], t)
      t += 6
    }
  }
  // Walking the boundary counter-clockwise from above, the outside is to the right.
  for (let e = 0; e < skirt; e++) {
    const f = (e + 1) % skirt
    const ep = edge[e]!
    const eq = edge[f]!
    const sp = side * side + e
    const sq = side * side + f
    indices.set([sp, sq, eq, sp, eq, ep], t)
    t += 6
  }

  return {
    origin: { x: baseI * cellSize, y: baseJ * cellSize },
    side,
    positions,
    colors,
    indices,
  }
}

/** Surface vertex indices around the grid edge, counter-clockwise from above, from (0, 0). */
function boundary(side: number): number[] {
  const out: number[] = []
  const last = side - 1
  for (let p = 0; p < last; p++) out.push(p)
  for (let q = 0; q < last; q++) out.push(q * side + last)
  for (let p = last; p > 0; p--) out.push(last * side + p)
  for (let q = last; q > 0; q--) out.push(q * side)
  return out
}

/** The level a chunk at `distanceM` from the rover should show, holding `current` inside the hysteresis band. */
export function chunkLevel(distanceM: number, current?: LodLevel): LodLevel {
  if (distanceM > LOD_FAR_M + LOD_HYSTERESIS_M) return 1
  if (distanceM < LOD_FAR_M) return 0
  return current ?? 0
}

/** Distance in the plane from `point` to the chunk's square; 0 inside it. */
export function chunkDistance(
  chunk: Pick<Chunk, 'cx' | 'cy' | 'vertexCount' | 'cellSize'>,
  point: { x: number; y: number },
): number {
  const size = (chunk.vertexCount - 1) * chunk.cellSize
  const x0 = chunk.cx * size
  const y0 = chunk.cy * size
  const dx = Math.max(x0 - point.x, 0, point.x - (x0 + size))
  const dy = Math.max(y0 - point.y, 0, point.y - (y0 + size))
  return Math.hypot(dx, dy)
}

/**
 * Cuts a stitched grid (as `assembleDiskGrid` or the dev disk route lays one out) back into its
 * chunks of `vertexCount` vertices, row by row from the south-west; chunks with any missing
 * height are skipped. `seen`, one byte per grid vertex, is cut alongside.
 */
export function chunksFromGrid(
  grid: HeightGrid,
  origin: GridCell,
  vertexCount: number,
  seen?: Uint8Array,
): { chunk: TerrainChunk; seen: Uint8Array | undefined }[] {
  const { heights, width, height, cellSize } = grid
  const cells = vertexCount - 1
  if (origin.i % cells !== 0 || origin.j % cells !== 0) {
    throw new ClientError(
      'INVALID_INPUT',
      `chunksFromGrid: grid origin (${origin.i}, ${origin.j}) is not on a corner of ${cells}-cell chunks; pass a grid stitched from whole chunks.`,
    )
  }
  const cx0 = origin.i / cells
  const cy0 = origin.j / cells
  const out: { chunk: TerrainChunk; seen: Uint8Array | undefined }[] = []
  for (let gy = 0; gy + cells < height; gy += cells) {
    for (let gx = 0; gx + cells < width; gx += cells) {
      const chunkHeights = new Float32Array(vertexCount * vertexCount)
      const chunkSeen = seen && new Uint8Array(vertexCount * vertexCount)
      let complete = true
      for (let b = 0; b < vertexCount && complete; b++) {
        const from = (gy + b) * width + gx
        const row = heights.subarray(from, from + vertexCount)
        if (row.some(Number.isNaN)) complete = false
        chunkHeights.set(row, b * vertexCount)
        chunkSeen?.set(seen!.subarray(from, from + vertexCount), b * vertexCount)
      }
      if (!complete) continue
      out.push({
        chunk: {
          cx: cx0 + gx / cells,
          cy: cy0 + gy / cells,
          vertexCount,
          cellSize,
          heights: chunkHeights,
        },
        seen: chunkSeen,
      })
    }
  }
  return out
}
