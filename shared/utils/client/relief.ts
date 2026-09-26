import type { GridCell, HeightGrid } from '../terrain/grid'
import { deriveSeed } from '../terrain/seed'
import type { FogState, GridRect } from './fog'
import { fogCover } from './fog'
import type { Rgb } from './scene/palette'
import { FOG_FILL, FOG_GRAIN, hillshadeAt, reliefLight, reliefRgb } from './scene/palette'

export { FOG_FILL, FOG_GRAIN, HILLSHADE_EXAGGERATION, LUMA } from './scene/palette'

/**
 * Lambert shade in [0, 1] per vertex from central-difference normals (one-sided at the grid
 * edges), slopes scaled by `exaggeration`; NaN where a neighbour has no height.
 */
export function hillshade(grid: HeightGrid, exaggeration?: number): Float32Array {
  const shade = new Float32Array(grid.width * grid.height)
  for (let j = 0; j < grid.height; j++)
    for (let i = 0; i < grid.width; i++)
      shade[j * grid.width + i] = shadeAt(grid, i, j, exaggeration)
  return shade
}

function shadeAt(grid: HeightGrid, i: number, j: number, exaggeration?: number): number {
  const { heights, width, height, cellSize } = grid
  const i0 = Math.max(0, i - 1)
  const i1 = Math.min(width - 1, i + 1)
  const j0 = Math.max(0, j - 1)
  const j1 = Math.min(height - 1, j + 1)
  const gx = (heights[j * width + i1]! - heights[j * width + i0]!) / ((i1 - i0 || 1) * cellSize)
  const gy = (heights[j1 * width + i]! - heights[j0 * width + i]!) / ((j1 - j0 || 1) * cellSize)
  return hillshadeAt(gx, gy, exaggeration)
}

/** The fog as the 2D map draws it: {@link FogState} with its fill and texture seed. */
export interface ReliefFog extends FogState {
  /** Fill of unseen ground; default the dark-mode fill. */
  rgb?: Readonly<Rgb>
  seed?: number
  /** World vertex of grid vertex (0, 0), so the texture stays put from one stop to the next. */
  origin?: GridCell
}

/**
 * The grid as RGBA pixels, one per vertex, image rows running north to south (grid row
 * `height − 1` first) so the picture is north up: the height tint over `heightRange` (default
 * the grid's own span) times the hillshade unless `hillshade` is false; NaN heights transparent.
 * With `fog`, unseen vertices are opaque fog texture, never relief, and revealed ground blends
 * into it by {@link fogCover}. With `rect`, only those vertices are painted, into `into` when
 * given (a full-size buffer), so a reveal repaints only what it changed.
 */
export function reliefPixels(
  grid: HeightGrid,
  options: {
    hillshade?: boolean
    heightRange?: { min: number; max: number }
    fog?: ReliefFog
    rect?: GridRect
    into?: Uint8ClampedArray<ArrayBuffer>
  } = {},
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, heights } = grid
  const { fog } = options
  const rect = options.rect ?? { i0: 0, j0: 0, i1: width, j1: height }
  const cover = fog && fogCover(fog, { width, height }, { rect })
  const range = options.heightRange ?? heightSpan(heights)
  const span = range.max - range.min || 1
  const shaded = options.hillshade !== false
  const fill = fog?.rgb ?? FOG_FILL.dark
  const grain = fog && fogGrain(fog.seed ?? 0)
  const oi = fog?.origin?.i ?? 0
  const oj = fog?.origin?.j ?? 0
  const pixels = options.into ?? new Uint8ClampedArray(width * height * 4)
  const rectWidth = rect.i1 - rect.i0
  for (let j = rect.j0; j < rect.j1; j++) {
    const row = (height - 1 - j) * width
    for (let i = rect.i0; i < rect.i1; i++) {
      const k = j * width + i
      const p = (row + i) * 4
      const h = heights[k]!
      if (Number.isNaN(h)) {
        pixels[p] = pixels[p + 1] = pixels[p + 2] = pixels[p + 3] = 0
        continue
      }
      const c = cover ? cover[(j - rect.j0) * rectWidth + (i - rect.i0)]! : 0
      let r = 0
      let g = 0
      let b = 0
      if (c < 1) {
        const tint = reliefRgb((h - range.min) / span)
        const s = shaded ? shadeAt(grid, i, j) : Number.NaN
        // Vertices bordering missing heights have no normal; they stay unshaded.
        const light = Number.isNaN(s) ? 1 : reliefLight(s)
        r = tint[0] * light
        g = tint[1] * light
        b = tint[2] * light
      }
      if (c > 0) {
        const n = 1 + FOG_GRAIN * grain!(oi + i, oj + j)
        r += (fill[0] * n - r) * c
        g += (fill[1] * n - g) * c
        b += (fill[2] * n - b) * c
      }
      pixels[p] = r
      pixels[p + 1] = g
      pixels[p + 2] = b
      pixels[p + 3] = 255
    }
  }
  return pixels
}

function heightSpan(heights: Float32Array): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const h of heights) {
    if (h < min) min = h
    if (h > max) max = h
  }
  return min <= max ? { min, max } : { min: 0, max: 1 }
}

/** Side of the tile the fog texture repeats on, vertices; a power of two. */
const GRAIN_TILE = 256
/** Lattice spacings of the texture's two octaves, vertices, and their weights. */
const GRAIN_OCTAVES = [
  { cell: 16, weight: 0.6 },
  { cell: 4, weight: 0.4 },
] as const
const grainTiles = new Map<number, Float32Array>()

/**
 * The fog texture for `seed`: value noise in [-1, 1] over world vertex (i, j), two octaves on
 * integer-hashed lattices, tiled every {@link GRAIN_TILE} vertices and built once per seed.
 */
function fogGrain(seed: number): (i: number, j: number) => number {
  let tile = grainTiles.get(seed)
  if (!tile) {
    tile = new Float32Array(GRAIN_TILE * GRAIN_TILE)
    for (const { cell, weight } of GRAIN_OCTAVES) {
      const lattice = GRAIN_TILE / cell
      const value = (a: number, b: number) =>
        deriveSeed(seed, cell, a % lattice, b % lattice) / 0xffffffff
      for (let y = 0; y < GRAIN_TILE; y++) {
        const b = Math.floor(y / cell)
        const fy = fade(y / cell - b)
        for (let x = 0; x < GRAIN_TILE; x++) {
          const a = Math.floor(x / cell)
          const fx = fade(x / cell - a)
          const bottom = value(a, b) + (value(a + 1, b) - value(a, b)) * fx
          const top = value(a, b + 1) + (value(a + 1, b + 1) - value(a, b + 1)) * fx
          const o = y * GRAIN_TILE + x
          tile[o] = tile[o]! + weight * (2 * (bottom + (top - bottom) * fy) - 1)
        }
      }
    }
    grainTiles.set(seed, tile)
  }
  const mask = GRAIN_TILE - 1
  const t = tile
  return (i, j) => t[(j & mask) * GRAIN_TILE + (i & mask)]!
}

function fade(t: number): number {
  return t * t * (3 - 2 * t)
}

/**
 * `seen` (one byte per disk vertex) with every vertex a drive's reveal groups name marked seen,
 * on a copy; `seen` itself when there is nothing to lift. Indices past the grid are ignored.
 */
export function liftSeen(
  seen: Uint8Array,
  reveals: readonly { vertices: ArrayLike<number> }[],
): Uint8Array {
  if (reveals.length === 0) return seen
  const lifted = seen.slice()
  for (const group of reveals) {
    for (let n = 0; n < group.vertices.length; n++) {
      const k = group.vertices[n]!
      if (k < lifted.length) lifted[k] = 1
    }
  }
  return lifted
}
