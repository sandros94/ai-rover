import type { SegmentPlan } from '../nav/plan'
import type { StopDisk } from '../terrain/disk'
import { MissionError } from './errors'
import type { MapPoint } from './rules'
import { distanceToPolyline } from './rules'

/** A goal's fog lying within this distance of a previously driven path is a leftover pocket, metres. */
export const POCKET_PATH_RADIUS_M = 20

/**
 * How much new ground a planned segment opens, each part 0 to 1.
 *
 * - `pathInFog`: share of the path length over unseen ground.
 * - `goalInFog`: 1 when the goal vertex is unseen, else 0.
 * - `pocket`: 1 when the goal's fog is enclosed by seen ground or the goal lies within
 *   {@link POCKET_PATH_RADIUS_M} of a path driven earlier in the mission, else that radius over
 *   the goal's distance to the nearest such path; 0 for a seen goal or with no path driven.
 */
export interface ExplorationParts {
  pathInFog: number
  goalInFog: number
  pocket: number
}

/** The weight of each part in {@link explorationValue}. */
export type ExplorationWeights = ExplorationParts

/** What the mission has done so far, all of it public. */
export interface MissionHistory {
  /** Paths driven by settled segments, world metres, as {@link drivenPath} gives them. */
  drivenPaths: readonly (readonly MapPoint[])[]
  /** Stops reached, most recent first. */
  recentStops: readonly MapPoint[]
}

/**
 * The parts of a planned segment's exploration value. Everything comes from public data: the
 * plan's own metrics, the revealed mask, the survey and past driven paths. The pocket reads only
 * the revealed mask, the survey and those paths, never heights or traversability, so it tells
 * nothing of what the fog holds.
 */
export function explorationParts(
  plan: SegmentPlan,
  options: {
    disk: Pick<StopDisk, 'grid' | 'origin' | 'inside'>
    /** One byte per disk-grid vertex, as `revealedOverDisk` gives it; the plan's own. */
    revealed: Uint8Array
    /** The goal the plan was made to, world metres. */
    goal: MapPoint
    history: Pick<MissionHistory, 'drivenPaths'>
  },
): ExplorationParts {
  const { disk, revealed, goal, history } = options
  const { width, height, cellSize } = disk.grid
  if (revealed.length !== width * height) {
    throw new MissionError(
      'INVALID_INPUT',
      `explorationParts: revealed holds ${revealed.length} values; the ${width}×${height} disk grid needs ${width * height}. Pass the revealedOverDisk the plan was made with.`,
    )
  }
  const i = Math.round(goal.x / cellSize) - disk.origin.i
  const j = Math.round(goal.y / cellSize) - disk.origin.j
  if (i < 0 || i >= width || j < 0 || j >= height || !disk.inside[j * width + i]) {
    throw new MissionError(
      'INVALID_INPUT',
      `explorationParts: goal (${goal.x}, ${goal.y}) lies beyond the disk's survey; pass the goal the plan was made to.`,
    )
  }
  const { metrics } = plan
  const inFog = !revealed[j * width + i]
  return {
    pathInFog: metrics.reached ? clamp01(metrics.unrevealedFraction) : 0,
    goalInFog: inFog ? 1 : 0,
    pocket: inFog ? pocketOf(disk, revealed, { i, j }, goal, history.drivenPaths) : 0,
  }
}

/** The weighted mean of the parts, 0 to 1. */
export function explorationValue(
  parts: ExplorationParts,
  options: { weights: ExplorationWeights },
): number {
  const { weights } = options
  const total = weights.pathInFog + weights.goalInFog + weights.pocket
  if (!(total > 0)) {
    throw new MissionError(
      'INVALID_INPUT',
      `explorationValue: the weights sum to ${total}; give at least one part a positive weight.`,
    )
  }
  return clamp01(
    (weights.pathInFog * parts.pathInFog +
      weights.goalInFog * parts.goalInFog +
      weights.pocket * parts.pocket) /
      total,
  )
}

/**
 * The path a settled segment drove, as public data gives it: its opening plan up to the point
 * nearest where the rover ended, then that end. Replans between them are left out; the pocket
 * radius absorbs what they moved.
 */
export function drivenPath(polyline: readonly MapPoint[], end: MapPoint): MapPoint[] {
  if (polyline.length === 0) return [{ x: end.x, y: end.y }]
  let best = { k: 0, t: 0, d: Infinity }
  for (let k = 0; k < Math.max(1, polyline.length - 1); k++) {
    const a = polyline[k]!
    const b = polyline[k + 1] ?? a
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSq = dx * dx + dy * dy
    const t =
      lengthSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((end.x - a.x) * dx + (end.y - a.y) * dy) / lengthSq))
    const d = Math.hypot(end.x - (a.x + t * dx), end.y - (a.y + t * dy))
    if (d < best.d) best = { k, t, d }
  }
  const a = polyline[best.k]!
  const b = polyline[best.k + 1] ?? a
  const cut = { x: a.x + best.t * (b.x - a.x), y: a.y + best.t * (b.y - a.y) }
  return [
    ...polyline.slice(0, best.k + 1).map(({ x, y }) => ({ x, y })),
    cut,
    { x: end.x, y: end.y },
  ]
}

/**
 * 1 when the unseen region holding the goal vertex never meets the survey circle, i.e. seen ground
 * encloses it; else by the goal's distance to the nearest driven path.
 */
function pocketOf(
  disk: Pick<StopDisk, 'grid' | 'inside'>,
  revealed: Uint8Array,
  start: { i: number; j: number },
  goal: MapPoint,
  paths: readonly (readonly MapPoint[])[],
): number {
  if (enclosed(disk, revealed, start)) return 1
  let nearest = Infinity
  for (const path of paths) {
    if (path.length > 0) nearest = Math.min(nearest, distanceToPolyline(goal, path))
  }
  if (nearest <= POCKET_PATH_RADIUS_M) return 1
  return Number.isFinite(nearest) ? POCKET_PATH_RADIUS_M / nearest : 0
}

/**
 * Floods 8-connected over unseen vertices within the survey from `start`; false as soon as the
 * region touches a vertex beyond the survey, where it could go on unseen.
 */
function enclosed(
  disk: Pick<StopDisk, 'grid' | 'inside'>,
  revealed: Uint8Array,
  start: { i: number; j: number },
): boolean {
  const { width, height } = disk.grid
  const { inside } = disk
  const visited = new Uint8Array(width * height)
  const stack = new Int32Array(width * height)
  let top = 0
  const first = start.j * width + start.i
  stack[top++] = first
  visited[first] = 1
  while (top > 0) {
    const k = stack[--top]!
    const i = k % width
    const j = (k - i) / width
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ni = i + di
        const nj = j + dj
        if (ni < 0 || ni >= width || nj < 0 || nj >= height) return false
        const n = nj * width + ni
        if (!inside[n]) return false
        if (visited[n] || revealed[n]) continue
        visited[n] = 1
        stack[top++] = n
      }
    }
  }
  return true
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
