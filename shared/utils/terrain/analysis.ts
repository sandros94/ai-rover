import type { GridCell, HeightGrid } from './grid'
import { TerrainError } from './errors'
import { assertCellInGrid, assertGridShape, assertHeightGrid } from './grid'

/**
 * Gradient magnitude (rise over run, i.e. tan of the slope angle) at a vertex: central differences
 * inside the grid, one-sided along its edges.
 */
export function slopeAt(grid: HeightGrid, cell: GridCell): number {
  assertHeightGrid(grid, 'slopeAt')
  assertCellInGrid(cell, grid.width, grid.height, 'slopeAt')
  return Math.sqrt(gradient2(grid, cell.i, cell.j))
}

/** Per vertex: 1 where the slope is at most `slopeLimitDeg`, else 0. */
export function traversableMask(grid: HeightGrid, options: { slopeLimitDeg: number }): Uint8Array {
  assertHeightGrid(grid, 'traversableMask')
  const limit = Math.tan((options.slopeLimitDeg * Math.PI) / 180)
  const limit2 = limit * limit
  const out = new Uint8Array(grid.width * grid.height)
  for (let j = 0; j < grid.height; j++) {
    for (let i = 0; i < grid.width; i++)
      out[j * grid.width + i] = gradient2(grid, i, j) <= limit2 ? 1 : 0
  }
  return out
}

/**
 * Per vertex: 1 where an 8-connected path over nonzero `traversable` cells joins it to `start`.
 * An untraversable start yields an all-zero mask.
 */
export function reachableFrom(
  traversable: Uint8Array,
  options: { width: number; height: number; start: GridCell },
): Uint8Array {
  const { width, height, start } = options
  assertGridShape(width, height, traversable.length, 'reachableFrom')
  assertCellInGrid(start, width, height, 'reachableFrom')
  const out = new Uint8Array(width * height)
  const first = start.j * width + start.i
  if (!traversable[first]) return out
  const stack = new Int32Array(width * height)
  let top = 0
  stack[top++] = first
  out[first] = 1
  while (top > 0) {
    const k = stack[--top]!
    const i = k % width
    const j = (k - i) / width
    for (let dj = -1; dj <= 1; dj++) {
      const nj = j + dj
      if (nj < 0 || nj >= height) continue
      for (let di = -1; di <= 1; di++) {
        const ni = i + di
        if (ni < 0 || ni >= width) continue
        const n = nj * width + ni
        if (out[n] || !traversable[n]) continue
        out[n] = 1
        stack[top++] = n
      }
    }
  }
  return out
}

/**
 * The traversable vertex nearest `start` (Euclidean, in vertices) no farther than `maxDistance`;
 * `start` itself when traversable, undefined when there is none. Equal distances go to the
 * lowest (j, i).
 */
export function nearestTraversable(
  traversable: Uint8Array,
  options: { width: number; height: number; start: GridCell; maxDistance: number },
): GridCell | undefined {
  const { width, height, start, maxDistance } = options
  assertGridShape(width, height, traversable.length, 'nearestTraversable')
  assertCellInGrid(start, width, height, 'nearestTraversable')
  if (!(maxDistance >= 0)) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `nearestTraversable: maxDistance is ${maxDistance}; pass a number of vertices of at least 0.`,
    )
  }
  const limit2 = maxDistance * maxDistance
  let best: GridCell | undefined
  let bestDistance2 = Infinity
  // Ring r holds the vertices at Chebyshev distance r, all at least r away; once r² exceeds the
  // best squared distance no later ring can hold a nearer or tied vertex.
  for (let r = 0; r * r <= Math.min(limit2, bestDistance2); r++) {
    for (let j = Math.max(0, start.j - r); j <= Math.min(height - 1, start.j + r); j++) {
      const edgeRow = j === start.j - r || j === start.j + r
      const step = edgeRow ? 1 : 2 * r
      for (let i = start.i - r; i <= start.i + r; i += step) {
        if (i < 0 || i >= width || !traversable[j * width + i]) continue
        const d2 = (i - start.i) ** 2 + (j - start.j) ** 2
        if (d2 > limit2) continue
        if (
          d2 < bestDistance2 ||
          (d2 === bestDistance2 && (j < best!.j || (j === best!.j && i < best!.i)))
        ) {
          best = { i, j }
          bestDistance2 = d2
        }
      }
    }
  }
  return best
}

function gradient2(grid: HeightGrid, i: number, j: number): number {
  const { heights: h, width, height, cellSize } = grid
  const k = j * width + i
  let gx = 0
  if (width > 1) {
    if (i === 0) gx = (h[k + 1]! - h[k]!) / cellSize
    else if (i === width - 1) gx = (h[k]! - h[k - 1]!) / cellSize
    else gx = (h[k + 1]! - h[k - 1]!) / (2 * cellSize)
  }
  let gy = 0
  if (height > 1) {
    if (j === 0) gy = (h[k + width]! - h[k]!) / cellSize
    else if (j === height - 1) gy = (h[k]! - h[k - width]!) / cellSize
    else gy = (h[k + width]! - h[k - width]!) / (2 * cellSize)
  }
  return gx * gx + gy * gy
}
