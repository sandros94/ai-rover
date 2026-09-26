import type { HeightGrid } from '../terrain/grid'
import { ClientError } from './errors'

/** Hillshade light: from the north-west (azimuth 315°), 45° above the horizon. */
const LIGHT_ALTITUDE = Math.PI / 4
const LIGHT = {
  x: -Math.cos(LIGHT_ALTITUDE) * Math.SQRT1_2,
  y: Math.cos(LIGHT_ALTITUDE) * Math.SQRT1_2,
  z: Math.sin(LIGHT_ALTITUDE),
}

/** Luma weights (Rec. 709) applied to the 8-bit channels, for greying fogged ground. */
export const LUMA = [0.2126, 0.7152, 0.0722] as const

/** Brightness kept on ground the rover has not seen: its luma times this. */
export const FOG_DIM = 0.45
/** Share of an unseen vertex's colour replaced by its own grey, 0 (none) to 1 (all). */
export const FOG_DESATURATE = 0.8

/**
 * Lambert shade in [0, 1] per vertex from central-difference normals (one-sided at the grid
 * edges); NaN where a neighbour has no height.
 */
export function hillshade(grid: HeightGrid): Float32Array {
  const { heights, width, height, cellSize } = grid
  const shade = new Float32Array(width * height)
  for (let j = 0; j < height; j++) {
    const j0 = Math.max(0, j - 1)
    const j1 = Math.min(height - 1, j + 1)
    for (let i = 0; i < width; i++) {
      const i0 = Math.max(0, i - 1)
      const i1 = Math.min(width - 1, i + 1)
      const gx = (heights[j * width + i1]! - heights[j * width + i0]!) / ((i1 - i0 || 1) * cellSize)
      const gy = (heights[j1 * width + i]! - heights[j0 * width + i]!) / ((j1 - j0 || 1) * cellSize)
      const dot = (-gx * LIGHT.x - gy * LIGHT.y + LIGHT.z) / Math.sqrt(gx * gx + gy * gy + 1)
      shade[j * width + i] = Math.max(0, dot)
    }
  }
  return shade
}

/**
 * The grid as RGBA pixels, one per vertex, image rows running north to south (grid row
 * `height − 1` first) so the picture is north up. A Mars ochre ramp over `heightRange` (default
 * the grid's own span), multiplied by the hillshade unless `hillshade` is false. Vertices with
 * `seen[k] === 0` are dimmed by {@link FOG_DIM} and greyed by {@link FOG_DESATURATE}, never
 * hidden; NaN heights are transparent.
 */
export function reliefPixels(
  grid: HeightGrid,
  options: {
    hillshade?: boolean
    seen?: Uint8Array
    heightRange?: { min: number; max: number }
  } = {},
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, heights } = grid
  const { seen } = options
  if (seen && seen.length !== width * height) {
    throw new ClientError(
      'INVALID_INPUT',
      `reliefPixels: seen holds ${seen.length} values but the grid is ${width}×${height} (${width * height}); pass one byte per vertex.`,
    )
  }
  const range = options.heightRange ?? heightSpan(heights)
  const span = range.max - range.min || 1
  const shade = options.hillshade === false ? undefined : hillshade(grid)
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let j = 0; j < height; j++) {
    const row = (height - 1 - j) * width
    for (let i = 0; i < width; i++) {
      const k = j * width + i
      const h = heights[k]!
      if (Number.isNaN(h)) continue
      const t = Math.min(1, Math.max(0, (h - range.min) / span))
      let r = 90 + 150 * t
      let g = 45 + 125 * t
      let b = 30 + 95 * t
      const s = shade?.[k]
      // Vertices bordering missing heights have no normal; they stay unshaded.
      if (s !== undefined && !Number.isNaN(s)) {
        const light = 0.25 + 0.95 * s
        r *= light
        g *= light
        b *= light
      }
      if (seen && !seen[k]) {
        const grey = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
        r = FOG_DIM * (r + FOG_DESATURATE * (grey - r))
        g = FOG_DIM * (g + FOG_DESATURATE * (grey - g))
        b = FOG_DIM * (b + FOG_DESATURATE * (grey - b))
      }
      const p = (row + i) * 4
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
