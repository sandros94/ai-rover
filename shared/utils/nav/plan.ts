import { slopeAt } from '../terrain/analysis'
import type { StopDisk } from '../terrain/disk'
import type { GridCell } from '../terrain/grid'
import type { CostMapOptions } from './costmap'
import { buildCostMap } from './costmap'
import { NavError } from './errors'
import type { Motion, MotionOptions } from './motions'
import { motionsFromPolyline } from './motions'
import type { RouteFailureReason, RouteOptions, RouteResult } from './theta-star'
import { findRoute } from './theta-star'
import { tracePath } from './trace'

/**
 * Navigation telemetry of one plan. Path-derived fields (`pathLengthM`, `detourRatio`, slopes,
 * `unrevealedFraction`, `turnCount`) are 0 when the goal was not reached. Slopes see only revealed
 * ground: the metrics are public, and the slope of unseen ground would leak hidden terrain.
 */
export interface NavMetrics {
  reached: boolean
  /** Set exactly when `reached` is false. */
  failureReason?: RouteFailureReason
  pathLengthM: number
  /** Between the start and goal vertices. */
  straightLineM: number
  /** `pathLengthM / straightLineM`, 1 when start and goal share a vertex. */
  detourRatio: number
  /**
   * Over the revealed vertex cells the path crosses, from the disk grid's gradient; 0 when it
   * crosses none.
   */
  maxSlopeDeg: number
  /** Path-length-weighted over the same cells; 0 when the path crosses no revealed cell. */
  meanSlopeDeg: number
  /** Share of path length over vertices not yet revealed, 0 to 1. */
  unrevealedFraction: number
  /** Turns in place among the motions. */
  turnCount: number
  expansions: number
  /** Wall-clock milliseconds for the whole plan; the only field that varies between equal calls. */
  computeMs: number
}

export interface SegmentPlan {
  route: RouteResult
  /** World metres, one point per route waypoint (vertex positions, not the raw start and goal). */
  polyline: { x: number; y: number }[]
  motions: Motion[]
  metrics: NavMetrics
}

/**
 * Plans one segment across a stop disk: cost map, Theta* route between the vertices nearest
 * `start` and `goal`, motions and metrics. Both points must lie within the disk radius.
 * `revealed` is one byte per disk-grid vertex (see `revealedOverDisk`).
 */
export function planSegment(
  disk: StopDisk,
  options: {
    revealed: Uint8Array
    start: { x: number; y: number }
    goal: { x: number; y: number }
    slopeLimitDeg: number
  } & CostMapOptions &
    RouteOptions &
    Omit<MotionOptions, 'initialHeadingRad'>,
): SegmentPlan {
  const began = performance.now()
  const { revealed, start, goal } = options
  const { grid, origin } = disk
  const { width, cellSize } = grid
  const from = vertexInDisk(disk, start, 'start')
  const to = vertexInDisk(disk, goal, 'goal')
  const costMap = buildCostMap(disk, options)
  const route = findRoute(costMap, {
    width,
    height: grid.height,
    start: from,
    goal: to,
    maxExpansions: options.maxExpansions,
  })

  const polyline = route.waypoints.map(({ i, j }) => ({
    x: (origin.i + i) * cellSize,
    y: (origin.j + j) * cellSize,
  }))
  const motions = route.reached
    ? motionsFromPolyline(polyline, {
        turnInPlaceAboveRad: options.turnInPlaceAboveRad,
        blendRadiusM: options.blendRadiusM,
      })
    : []
  const straightLineM = Math.hypot(to.i - from.i, to.j - from.j) * cellSize
  const along = route.reached ? alongPath(disk, revealed, route.waypoints) : undefined
  const pathLengthM = along?.lengthM ?? 0
  const metrics: NavMetrics = {
    reached: route.reached,
    ...(route.failureReason && { failureReason: route.failureReason }),
    pathLengthM,
    straightLineM,
    detourRatio: !along ? 0 : straightLineM > 0 ? pathLengthM / straightLineM : 1,
    maxSlopeDeg: along?.maxSlopeDeg ?? 0,
    meanSlopeDeg: along?.meanSlopeDeg ?? 0,
    unrevealedFraction: along?.unrevealedFraction ?? 0,
    turnCount: motions.filter((motion) => motion.type === 'turn').length,
    expansions: route.expansions,
    computeMs: 0,
  }
  metrics.computeMs = performance.now() - began
  return { route, polyline, motions, metrics }
}

/**
 * Length, unrevealed share and length-weighted slope over the vertex cells a route crosses; the
 * slopes over its revealed cells only, 0 when there are none.
 */
function alongPath(
  disk: StopDisk,
  revealed: Uint8Array,
  waypoints: GridCell[],
): { lengthM: number; maxSlopeDeg: number; meanSlopeDeg: number; unrevealedFraction: number } {
  const { grid } = disk
  const { width, cellSize } = grid
  let lengthM = 0
  for (let k = 1; k < waypoints.length; k++) {
    const a = waypoints[k - 1]!
    const b = waypoints[k]!
    lengthM += Math.hypot(b.i - a.i, b.j - a.j) * cellSize
  }
  let span = 0
  let unrevealed = 0
  let seen = 0
  let maxSlopeDeg = 0
  let slopeSum = 0
  tracePath(width, cellSize, waypoints, (k, weight) => {
    span += weight
    if (!revealed[k]) {
      unrevealed += weight
      return
    }
    const i = k % width
    const slopeDeg = (Math.atan(slopeAt(grid, { i, j: (k - i) / width })) * 180) / Math.PI
    maxSlopeDeg = Math.max(maxSlopeDeg, slopeDeg)
    slopeSum += slopeDeg * weight
    seen += weight
  })
  return {
    lengthM,
    maxSlopeDeg,
    meanSlopeDeg: seen > 0 ? slopeSum / seen : 0,
    unrevealedFraction: unrevealed / span,
  }
}

function vertexInDisk(disk: StopDisk, point: { x: number; y: number }, name: string): GridCell {
  const { x, y } = point
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new NavError(
      'INVALID_INPUT',
      `planSegment: ${name} is (${x}, ${y}); pass finite world coordinates in metres.`,
    )
  }
  const { center, radius, origin, grid } = disk
  const distance = Math.hypot(x - center.x, y - center.y)
  if (distance > radius) {
    throw new NavError(
      'OUT_OF_DISK',
      `planSegment: ${name} (${x}, ${y}) is ${distance.toFixed(2)} m from the disk centre (${center.x}, ${center.y}), beyond its ${radius} m radius; pass a point within the disk or plan over a disk around it.`,
    )
  }
  return {
    i: Math.round(x / grid.cellSize) - origin.i,
    j: Math.round(y / grid.cellSize) - origin.j,
  }
}
