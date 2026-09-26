import * as v from 'valibot'
import { estimatedDriveMinutes } from '../drive/estimate'
import type { StopDisk } from '../terrain/disk'
import type { World } from '../terrain/world'
import { NavError } from './errors'
import type { SegmentPlan } from './plan'
import type { RouteFailureReason } from './theta-star'
import { tracePath } from './trace'

export const STRAIGHT_LINE_LABELS = ['short', 'medium', 'long'] as const
export const DETOUR_LABELS = ['nearly straight', 'moderate detour', 'long detour'] as const
export const SLOPE_LABELS = ['gentle', 'moderate', 'near the limit'] as const
export const UNSEEN_LABELS = ['mostly seen', 'partly unseen', 'mostly unseen'] as const
export const LOOSE_GROUND_LABELS = ['firm', 'some loose ground', 'mostly loose'] as const
export const COMPASS_POINTS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const

const ROVER = {
  class: 'Perseverance-class six-wheel rocker-bogie rover',
  speed: '152 m per hour at most, about 120 m per hour with autonomous navigation',
  limits: 'operational slope limit 16 degrees; drives over rocks up to 40 cm; turns in place',
} as const

const MISSION_RULES =
  'A segment goes from the current stop to a destination 50 to 250 m away. The rover plans only over ground it has already seen; unseen ground is uncertain and the drive stops safely if it turns out impassable.'

const FAILURE_REASONS: Record<RouteFailureReason, string> = {
  'goal-blocked': 'The destination lies on ground the rover has seen and knows to be impassable.',
  'goal-unreachable':
    'Seen impassable ground surrounds the destination or the stop; no route connects them.',
  'start-blocked': 'The rover cannot move off its current position.',
  'expansion-cap': 'The planner gave up before finding a route through the ground in between.',
}

const wholeMetres = v.pipe(v.number(), v.safeInteger(), v.minValue(0))

const ReachedRouteSchema = v.strictObject({
  reached: v.literal(true),
  path_length_m: wholeMetres,
  detour_label: v.picklist(DETOUR_LABELS),
  /** Over the seen part of the path; the rover knows nothing about the slope of unseen ground. */
  max_slope_deg: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(90)),
  max_slope_label: v.picklist(SLOPE_LABELS),
  mean_slope_label: v.picklist(SLOPE_LABELS),
  unseen_label: v.picklist(UNSEEN_LABELS),
  turns_in_place: wholeMetres,
  /** Over the seen part of the path. */
  loose_ground_label: v.picklist(LOOSE_GROUND_LABELS),
  /** Path at the AutoNav rate plus imaging stops and turns in place; slope slowdown comes on top. */
  estimated_drive_minutes: wholeMetres,
})

/**
 * Jev's state for one submission: every number already computed and interpreted by code, labels
 * beside them. Path facts exist only for a reached route; an unreached one carries
 * `failure_reason` instead, so no zero-length route reads as short, straight and gentle.
 */
export const SubmissionSummarySchema = v.pipe(
  v.strictObject({
    rover: v.strictObject({ class: v.string(), speed: v.string(), limits: v.string() }),
    mission_rules: v.string(),
    destination: v.strictObject({
      straight_line_m: wholeMetres,
      straight_line_label: v.picklist(STRAIGHT_LINE_LABELS),
      bearing: v.picklist(COMPASS_POINTS),
    }),
    route: v.variant('reached', [
      ReachedRouteSchema,
      v.strictObject({ reached: v.literal(false) }),
    ]),
    failure_reason: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.check(
    (summary) => summary.route.reached === (summary.failure_reason === undefined),
    'failure_reason is set exactly when the route is not reached',
  ),
)

export type SubmissionSummary = v.InferOutput<typeof SubmissionSummarySchema>

export function straightLineLabel(metres: number): (typeof STRAIGHT_LINE_LABELS)[number] {
  return metres < 100 ? 'short' : metres < 180 ? 'medium' : 'long'
}

export function detourLabel(ratio: number): (typeof DETOUR_LABELS)[number] {
  return ratio < 1.1 ? 'nearly straight' : ratio < 1.4 ? 'moderate detour' : 'long detour'
}

/** Steepest slope along a path, degrees. */
export function slopeLabel(degrees: number): (typeof SLOPE_LABELS)[number] {
  return degrees < 6 ? 'gentle' : degrees < 12 ? 'moderate' : 'near the limit'
}

/** Length-weighted mean slope along a path, degrees; half the thresholds of {@link slopeLabel}. */
export function meanSlopeLabel(degrees: number): (typeof SLOPE_LABELS)[number] {
  return slopeLabel(degrees * 2)
}

/** Share of path length over unseen ground, 0 to 1. */
export function unseenLabel(fraction: number): (typeof UNSEEN_LABELS)[number] {
  return fraction < 0.2 ? 'mostly seen' : fraction < 0.6 ? 'partly unseen' : 'mostly unseen'
}

/** Length-weighted mean regolith looseness, 0 to 1. */
export function looseGroundLabel(looseness: number): (typeof LOOSE_GROUND_LABELS)[number] {
  return looseness < 0.3 ? 'firm' : looseness < 0.6 ? 'some loose ground' : 'mostly loose'
}

/** Eight-point compass direction from `from` to `to`, x east and y north. */
export function compassPoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
): (typeof COMPASS_POINTS)[number] {
  const clockwiseFromNorth = Math.atan2(to.x - from.x, to.y - from.y)
  const octant = Math.round(clockwiseFromNorth / (Math.PI / 4))
  return COMPASS_POINTS[((octant % 8) + 8) % 8]!
}

/**
 * Builds Jev's state for a planned segment. Slope and looseness come from the seen part of the
 * path only: the rover has no knowledge of unseen ground beyond it being unseen. Slopes are the
 * plan's own metrics; `revealed` is the byte per disk-grid vertex the plan was made with (see
 * `revealedOverDisk`), used for the looseness.
 */
export function summarizeSubmission(
  plan: SegmentPlan,
  options: {
    world: Pick<World, 'looseAt'>
    disk: StopDisk
    revealed: Uint8Array
    start: { x: number; y: number }
    goal: { x: number; y: number }
  },
): SubmissionSummary {
  const { world, disk, revealed, start, goal } = options
  const { width, height } = disk.grid
  if (revealed.length !== width * height) {
    throw new NavError(
      'INVALID_INPUT',
      `summarizeSubmission: revealed holds ${revealed.length} values but the disk grid is ${width}×${height} (${width * height}); pass the revealedOverDisk(mask, disk) the plan was made with.`,
    )
  }
  const { metrics } = plan
  const destination = {
    straight_line_m: Math.round(metrics.straightLineM),
    straight_line_label: straightLineLabel(metrics.straightLineM),
    bearing: compassPoint(start, goal),
  }
  const common = { rover: { ...ROVER }, mission_rules: MISSION_RULES, destination }
  if (!metrics.reached) {
    return {
      ...common,
      route: { reached: false },
      failure_reason: FAILURE_REASONS[metrics.failureReason ?? 'goal-unreachable'],
    }
  }
  const meanLooseness = seenLooseness(plan, world, disk, revealed)
  return {
    ...common,
    route: {
      reached: true,
      path_length_m: Math.round(metrics.pathLengthM),
      detour_label: detourLabel(metrics.detourRatio),
      max_slope_deg: Math.round(metrics.maxSlopeDeg),
      max_slope_label: slopeLabel(metrics.maxSlopeDeg),
      mean_slope_label: meanSlopeLabel(metrics.meanSlopeDeg),
      unseen_label: unseenLabel(metrics.unrevealedFraction),
      turns_in_place: metrics.turnCount,
      loose_ground_label: looseGroundLabel(meanLooseness),
      estimated_drive_minutes: estimatedDriveMinutes(plan),
    },
  }
}

/**
 * Regolith looseness over the seen vertex cells a reached route crosses, weighted by the length
 * inside each cell. 0 when the route crosses no seen cell.
 */
function seenLooseness(
  plan: SegmentPlan,
  world: Pick<World, 'looseAt'>,
  disk: StopDisk,
  revealed: Uint8Array,
): number {
  const { grid, origin } = disk
  const { width, cellSize } = grid
  let looseSum = 0
  let span = 0
  tracePath(width, cellSize, plan.route.waypoints, (k, weight) => {
    if (!revealed[k]) return
    const i = k % width
    const j = (k - i) / width
    looseSum += world.looseAt((origin.i + i) * cellSize, (origin.j + j) * cellSize) * weight
    span += weight
  })
  return span > 0 ? looseSum / span : 0
}
