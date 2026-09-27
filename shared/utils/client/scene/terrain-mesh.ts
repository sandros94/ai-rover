import type { Chunk } from '../../terrain/chunk'
import type { GridCell, HeightGrid } from '../../terrain/grid'
import { ClientError } from '../errors'
import type { FogSurface, GridRect } from '../fog'
import type { Rgb } from './palette'
import { hillshadeAt, reliefLight, reliefRgb, srgbToLinear } from './palette'

/** Vertex strides of the terrain levels: full resolution, then one vertex in four each way. */
export const LOD_STEPS = [1, 4] as const
export type LodLevel = 0 | 1
/** Chunks farther than this from the rover drop to the coarse level. */
export const LOD_FAR_M = 150
/** Extra distance a coarse chunk must close, or a fine one open, before it switches. */
export const LOD_HYSTERESIS_M = 16
/** Skirt depth below chunk edges: covers the gap where a coarse chunk meets a fine one. */
export const DEFAULT_SKIRT_M = 3
/**
 * Vertex stride of a chunk the fog covers entirely: it shows only the smooth fog surface, so a
 * few vertices carry it, and the skirts close the seams with finer neighbours.
 */
export const FOG_STEP = 16

export type TerrainChunk = Pick<Chunk, 'cx' | 'cy' | 'vertexCount' | 'cellSize' | 'heights'>

export interface ChunkMeshOptions {
  /** Height mapped to the ends of the colour ramp; the same for every chunk of a scene. */
  heightRange: { min: number; max: number }
  /** Vertex stride; must divide the chunk's cells. Default 1. */
  step?: number
  /** Depth of the skirt hung below the edges; 0 (the default) hangs none. */
  skirtM?: number
  /** The disk's fog, laid out by `layout`, drawn in `rgb`; absent means nothing is fogged. */
  fog?: ChunkFog
  /**
   * Height at a world vertex index outside the chunk, so edge shading uses the neighbour's
   * ground and matches it across the seam; undefined falls back to a one-sided difference.
   */
  heightOutside?: (i: number, j: number) => number | undefined
}

/** The fog surface of the stop disk a chunk belongs to. */
export interface ChunkFog {
  surface: FogSurface
  layout: DiskLayout
  rgb: Readonly<Rgb>
}

export interface ChunkMesh {
  /** World metres of the chunk's (0, 0) vertex; positions are relative to it for float32 precision. */
  origin: { x: number; y: number }
  /** Vertices per side of the surface grid, before the skirt. */
  side: number
  /** x, y, z per vertex: the surface grid row by row, then the skirt. */
  positions: Float32Array
  /** Linear r, g, b per vertex: tint × hillshade, blended to the fog colour by the fog amount. */
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
  const { step = 1, skirtM = 0 } = options
  const cells = n - 1
  if (!Number.isInteger(step) || step < 1 || cells % step !== 0) {
    throw new ClientError(
      'INVALID_INPUT',
      `chunkMesh: step ${step} does not divide the chunk's ${cells} cells; pass a divisor.`,
    )
  }
  if (heights.length !== n * n) {
    throw new ClientError(
      'INVALID_INPUT',
      `chunkMesh: chunk (${cx}, ${cy}) has ${heights.length} heights for ${n}×${n} vertices; pass one per vertex.`,
    )
  }
  const side = cells / step + 1
  const baseI = cx * cells
  const baseJ = cy * cells
  const paint = vertexPainter(chunk, options)

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
      positions[3 * k] = a * cellSize
      positions[3 * k + 1] = b * cellSize
      paint(positions, colors, k, a, b)
    }
  }
  for (let e = 0; e < skirt; e++) {
    const from = edge[e]!
    const to = side * side + e
    positions[3 * to] = positions[3 * from]!
    positions[3 * to + 1] = positions[3 * from + 1]!
  }
  hangSkirt(positions, colors, side, skirtM)

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

/**
 * Writes the height and linear colour of chunk vertex (a, b) to vertex `k`: the tint × hillshade
 * from central differences over the step on the true heights, and, with fog, the drawn height and
 * the blend to the fog colour from the disk's fog surface. The one rule both {@link chunkMesh}
 * and {@link refogChunkMesh} use, so a refogged vertex equals a rebuilt one.
 */
function vertexPainter(
  chunk: TerrainChunk,
  options: ChunkMeshOptions,
): (positions: Float32Array, colors: Float32Array, k: number, a: number, b: number) => void {
  const { vertexCount: n, cellSize, heights, cx, cy } = chunk
  const { heightRange, step = 1, fog, heightOutside } = options
  const cells = n - 1
  const baseI = cx * cells
  const baseJ = cy * cells
  const span = heightRange.max - heightRange.min || 1
  const diskIndex = fog && diskIndexer(chunk, fog)
  const fogLinear = fog && fog.rgb.map(srgbToLinear)

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

  return (positions, colors, k, a, b) => {
    const d = diskIndex?.(a, b)
    const amount = d === undefined ? 0 : fog!.surface.amount[d]!
    positions[3 * k + 2] = d === undefined ? heights[b * n + a]! : fog!.surface.heights[d]!
    let r = 0
    let g = 0
    let bl = 0
    if (amount < 1) {
      const light = reliefLight(hillshadeAt(gradient(a, b, 1, 0), gradient(a, b, 0, 1)))
      const tint = reliefRgb((heights[b * n + a]! - heightRange.min) / span)
      r = srgbToLinear(tint[0] * light)
      g = srgbToLinear(tint[1] * light)
      bl = srgbToLinear(tint[2] * light)
    }
    if (amount > 0) {
      r += (fogLinear![0]! - r) * amount
      g += (fogLinear![1]! - g) * amount
      bl += (fogLinear![2]! - bl) * amount
    }
    colors[3 * k] = r
    colors[3 * k + 1] = g
    colors[3 * k + 2] = bl
  }
}

/** Disk-grid index of chunk vertex (a, b), or undefined off the disk grid. */
function diskIndexer(
  chunk: TerrainChunk,
  fog: Pick<ChunkFog, 'surface' | 'layout'>,
): (a: number, b: number) => number | undefined {
  const { width, origin } = fog.layout
  const rows = fog.surface.amount.length / width
  const cells = chunk.vertexCount - 1
  const i0 = chunk.cx * cells - origin.i
  const j0 = chunk.cy * cells - origin.j
  return (a, b) => {
    const i = i0 + a
    const j = j0 + b
    return i >= 0 && i < width && j >= 0 && j < rows ? j * width + i : undefined
  }
}

/** Sets the skirt, hung `skirtM` below the edge, to the edge's heights and colours. */
function hangSkirt(
  positions: Float32Array,
  colors: Float32Array,
  side: number,
  skirtM: number,
): void {
  if (skirtM <= 0) return
  const edge = boundary(side)
  for (let e = 0; e < edge.length; e++) {
    const from = edge[e]!
    const to = side * side + e
    positions[3 * to + 2] = positions[3 * from + 2]! - skirtM
    colors.copyWithin(3 * to, 3 * from, 3 * from + 3)
  }
}

/**
 * Rewrites, in place, the heights and colours of a mesh {@link chunkMesh} built with the same
 * step and skirt, to `options.fog`: what a reveal changes. Plan positions and indices are
 * untouched, so a fog change costs no new geometry.
 */
export function refogChunkMesh(
  mesh: ChunkMesh,
  chunk: TerrainChunk,
  options: ChunkMeshOptions,
): void {
  const { step = 1, skirtM = 0 } = options
  const side = mesh.side
  const paint = vertexPainter(chunk, options)
  for (let q = 0; q < side; q++)
    for (let p = 0; p < side; p++)
      paint(mesh.positions, mesh.colors, q * side + p, p * step, q * step)
  hangSkirt(mesh.positions, mesh.colors, side, skirtM)
}

/** Whether the fog covers every vertex of the chunk fully, so it may be drawn at {@link FOG_STEP}. */
export function chunkFogged(
  chunk: TerrainChunk,
  fog: Pick<ChunkFog, 'surface' | 'layout'>,
): boolean {
  const n = chunk.vertexCount
  const index = diskIndexer(chunk, fog)
  for (let b = 0; b < n; b++) {
    for (let a = 0; a < n; a++) {
      const d = index(a, b)
      if (d === undefined || fog.surface.amount[d] !== 1) return false
    }
  }
  return true
}

/** The disk-grid rectangle a chunk's vertices cover. */
export function chunkRect(
  chunk: Pick<Chunk, 'cx' | 'cy' | 'vertexCount'>,
  layout: DiskLayout,
): GridRect {
  const cells = chunk.vertexCount - 1
  const i0 = chunk.cx * cells - layout.origin.i
  const j0 = chunk.cy * cells - layout.origin.j
  return { i0, j0, i1: i0 + chunk.vertexCount, j1: j0 + chunk.vertexCount }
}

/** Layout of the stop disk grid that reveal vertex indices (`j · width + i`) refer to. */
export interface DiskLayout {
  width: number
  /** World vertex index of disk vertex 0. */
  origin: GridCell
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
 * height are skipped.
 */
export function chunksFromGrid(
  grid: HeightGrid,
  origin: GridCell,
  vertexCount: number,
): { chunk: TerrainChunk }[] {
  const cells = checkChunkOrigin(origin, vertexCount, 'chunksFromGrid')
  const out: { chunk: TerrainChunk }[] = []
  for (let gy = 0; gy + cells < grid.height; gy += cells) {
    for (let gx = 0; gx + cells < grid.width; gx += cells) {
      const coords = { cx: (origin.i + gx) / cells, cy: (origin.j + gy) / cells }
      const chunk = chunkFromGrid(grid, origin, vertexCount, coords)
      if (chunk) out.push({ chunk })
    }
  }
  return out
}

/**
 * The chunk (`cx`, `cy`) of `vertexCount` vertices cut from a stitched grid; undefined when any
 * of its heights is missing or it lies outside the grid.
 */
export function chunkFromGrid(
  grid: HeightGrid,
  origin: GridCell,
  vertexCount: number,
  coords: { cx: number; cy: number },
): TerrainChunk | undefined {
  const { heights, width, height, cellSize } = grid
  const cells = checkChunkOrigin(origin, vertexCount, 'chunkFromGrid')
  const gx = coords.cx * cells - origin.i
  const gy = coords.cy * cells - origin.j
  if (gx < 0 || gy < 0 || gx + cells >= width || gy + cells >= height) return undefined
  const chunkHeights = new Float32Array(vertexCount * vertexCount)
  for (let b = 0; b < vertexCount; b++) {
    const from = (gy + b) * width + gx
    const row = heights.subarray(from, from + vertexCount)
    if (row.some(Number.isNaN)) return undefined
    chunkHeights.set(row, b * vertexCount)
  }
  return { cx: coords.cx, cy: coords.cy, vertexCount, cellSize, heights: chunkHeights }
}

function checkChunkOrigin(origin: GridCell, vertexCount: number, caller: string): number {
  const cells = vertexCount - 1
  if (origin.i % cells !== 0 || origin.j % cells !== 0) {
    throw new ClientError(
      'INVALID_INPUT',
      `${caller}: grid origin (${origin.i}, ${origin.j}) is not on a corner of ${cells}-cell chunks; pass a grid stitched from whole chunks.`,
    )
  }
  return cells
}
