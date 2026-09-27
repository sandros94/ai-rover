import type { GridCell, HeightGrid } from '../terrain/grid'
import { viewshed } from '../terrain/viewshed'
import { ClientError } from './errors'
import type { GridRect } from './fog'

/**
 * How far, in cells, an eye standing on unrevealed ground looks for revealed ground under it: a
 * rover between two per-metre reveals may stand a step past the ground it has seen.
 */
export const EYE_SNAP_CELLS = 2

/**
 * What the rover has in line of sight now: one byte per vertex of `grid`, 1 where the vertex is
 * revealed and visible from `mastHeight` metres above `eye` within `radiusM`. Only revealed heights
 * are read: an unrevealed vertex is never in sight and hides nothing behind it, and a vertex with
 * no height yet (ground still arriving) is neither. An eye on unrevealed ground stands on the
 * nearest revealed vertex within {@link EYE_SNAP_CELLS}; with none, or off the grid, nothing is
 * in sight.
 */
export function currentSight(
  grid: HeightGrid,
  revealed: Uint8Array,
  eye: GridCell,
  options: { mastHeight: number; radiusM: number },
): Uint8Array {
  const viewer = standingVertex(grid, revealed, eye)
  if (!viewer) return new Uint8Array(grid.width * grid.height)
  return viewshed(grid, {
    viewer,
    mastHeight: options.mastHeight,
    radius: options.radiusM / grid.cellSize,
    revealed,
  })
}

/** The revealed vertex with a height nearest `eye` within {@link EYE_SNAP_CELLS}, `eye` first. */
function standingVertex(
  grid: HeightGrid,
  revealed: Uint8Array,
  eye: GridCell,
): GridCell | undefined {
  const { width, height, heights } = grid
  let best: GridCell | undefined
  let bestD2 = Infinity
  for (let dj = -EYE_SNAP_CELLS; dj <= EYE_SNAP_CELLS; dj++) {
    for (let di = -EYE_SNAP_CELLS; di <= EYE_SNAP_CELLS; di++) {
      const i = eye.i + di
      const j = eye.j + dj
      const d2 = di * di + dj * dj
      if (i < 0 || j < 0 || i >= width || j >= height || d2 >= bestD2) continue
      const k = j * width + i
      if (!revealed[k] || Number.isNaN(heights[k]!)) continue
      best = { i, j }
      bestD2 = d2
    }
  }
  return best
}

/**
 * The smallest rectangle holding every vertex whose flag differs between two masks of a grid
 * `width` wide; undefined when nothing differs.
 */
export function maskChange(
  before: Uint8Array,
  after: Uint8Array,
  width: number,
): GridRect | undefined {
  if (before.length !== after.length) {
    throw new ClientError(
      'INVALID_INPUT',
      `maskChange: masks of ${before.length} and ${after.length} flags; pass two masks of one grid.`,
    )
  }
  let rect: GridRect | undefined
  for (let k = 0; k < after.length; k++) {
    if (before[k] === after[k]) continue
    const i = k % width
    const j = (k - i) / width
    if (!rect) rect = { i0: i, j0: j, i1: i + 1, j1: j + 1 }
    else {
      if (i < rect.i0) rect.i0 = i
      if (i + 1 > rect.i1) rect.i1 = i + 1
      rect.j1 = j + 1
    }
  }
  return rect
}
