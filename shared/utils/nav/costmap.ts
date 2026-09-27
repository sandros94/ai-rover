import { slopeAt } from '../terrain/analysis'
import type { StopDisk } from '../terrain/disk'
import { assertFiniteAtLeast, NavError } from './errors'

export interface CostMapOptions {
  /** Weight of the squared normalised slope term. Default 4. */
  slopeWeight?: number
  /** Cost multiplier on vertices the rover has not seen; at least 1. Default 3. */
  unrevealedPenalty?: number
}

/** The cost map a plan uses for omitted fields. */
export const DEFAULT_COST_MAP: Readonly<Required<CostMapOptions>> = Object.freeze({
  slopeWeight: 4,
  unrevealedPenalty: 3,
})

/**
 * Traversal cost per disk-grid vertex, at least 1 wherever finite. A revealed vertex costs
 * `1 + slopeWeight · (tan slope / tan slopeLimit)²`, or `Infinity` when untraversable. An
 * unrevealed vertex costs `unrevealedPenalty` whatever its true slope: the rover has not seen it,
 * so the plan may cross it and the drive discovers what is there. `Infinity` wherever the vertex
 * has no height or lies beyond the survey. `revealed` is one byte per grid vertex (see
 * `revealedOverDisk`).
 */
export function buildCostMap(
  disk: StopDisk,
  options: { revealed: Uint8Array; slopeLimitDeg: number } & CostMapOptions,
): Float32Array {
  const {
    revealed,
    slopeLimitDeg,
    slopeWeight = DEFAULT_COST_MAP.slopeWeight,
    unrevealedPenalty = DEFAULT_COST_MAP.unrevealedPenalty,
  } = options
  const { grid, traversable, inside } = disk
  const { width, height } = grid
  if (revealed.length !== width * height) {
    throw new NavError(
      'INVALID_INPUT',
      `buildCostMap: revealed holds ${revealed.length} values but the disk grid is ${width}×${height} (${width * height}); pass revealedOverDisk(mask, disk).`,
    )
  }
  assertSlopeLimit(slopeLimitDeg, 'buildCostMap')
  assertFiniteAtLeast(slopeWeight, 0, 'slopeWeight', 'buildCostMap')
  assertFiniteAtLeast(unrevealedPenalty, 1, 'unrevealedPenalty', 'buildCostMap')

  const limit = Math.tan((slopeLimitDeg * Math.PI) / 180)
  const costs = new Float32Array(width * height).fill(Infinity)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = j * width + i
      if (!inside[k] || Number.isNaN(grid.heights[k])) continue
      if (!revealed[k]) {
        costs[k] = unrevealedPenalty
        continue
      }
      if (!traversable[k]) continue
      // Central differences skip the vertex's own height; a missing neighbour yields a NaN slope.
      const slope = slopeAt(grid, { i, j })
      if (Number.isNaN(slope)) continue
      const ratio = slope / limit
      costs[k] = 1 + slopeWeight * ratio * ratio
    }
  }
  return costs
}

export function assertSlopeLimit(slopeLimitDeg: number, context: string): void {
  if (!(slopeLimitDeg > 0 && slopeLimitDeg < 90)) {
    throw new NavError(
      'INVALID_INPUT',
      `${context}: slopeLimitDeg is ${slopeLimitDeg}; pass degrees strictly between 0 and 90.`,
    )
  }
}
