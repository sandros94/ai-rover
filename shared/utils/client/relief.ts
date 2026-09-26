import type { HeightGrid } from '../terrain/grid'
import { ClientError } from './errors'
import { fogRgb, hillshadeAt, reliefLight, reliefRgb } from './scene/palette'

export { FOG_DESATURATE, FOG_DIM, LUMA } from './scene/palette'

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
      shade[j * width + i] = hillshadeAt(gx, gy)
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
      let rgb = reliefRgb((h - range.min) / span)
      const s = shade?.[k]
      // Vertices bordering missing heights have no normal; they stay unshaded.
      if (s !== undefined && !Number.isNaN(s)) {
        const light = reliefLight(s)
        rgb = [rgb[0] * light, rgb[1] * light, rgb[2] * light]
      }
      if (seen && !seen[k]) rgb = fogRgb(rgb)
      const [r, g, b] = rgb
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
