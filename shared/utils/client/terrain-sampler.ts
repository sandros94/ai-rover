import type { Chunk } from '../terrain/chunk'
import { MASK_TRAVERSABLE } from '../terrain/chunk'
import type { GridCell, HeightGrid } from '../terrain/grid'
import type { StopManifest } from '../terrain/manifest'
import type { ChunkCache } from './chunks'

/** A stop disk's terrain as the server's `computeStopDisk` lays it out. */
export interface DiskTerrain {
  /** The listed chunks stitched over their bounding box; NaN outside every listed chunk. */
  grid: HeightGrid
  /** World vertex index of grid vertex (0, 0). */
  origin: GridCell
  /** Per grid vertex: the chunks' traversable bit, 0 outside every listed chunk. */
  traversable: Uint8Array
}

export interface TerrainSampler {
  /** Bilinear over the vertices of the chunk under the point; undefined where none is loaded. */
  heightAt(x: number, y: number): number | undefined
  /** The traversable bit of the vertex nearest the point; undefined where none is loaded. */
  traversableAt(x: number, y: number): boolean | undefined
  /** The disk's grid once every chunk the manifest lists is loaded, else undefined. */
  assembleDiskGrid(manifest: Pick<StopManifest, 'chunks'>): DiskTerrain | undefined
}

/** Samples the chunks a cache holds, so terrain is read from served data, never regenerated. */
export function createTerrainSampler(cache: Pick<ChunkCache, 'peek' | 'geometry'>): TerrainSampler {
  /**
   * The loaded chunk holding world vertex (i, j) with the vertex's local index. A vertex on a
   * chunk edge is stored by up to four chunks, any of which will do.
   */
  function locate(i: number, j: number): { chunk: Chunk; a: number; b: number } | undefined {
    const geometry = cache.geometry
    if (!geometry) return undefined
    const cells = geometry.vertexCount - 1
    const cx = Math.floor(i / cells)
    const cy = Math.floor(j / cells)
    const a = i - cx * cells
    const b = j - cy * cells
    for (const [ox, oy] of NEIGHBOURS) {
      if ((ox && a !== 0) || (oy && b !== 0)) continue
      const chunk = cache.peek(cx - ox, cy - oy)
      if (chunk) return { chunk, a: a + ox * cells, b: b + oy * cells }
    }
    return undefined
  }

  function heightAt(x: number, y: number): number | undefined {
    const geometry = cache.geometry
    if (!geometry || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
    const { vertexCount, cellSize } = geometry
    const cells = vertexCount - 1
    const fi = x / cellSize
    const fj = y / cellSize
    // The cell's lower-left vertex, kept inside one chunk so all four corners come from it.
    const cx = Math.floor(fi / cells)
    const cy = Math.floor(fj / cells)
    const u = fi - cx * cells
    const w = fj - cy * cells
    let chunk = cache.peek(cx, cy)
    let a = Math.min(Math.floor(u), cells - 1)
    let b = Math.min(Math.floor(w), cells - 1)
    let du = u - a
    let dw = w - b
    if (!chunk) {
      // On a chunk's low edge the point also lies on its neighbour's high edge.
      const found = locateCorner(cx, cy, u, w, cells)
      if (!found) return undefined
      ;({ chunk, a, b, du, dw } = found)
    }
    const { heights } = chunk
    const k = b * vertexCount + a
    if (du === 0 && dw === 0) return heights[k]!
    const h00 = heights[k]!
    const h10 = heights[k + 1]!
    const h01 = heights[k + vertexCount]!
    const h11 = heights[k + vertexCount + 1]!
    return h00 * (1 - du) * (1 - dw) + h10 * du * (1 - dw) + h01 * (1 - du) * dw + h11 * du * dw
  }

  function locateCorner(cx: number, cy: number, u: number, w: number, cells: number) {
    for (const [ox, oy] of NEIGHBOURS) {
      if (ox + oy === 0 || (ox && u !== 0) || (oy && w !== 0)) continue
      const chunk = cache.peek(cx - ox, cy - oy)
      if (!chunk) continue
      const a = ox ? cells - 1 : Math.min(Math.floor(u), cells - 1)
      const b = oy ? cells - 1 : Math.min(Math.floor(w), cells - 1)
      return { chunk, a, b, du: ox ? 1 : u - a, dw: oy ? 1 : w - b }
    }
    return undefined
  }

  function traversableAt(x: number, y: number): boolean | undefined {
    const geometry = cache.geometry
    if (!geometry || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
    const found = locate(Math.round(x / geometry.cellSize), Math.round(y / geometry.cellSize))
    if (!found) return undefined
    return (found.chunk.masks[found.b * geometry.vertexCount + found.a]! & MASK_TRAVERSABLE) !== 0
  }

  function assembleDiskGrid(manifest: Pick<StopManifest, 'chunks'>): DiskTerrain | undefined {
    const geometry = cache.geometry
    if (!geometry || manifest.chunks.length === 0) return undefined
    const chunks: Chunk[] = []
    for (const { cx, cy } of manifest.chunks) {
      const chunk = cache.peek(cx, cy)
      if (!chunk) return undefined
      chunks.push(chunk)
    }
    const { vertexCount, cellSize } = geometry
    const cells = vertexCount - 1
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
    const heights = new Float32Array(width * height).fill(Number.NaN)
    const traversable = new Uint8Array(width * height)
    for (const chunk of chunks) {
      const gi = (chunk.cx - minCx) * cells
      const gj = (chunk.cy - minCy) * cells
      for (let b = 0; b < vertexCount; b++) {
        const from = b * vertexCount
        const to = (gj + b) * width + gi
        heights.set(chunk.heights.subarray(from, from + vertexCount), to)
        for (let a = 0; a < vertexCount; a++) {
          traversable[to + a] = chunk.masks[from + a]! & MASK_TRAVERSABLE ? 1 : 0
        }
      }
    }
    return {
      grid: { heights, width, height, cellSize },
      origin: { i: minCx * cells, j: minCy * cells },
      traversable,
    }
  }

  return { heightAt, traversableAt, assembleDiskGrid }
}

const NEIGHBOURS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const
