import { slopeAt } from '../../terrain/analysis'
import type { GridCell, HeightGrid } from '../../terrain/grid'

export interface SlopeSample {
  /** Along the route from its start, metres. */
  distanceM: number
  /** Ground slope at the nearest grid vertex; null where that vertex is unseen or off the grid. */
  slopeDeg: number | null
}

export interface SlopeProfile {
  lengthM: number
  samples: SlopeSample[]
}

const DEG = 180 / Math.PI

/**
 * The slope under a route every `stepM` metres from its start, plus its end. Unseen ground yields
 * no slope: route telemetry is public, and the slope of unseen ground would leak hidden terrain.
 */
export function slopeProfile(
  polyline: readonly { x: number; y: number }[],
  ground: { grid: HeightGrid; origin: GridCell; revealed: Uint8Array },
  options: { stepM?: number } = {},
): SlopeProfile {
  const { stepM = 2 } = options
  const { grid, origin, revealed } = ground
  const sample = (x: number, y: number): number | null => {
    const i = Math.round(x / grid.cellSize) - origin.i
    const j = Math.round(y / grid.cellSize) - origin.j
    if (i < 0 || j < 0 || i >= grid.width || j >= grid.height) return null
    const k = j * grid.width + i
    if (!revealed[k] || !Number.isFinite(grid.heights[k]!)) return null
    const slope = Math.atan(slopeAt(grid, { i, j })) * DEG
    return Number.isFinite(slope) ? slope : null
  }

  const legs: number[] = []
  let lengthM = 0
  for (let k = 1; k < polyline.length; k++) {
    const leg = Math.hypot(polyline[k]!.x - polyline[k - 1]!.x, polyline[k]!.y - polyline[k - 1]!.y)
    legs.push(leg)
    lengthM += leg
  }
  const samples: SlopeSample[] = []
  if (polyline.length === 0) return { lengthM, samples }
  let leg = 0
  let legStart = 0
  const count = Math.ceil(lengthM / stepM)
  for (let s = 0; s <= count; s++) {
    const d = Math.min(s * stepM, lengthM)
    while (leg < legs.length - 1 && legStart + legs[leg]! < d) legStart += legs[leg++]!
    const a = polyline[Math.min(leg, polyline.length - 1)]!
    const b = polyline[Math.min(leg + 1, polyline.length - 1)]!
    const u = legs[leg] ? (d - legStart) / legs[leg]! : 0
    samples.push({ distanceM: d, slopeDeg: sample(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u) })
  }
  return { lengthM, samples }
}
