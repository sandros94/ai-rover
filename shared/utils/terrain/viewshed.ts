import type { GridCell, HeightGrid } from './grid'
import { TerrainError } from './errors'
import { assertCellInGrid, assertHeightGrid } from './grid'

/**
 * Line-of-sight visibility from `mastHeight` metres above the viewer vertex, by XDraw ring sweep
 * (O(cells)). Returns 1 per visible vertex; vertices farther than `radius` cells (euclidean) are 0.
 *
 * With `revealed` (one byte per vertex), only revealed heights are read: an unrevealed vertex is
 * never visible and blocks nothing, the horizon passing over it unchanged, and an unrevealed
 * viewer sees nothing.
 *
 * XDraw interpolates each ray's horizon from the previous ring, so it disagrees with exact
 * per-ray casting on roughly 1 % of cells near occluding edges.
 */
export function viewshed(
  grid: HeightGrid,
  options: { viewer: GridCell; mastHeight: number; radius: number; revealed?: Uint8Array },
): Uint8Array {
  assertHeightGrid(grid, 'viewshed')
  const { viewer, mastHeight, radius, revealed } = options
  assertCellInGrid(viewer, grid.width, grid.height, 'viewshed')
  const { heights, width, height, cellSize } = grid
  if (revealed && revealed.length !== width * height) {
    throw new TerrainError(
      'INVALID_GRID',
      `viewshed: revealed holds ${revealed.length} flags but the grid is ${width}×${height} (${width * height}); pass one byte per vertex.`,
    )
  }
  const out = new Uint8Array(width * height)
  const vi = viewer.i
  const vj = viewer.j
  const vk = vj * width + vi
  if (revealed && !revealed[vk]) return out
  out[vk] = 1
  if (!(radius > 0)) return out

  const z0 = heights[vk]! + mastHeight
  const radius2 = radius * radius
  /** Steepest line-of-sight tangent from the viewer up to and including each processed cell. */
  const horizon = new Float64Array(width * height)
  horizon[vk] = -Infinity
  const rings = Math.min(Math.floor(radius), Math.max(vi, width - 1 - vi, vj, height - 1 - vj))

  const visit = (di: number, dj: number, d: number): void => {
    const i = vi + di
    const j = vj + dj
    if (i < 0 || j < 0 || i >= width || j >= height) return
    const k = j * width + i
    let threshold = -Infinity
    if (d > 1) {
      const scale = (d - 1) / d
      if (di === d || di === -d) {
        const pi = vi + (di > 0 ? d - 1 : 1 - d)
        const py = dj * scale
        const y0 = Math.floor(py)
        const f = py - y0
        const a = horizon[(vj + y0) * width + pi]!
        threshold = f === 0 ? a : a + (horizon[(vj + y0 + 1) * width + pi]! - a) * f
      } else {
        const pj = vj + (dj > 0 ? d - 1 : 1 - d)
        const px = di * scale
        const x0 = Math.floor(px)
        const f = px - x0
        const a = horizon[pj * width + vi + x0]!
        threshold = f === 0 ? a : a + (horizon[pj * width + vi + x0 + 1]! - a) * f
      }
    }
    if (revealed && !revealed[k]) {
      horizon[k] = threshold
      return
    }
    const dist2 = di * di + dj * dj
    const tan = (heights[k]! - z0) / (Math.sqrt(dist2) * cellSize)
    if (dist2 <= radius2 && tan >= threshold) out[k] = 1
    horizon[k] = tan > threshold ? tan : threshold
  }

  for (let d = 1; d <= rings; d++) {
    for (let t = -d; t <= d; t++) {
      visit(t, -d, d)
      visit(t, d, d)
    }
    for (let t = -d + 1; t <= d - 1; t++) {
      visit(-d, t, d)
      visit(d, t, d)
    }
  }
  return out
}
