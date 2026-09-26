import { slopeAt } from '../terrain/analysis'
import type { ChunkCoords } from '../terrain/chunk'
import type { StopDisk } from '../terrain/disk'
import { completeStopDisk, snapToPathable } from '../terrain/disk'
import type { StopManifest } from '../terrain/manifest'
import type { MapPoint, MissionRules, SubmissionRefusal } from '../mission'
import { estimatedDriveMinutes } from '../drive/estimate'
import { planGoal } from '../mission/plan-goal'
import type { NavMetrics } from '../nav/plan'
import { traceSegment } from '../nav/trace'
import type { DiskTerrain } from './terrain-sampler'

/** What a preview can refuse: everything but the refusals only the server gives. Closed set. */
export type PreviewRefusal = Exclude<
  SubmissionRefusal,
  'judged-infeasible' | 'too-many-attempts' | 'round-changed'
>

/** Closed set, discriminated by `ok`. */
export type PreviewResult =
  | {
      ok: false
      reason: PreviewRefusal
      /** The snapped goal; absent when nothing seen and pathable was near the point. */
      goal?: MapPoint
    }
  | {
      ok: true
      goal: MapPoint
      /** World metres, empty when the route was not reached. */
      polyline: MapPoint[]
      /**
       * Per polyline segment: the steepest slope, degrees, over the revealed vertex cells it
       * crosses; null when it crosses only unseen ground.
       */
      segmentSlopes: (number | null)[]
      metrics: NavMetrics
      /** `estimatedDriveMinutes` of the plan; 0 when not reached. */
      estimatedMinutes: number
    }

/** The stop disk a browser rebuilds from the manifest and its assembled chunks. */
export function diskFromTerrain(
  terrain: DiskTerrain,
  manifest: Pick<StopManifest, 'radius'> & {
    stop: MapPoint
    world: Pick<StopManifest['world'], 'mastHeight'>
    chunks: readonly ChunkCoords[]
  },
): StopDisk {
  return completeStopDisk(terrain, {
    center: { x: manifest.stop.x, y: manifest.stop.y },
    radius: manifest.radius,
    chunks: manifest.chunks,
    mastHeight: manifest.world.mastHeight,
  })
}

/**
 * The route a submission at `point` would get: snapped to the nearest seen pathable vertex, checked
 * and planned from `anchor` exactly as the server does, with a slope per polyline segment for
 * drawing. Pure and synchronous; meant to run off the main thread.
 */
export function previewPlan(
  disk: StopDisk,
  options: {
    /** One byte per disk-grid vertex, as `revealedOverDisk` gives it. */
    revealed: Uint8Array
    anchor: MapPoint
    point: MapPoint
    deaths: readonly MapPoint[]
    rules: MissionRules
    slopeLimitDeg: number
  },
): PreviewResult {
  const { revealed, anchor, point, deaths, rules, slopeLimitDeg } = options
  const snapped = snapToPathable(disk, point, { revealed })
  if (!snapped.ok) return { ok: false, reason: snapped.reason }
  const goal = snapped.point
  const planned = planGoal(disk, { revealed, start: anchor, goal, deaths, rules, slopeLimitDeg })
  if (!planned.ok) return { ok: false, reason: planned.reason, goal }
  const { plan } = planned
  const { reached } = plan.metrics
  return {
    ok: true,
    goal,
    polyline: reached ? plan.polyline : [],
    segmentSlopes: reached ? segmentSlopes(disk, revealed, plan.route.waypoints) : [],
    metrics: plan.metrics,
    estimatedMinutes: estimatedDriveMinutes(plan),
  }
}

function segmentSlopes(
  disk: StopDisk,
  revealed: Uint8Array,
  waypoints: readonly { i: number; j: number }[],
): (number | null)[] {
  const { grid } = disk
  const { width } = grid
  const slopes: (number | null)[] = []
  for (let n = 1; n < waypoints.length; n++) {
    const a = waypoints[n - 1]!
    const b = waypoints[n]!
    let steepest: number | null = null
    // Cells the segment only touches at a corner carry weight 0 and count for the metrics nowhere.
    traceSegment(width, a.j * width + a.i, b.j * width + b.i, (k, weight) => {
      if (weight <= 0 || !revealed[k]) return true
      const i = k % width
      const degrees = (Math.atan(slopeAt(grid, { i, j: (k - i) / width })) * 180) / Math.PI
      steepest = Math.max(steepest ?? 0, degrees)
      return true
    })
    slopes.push(steepest)
  }
  return slopes
}
