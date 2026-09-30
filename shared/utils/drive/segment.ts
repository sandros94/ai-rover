import type { CostMapOptions } from '../nav/costmap'
import { NavError } from '../nav/errors'
import type { Motion, MotionOptions } from '../nav/motions'
import { motionsFromPolyline } from '../nav/motions'
import type { SegmentPlan } from '../nav/plan'
import { planSegment } from '../nav/plan'
import type { RouteOptions } from '../nav/theta-star'
import { traceSegment } from '../nav/trace'
import { RoverError } from '../rover/errors'
import type { ResolvedRoverGeometry } from '../rover/geometry'
import { DEFAULT_ROVER_GEOMETRY } from '../rover/geometry'
import type { PlanarPose, RoverPose } from '../rover/kinematics'
import { poseOnTerrain } from '../rover/kinematics'
import type { RoverLimits } from '../rover/limits'
import { checkLimits } from '../rover/limits'
import type { StopDisk } from '../terrain/disk'
import { TerrainError } from '../terrain/errors'
import type { RevealedMask } from '../terrain/revealed'
import { revealedOverDisk } from '../terrain/revealed'
import { viewshed } from '../terrain/viewshed'
import type { World } from '../terrain/world'
import { DriveError } from './errors'
import type { KeyframeBlock } from './keyframes'
import { KEYFRAME_STRIDE } from './keyframes'
import type { SpeedModel, SteeringAngles, StopModel } from './models'
import {
  DEFAULT_SPEED_MODEL,
  DEFAULT_STOP_MODEL,
  driveLimits,
  groundSpeedMps,
  imagingAllowed,
  minArcRadiusM,
  STEER_THRESHOLD_RAD,
  steeringFor,
  steerLimits,
  steerTravelRad,
  STRAIGHT_WHEELS,
  turnLimits,
} from './models'
import type { Move, ProfileLimits, ProfileSample } from './profile'
import { moveAt, peakRate, planMove, rampAt, rampDistance, rampDurationS } from './profile'

/**
 * Wheel slip `s = min(max, loose · gain · (tan slope / tan slopeLimit)²)`: commanded travel
 * advances the rover by `(1 − s)` of itself.
 */
export interface SlipModel {
  /** Default 1.2. */
  gain?: number
  /** Default 0.95. */
  max?: number
  /** Slip at or above this counts toward getting stuck. Default 0.6. */
  stuckAbove?: number
  /** Commanded metres at `stuckAbove` or more, without a break, that end the drive. Default 3. */
  stuckAfterM?: number
  /** A `slip` event marks the first step of each metre whose slip exceeds this. Default 0.3. */
  eventAbove?: number
}

const DEG = Math.PI / 180

/** The slip model a drive uses for omitted fields. */
export const DEFAULT_SLIP_MODEL: Readonly<Required<SlipModel>> = Object.freeze({
  gain: 1.2,
  max: 0.95,
  stuckAbove: 0.6,
  stuckAfterM: 3,
  eventAbove: 0.3,
})

export interface DriveOptions {
  /** The stop disk the segment starts in; its grid holds the true terrain. */
  disk: StopDisk
  /** What the rover had seen over the journey when the segment starts. */
  revealed: RevealedMask
  start: PlanarPose
  goal: { x: number; y: number }
  geometry?: ResolvedRoverGeometry
  limits?: RoverLimits
  speed?: SpeedModel
  stops?: StopModel
  slip?: SlipModel
  /** Passed to every `planSegment` call. */
  plan?: CostMapOptions & RouteOptions & Omit<MotionOptions, 'initialHeadingRad'>
  /**
   * Simulation steps per second; a whole multiple of `keyframeHz`. Default 2: at rover speed a step
   * is about 2 cm, the lookahead samples the path every 25 cm regardless, and the outcome matched
   * 10 Hz to 1e-12 m while costing a quarter of the solves.
   */
  simHz?: number
  /** Keyframes per second. Default 2. */
  keyframeHz?: number
  /** Path length checked ahead of the rover before each metre. Default 1 m. */
  lookaheadM?: number
  /**
   * Seen impassable ground on the route triggers a replan once it lies within this route distance
   * ahead; farther blockages wait until the rover gets closer and has seen more. Default 10 m.
   */
  replanHorizonM?: number
  /** Radius of the viewshed run after each metre. Default 50 m. */
  revealRadiusM?: number
  /** Sim time after which the rover stops where it is. Default: none. */
  maxDurationS?: number
  /** Replans after which the rover stops where it is, bounding compute. Default 20. */
  maxReplans?: number
}

/**
 * Closed set: callers may match on it exhaustively, so adding a type is a breaking change. The
 * stops (`steering`, `turning`, `assessing`, `imaging`) carry `durationS`: `turning` also its
 * signed `angleDeg` (positive to the left), `assessing` the `cause` of the replan it precedes.
 */
export type DriveEventType =
  | 'start'
  | 'steering'
  | 'turning'
  | 'assessing'
  | 'replan'
  | 'imaging'
  | 'slip'
  | 'blocked'
  | 'hazard'
  | 'stuck'
  | 'arrived'

export type DriveEventDetail = number | string | string[] | { x: number; y: number }[]

/** Something that happened at sim time `t` with the rover at (x, y). */
export interface DriveEvent {
  t: number
  type: DriveEventType
  x: number
  y: number
  details?: Record<string, DriveEventDetail>
}

/**
 * How the segment ended. `stopped-short` keeps the progress as a checkpoint; `failed` is
 * reserved for a hazard under the rover or getting stuck.
 */
export interface DriveOutcome {
  kind: 'arrived' | 'stopped-short' | 'failed'
  /** Empty when arrived. */
  reasons: string[]
  /** Ground distance actually covered, metres. */
  distanceM: number
  /** Sim time of the last keyframe, seconds. */
  durationS: number
  endPose: PlanarPose
}

/** One segment attempt, immutable once produced. Contains no wall-clock values. */
export interface SegmentRecord {
  version: 1
  /** The drive's start pose, as passed to `driveSegment`. */
  start: PlanarPose
  /** The drive's goal, as passed to `driveSegment`. */
  goal: { x: number; y: number }
  /** The plan at the start of the segment, `metrics.computeMs` zeroed; replans ride on events. */
  plan: SegmentPlan
  keyframes: KeyframeBlock
  events: DriveEvent[]
  /** Newly seen vertices as disk-grid indices (`j · width + i`), each listed once, time-ordered. */
  reveals: { t: number; vertices: Uint32Array }[]
  outcome: DriveOutcome
}

export interface DriveStats {
  /** Wall-clock milliseconds for the whole drive. */
  computeMs: number
  simSteps: number
  replans: number
  /** Wall-clock milliseconds spent planning and replanning. */
  planMs: number
  /** Wall-clock milliseconds spent in reveal viewsheds. */
  revealMs: number
}

/** Spacing of the lookahead samples, the ACE check interval. */
const PROBE_STEP_M = 0.25
/** Radius around a failed probe marked as seen: the rover has looked there closely. */
const DISCOVERY_RADIUS_M = 3
/** Half the span of the central differences that give the slope under the rover. */
const SLOPE_HALF_SPAN_M = 0.5

/**
 * Commanded metres short of a rest point within which a drive that has come to rest covers the
 * gap at once instead of starting again: the ramp down is planned on the slip where it starts,
 * and slip changing under it can leave the rover this far short.
 */
const REST_SNAP_M = 1e-3

/**
 * Drives a segment over the true terrain: plans on what the rover has seen, then executes the
 * motions step by step at `simHz`, standing the rover on the ground every step, and records
 * keyframes, events, reveals and the outcome. Equal inputs give deep-equal records.
 *
 * Driving is continuous: after each metre the rover reveals a viewshed of `revealRadiusM` and
 * checks the next `lookaheadM` of path without stopping. It stops only for a reason (see
 * {@link StopModel}): to steer, to turn in place, to image every `imagingEveryM`, and to assess
 * before it replans, which it does when seen ground blocks its route within `replanHorizonM` or
 * the lookahead finds a hazard; when no route is left it stops short. Steering happens standing
 * still before each motion whose wheel angles differ from the current ones (see `steeringFor`):
 * every turn in place, and each arc entered or left. A limit failure under the rover
 * itself, or sustained slip, fails the segment.
 *
 * Every motion is jerk-limited (see `planMove`): the wheels ramp from rest to the cruise speed
 * and back to rest before each stop, and between cruise speeds as the slope changes; a turn in
 * place and each steering ramp their angular rates alike. A stop for a reason comes to rest first
 * and starts where the rover came to rest; a fault under the rover ends the drive at the
 * emergency deceleration.
 */
export function driveSegment(
  world: World,
  options: DriveOptions,
): { record: SegmentRecord; stats: DriveStats } {
  const began = performance.now()
  const drive = new Drive(world, options)
  const record = drive.run()
  return {
    record,
    stats: {
      computeMs: performance.now() - began,
      simSteps: drive.step,
      replans: drive.replans,
      planMs: drive.planMs,
      revealMs: drive.revealMs,
    },
  }
}

interface Resolved {
  geometry: ResolvedRoverGeometry
  limits: RoverLimits | undefined
  ground: Pick<Required<SpeedModel>, 'cruiseSpeedMps' | 'slopeSlowdown'>
  /** The drive's acceleration and jerk; its rate is the ground's speed under the rover. */
  drive: Pick<Required<SpeedModel>, 'accelMps2' | 'jerkMps3'>
  turn: ProfileLimits
  steer: ProfileLimits
  emergencyDecel: number
  imagingEveryM: number
  imagingSteps: number
  assessSteps: number
  slipGain: number
  slipMax: number
  stuckAbove: number
  stuckAfterM: number
  slipEventAbove: number
  simHz: number
  frameEvery: number
  lookaheadM: number
  replanHorizonM: number
  revealRadiusM: number
  maxDurationS: number
  maxReplans: number
}

/** Where the rover is along its motions. */
interface Cursor {
  x: number
  y: number
  heading: number
  motion: number
  /** Progress into the current motion: metres of arc or radians of turn. */
  along: number
  /** Whether the wheels stand as the current motion needs; until then the rover steers. */
  steered: boolean
}

/**
 * A steering in progress: the corner wheels turning from one set of angles to the next, all on
 * the one move of the largest change.
 */
interface SteerPhase {
  from: SteeringAngles
  to: SteeringAngles
  move: Move
  elapsedS: number
}

/** A change of the commanded drive speed under way, its position counted from its start. */
interface SpeedChange {
  to: number
  durationS: number
  elapsedS: number
  at: (t: number) => ProfileSample
}

type Probe = { ok: true } | { ok: false; x: number; y: number; reasons: string[] }

class Drive {
  step = 0
  replans = 0
  planMs = 0
  revealMs = 0

  private readonly o: Resolved
  private readonly tanLimit: number
  /** Per disk-grid vertex, what the rover has seen so far. */
  private readonly seen: Uint8Array
  /** The disk's traversable mask with hazards the rover found closed off. */
  private readonly believed: Uint8Array

  private motions: Motion[] = []
  /** Disk-grid vertices the current route crosses → route distance to them from its start. */
  private route = new Map<number, number>()
  /** Odometer reading when the current route was taken. */
  private routeFrom = 0
  /** Odometer reading at which the current route ends: the path as planned now, in full. */
  private plannedM = 0
  private cursor: Cursor
  private pose: RoverPose | undefined
  private posed: { x: number; y: number; heading: number } | undefined
  private odometer = 0
  private nextMetre = 1
  private nextImaging: number
  private stuckRun = 0
  private slipMetre = -1
  /** Ground speed at the end of the last step, as frames record it. */
  private speed = 0
  /** Commanded drive speed, m/s: the wheels' rate along the motions, before slip. */
  private rate = 0
  private change: SpeedChange | undefined
  /** The cruise speed commanded for the current step, from the slope where it first rolls. */
  private cruise: number | undefined
  /**
   * While set, the rover comes to rest and nothing new starts: for a stop (`rest`) the drive
   * ramps down and a turn or steering under way completes; after a fault (`fault`) the drive
   * brakes at the emergency deceleration and everything else halts where it stands.
   */
  private halting: 'rest' | 'fault' | undefined
  private readonly spins = new Float64Array(6)
  private wheels: SteeringAngles = [...STRAIGHT_WHEELS]
  private steering: SteerPhase | undefined
  private turning: { move: Move; elapsedS: number } | undefined
  private readonly frames: number[] = []
  private readonly events: DriveEvent[] = []
  private readonly reveals: SegmentRecord['reveals'] = []
  private lastRevealVertex = -1

  constructor(
    private readonly world: World,
    private readonly options: DriveOptions,
  ) {
    this.o = resolve(options)
    const { disk, start, goal } = options
    assertInDisk(disk, start, 'start')
    assertInDisk(disk, goal, 'goal')
    if (!Number.isFinite(start.headingRad)) {
      throw new DriveError(
        'INVALID_INPUT',
        `driveSegment: start.headingRad is ${start.headingRad}; pass finite radians.`,
      )
    }
    try {
      this.seen = revealedOverDisk(options.revealed, disk)
    } catch (error) {
      if (!(error instanceof TerrainError)) throw error
      throw new DriveError(
        'INVALID_INPUT',
        `driveSegment: the revealed mask does not fit the disk (${error.message}); pass the journey mask of this disk's world.`,
        { cause: error },
      )
    }
    this.believed = disk.traversable.slice()
    this.tanLimit = Math.tan(world.config.slopeLimitDeg * DEG)
    this.cursor = {
      x: start.x,
      y: start.y,
      heading: start.headingRad,
      motion: 0,
      along: 0,
      steered: false,
    }
    this.nextImaging = this.o.imagingEveryM
  }

  run(): SegmentRecord {
    const plan = this.plan()
    const outcome = this.execute(plan)
    const { start, goal } = this.options
    return {
      version: 1,
      start: { x: start.x, y: start.y, headingRad: start.headingRad },
      goal: { x: goal.x, y: goal.y },
      plan: { ...plan, metrics: { ...plan.metrics, computeMs: 0 } },
      keyframes: {
        hz: this.o.simHz / this.o.frameEvery,
        stride: KEYFRAME_STRIDE,
        count: this.frames.length / KEYFRAME_STRIDE,
        data: Float32Array.from(this.frames),
      },
      events: this.events,
      reveals: this.reveals,
      outcome,
    }
  }

  private execute(plan: SegmentPlan): DriveOutcome {
    this.emit('start')
    const underfoot = this.standHere()
    this.frame()
    if (underfoot) return this.fail(underfoot, 'hazard')
    if (!plan.metrics.reached) return this.stopShort([plan.metrics.failureReason!])
    this.follow(plan)
    const decided = this.lookAhead()
    if (decided) return decided

    for (;;) {
      if (this.cursor.motion >= this.motions.length) return this.finish('arrived', [], 'arrived')
      if (this.time() >= this.o.maxDurationS) return this.stopShort(['max-duration'])
      const failed = this.tick()
      if (failed) return failed
      if (this.odometer >= this.nextMetre && this.cursor.motion < this.motions.length) {
        this.nextMetre = Math.floor(this.odometer) + 1
        const decided = this.metre()
        if (decided) return decided
      }
    }
  }

  /** One sim step: move, stand the rover on the ground, fail on a fault, record a frame when due. */
  private tick(): DriveOutcome | undefined {
    const before = { ...this.cursor }
    this.advance()
    this.step++
    const hazard = this.standHere()
    if (hazard?.includes('no-contact')) {
      // With no contact there is no pose to show and no ground to brake on; the rover stays
      // where it last stood.
      this.cursor = before
      this.rate = 0
      this.change = undefined
      this.speed = 0
    }
    if (hazard) {
      this.frameIfDue()
      return this.fail(hazard, 'hazard')
    }
    if (this.stuckRun >= this.o.stuckAfterM) {
      this.frameIfDue()
      return this.fail(['stuck'], 'stuck', { commandedM: this.stuckRun })
    }
    this.frameIfDue()
    return undefined
  }

  /**
   * Brings the rover to rest where it is headed: the drive ramps down, a turn or a steering under
   * way completes, nothing new starts. Returns the outcome when a fault ends the drive meanwhile.
   */
  private settle(): DriveOutcome | undefined {
    this.halting = 'rest'
    try {
      while (this.rate > 0 || this.change || this.steering || this.turning) {
        const failed = this.tick()
        if (failed) return failed
      }
    } finally {
      this.halting = undefined
    }
    return undefined
  }

  /** The per-metre routine, on the move: look around, image when due, check the way ahead. */
  private metre(): DriveOutcome | undefined {
    this.reveal(this.revealViewshed())
    if (this.odometer >= this.nextImaging) {
      this.nextImaging =
        (Math.floor(this.odometer / this.o.imagingEveryM) + 1) * this.o.imagingEveryM
      if (imagingAllowed(this.odometer, this.plannedM)) {
        const failed = this.settle()
        if (failed) return failed
        this.hold('imaging', this.o.imagingSteps)
      }
    }
    const travelled = this.odometer - this.routeFrom
    for (const [k, at] of this.route) {
      const ahead = at - travelled
      if (ahead >= 0 && ahead <= this.o.replanHorizonM && this.seen[k] && !this.believed[k]) {
        const decided = this.replan('revealed')
        if (decided) return decided
        break
      }
    }
    return this.lookAhead()
  }

  /** Probes the path ahead, replanning around each hazard it finds until the way is clear. */
  private lookAhead(): DriveOutcome | undefined {
    for (;;) {
      const probe = this.probe()
      if (probe.ok) return undefined
      this.reveal(this.discoveryDisk(probe))
      const hazard = this.vertexAt(probe)
      if (hazard === undefined || hazard === this.vertexAt(this.cursor)) {
        return this.stopShort(['hazard-ahead', ...probe.reasons], {
          hazard: [{ x: probe.x, y: probe.y }],
        })
      }
      this.believed[hazard] = 0
      const decided = this.replan('lookahead', probe)
      if (decided) return decided
    }
  }

  private replan(
    cause: 'revealed' | 'lookahead',
    probe?: { x: number; y: number; reasons: string[] },
  ): DriveOutcome | undefined {
    const failed = this.settle()
    if (failed) return failed
    this.hold('assessing', this.o.assessSteps, { cause })
    if (this.replans === this.o.maxReplans) return this.stopShort(['replan-limit'])
    this.replans++
    const plan = this.plan()
    if (!plan.metrics.reached) return this.stopShort([plan.metrics.failureReason!], { cause })
    this.follow(plan)
    this.emit('replan', {
      cause,
      ...(probe && { hazard: [{ x: probe.x, y: probe.y }], reasons: probe.reasons }),
      polyline: plan.polyline,
    })
    return undefined
  }

  /** Plans from the rover's position over what it has seen and the hazards it closed off. */
  private plan(): SegmentPlan {
    const began = performance.now()
    const { disk, goal } = this.options
    try {
      return planSegment(
        { ...disk, traversable: this.believed },
        {
          ...this.options.plan,
          revealed: this.seen,
          start: { x: this.cursor.x, y: this.cursor.y },
          goal,
          slopeLimitDeg: this.world.config.slopeLimitDeg,
        },
      )
    } catch (error) {
      if (!(error instanceof NavError)) throw error
      throw new DriveError('INVALID_INPUT', `driveSegment: ${error.message}`, { cause: error })
    } finally {
      this.planMs += performance.now() - began
    }
  }

  /** Motions from the rover's actual pose along the plan's route. */
  private follow(plan: SegmentPlan): void {
    const { x, y, heading } = this.cursor
    const points = [{ x, y }, ...plan.polyline.slice(plan.polyline.length > 1 ? 1 : 0)]
    this.motions = motionsFromPolyline(points, {
      turnInPlaceAboveRad: this.options.plan?.turnInPlaceAboveRad,
      blendRadiusM: this.options.plan?.blendRadiusM,
      initialHeadingRad: heading,
    })
    this.cursor = { x, y, heading, motion: 0, along: 0, steered: false }
    this.steering = undefined
    this.turning = undefined
    const { width, cellSize } = this.options.disk.grid
    const { waypoints } = plan.route
    this.route = new Map()
    this.routeFrom = this.odometer
    this.plannedM = this.odometer + plan.metrics.pathLengthM
    let legStart = 0
    for (let k = 1; k < waypoints.length; k++) {
      const a = waypoints[k - 1]!
      const b = waypoints[k]!
      const length = Math.hypot(b.i - a.i, b.j - a.j) * cellSize
      let along = legStart
      traceSegment(width, a.j * width + a.i, b.j * width + b.i, (cell, weight) => {
        if (!this.route.has(cell)) this.route.set(cell, along)
        along += weight * length
        return true
      })
      legStart += length
    }
  }

  /** Moves the rover along its motions for one sim step. */
  private advance(): void {
    const { o, cursor: c } = this
    const stepS = 1 / o.simHz
    let remaining = stepS
    this.speed = 0
    this.cruise = undefined
    while (remaining > 0 && c.motion < this.motions.length) {
      const motion = this.motions[c.motion]!
      if (!c.steered) {
        if (this.halting && !this.steering) break
        remaining = this.steer(steeringFor(motion, o.geometry).angles, remaining, stepS)
        continue
      }
      if (motion.type === 'turn') {
        if (this.halting && !this.turning) break
        remaining = this.turn(motion, remaining, stepS)
        continue
      }
      if (this.halting && this.rate === 0 && !this.change) break
      remaining = this.roll(motion, remaining)
      if (this.stuckRun >= o.stuckAfterM && this.halting !== 'fault') break
      // A metre passed on the way to a rest is looked at from that rest, before anything new
      // starts: an imaging stop or an assessment due there happens where the rover stands.
      if (this.atRest() && c.along === 0 && this.odometer >= this.nextMetre) break
    }
  }

  private atRest(): boolean {
    return this.rate === 0 && !this.change && !this.steering && !this.turning
  }

  /**
   * Drives the arc `motion` for up to `remaining` seconds; returns the seconds left. With no
   * speed change under way it picks the next: down to rest when the rest point ahead (see
   * {@link restAhead}) is within the stopping distance, else up or down toward the cruise speed
   * the slope allows, capped so that stopping still fits; at that speed it cruises until the
   * stopping distance is reached.
   */
  private roll(motion: Extract<Motion, { type: 'arc' }>, remaining: number): number {
    const { o, cursor: c } = this
    const ratio = this.tanSlopeAt(c.x, c.y) / this.tanLimit
    // The cruise speed is commanded once a step: chasing the slope continuously would chain
    // ever shorter ramps toward a target that moves as the rover does.
    const cruise = (this.cruise ??= groundSpeedMps(ratio, o.ground))
    const slip = Math.min(o.slipMax, this.world.looseAt(c.x, c.y) * o.slipGain * ratio * ratio)
    const keep = 1 - slip
    const { roll } = steeringFor(motion, o.geometry)
    const left = motion.lengthM - c.along
    const limits = driveLimits(cruise, o.drive)

    let cruiseS = Infinity
    if (!this.change) {
      const ahead = this.halting ? 0 : (left + this.restAhead()) / keep
      if (this.rate === 0 && !this.halting && ahead <= REST_SNAP_M) {
        this.travel(motion, roll, left, left / keep, slip)
        this.speed = 0
        this.nextMotion()
        return remaining
      }
      const stopping = rampDistance(this.rate, 0, limits)
      let target: number
      if (ahead <= stopping + 1e-12) target = 0
      else if (this.rate >= cruise) {
        target =
          rampDistance(this.rate, cruise, limits) + rampDistance(cruise, 0, limits) <= ahead
            ? cruise
            : 0
      } else target = peakRate(this.rate, ahead, limits)
      if (Math.abs(target - this.rate) > 1e-12) this.startChange(target, limits)
      else cruiseS = (ahead - stopping) / this.rate
    }

    const change = this.change
    const dt = change
      ? Math.min(remaining, change.durationS - change.elapsedS)
      : Math.min(remaining, cruiseS)
    const from = change?.at(change.elapsedS).position ?? 0
    let commanded = change ? change.at(change.elapsedS + dt).position - from : this.rate * dt
    let spent = dt
    const ends = commanded * keep >= left
    if (ends) {
      commanded = left / keep
      spent = change ? this.timeInto(change, from, commanded, dt) : commanded / this.rate
    }
    if (change) {
      change.elapsedS += spent
      if (change.elapsedS >= change.durationS) {
        this.rate = change.to
        this.change = undefined
      } else this.rate = change.at(change.elapsedS).rate
    }
    this.travel(motion, roll, ends ? left : commanded * keep, commanded, slip)
    this.speed = this.rate * keep
    if (ends) {
      this.nextMotion()
      if (this.restsHere() && (this.rate > 0 || this.change)) {
        // The ramp down ends a hair past the rest point, or slip grew under it and carried the
        // rover there still moving: the wheels stop there, as the next motion starts from rest.
        this.rate = 0
        this.change = undefined
        this.speed = 0
      }
    }
    return remaining - spent
  }

  /** Moves `actual` metres along the arc for `commanded` metres of wheel travel at `slip`. */
  private travel(
    motion: Extract<Motion, { type: 'arc' }>,
    roll: readonly number[],
    actual: number,
    commanded: number,
    slip: number,
  ): void {
    const { o, cursor: c } = this
    this.moveAlong(motion.curvature, actual)
    c.along += actual
    this.odometer += actual
    for (let w = 0; w < 6; w++) this.spins[w]! += (commanded * roll[w]!) / o.geometry.wheelRadius
    this.stuckRun = slip >= o.stuckAbove ? this.stuckRun + commanded : 0
    const metre = Math.floor(this.odometer)
    if (slip > o.slipEventAbove && metre !== this.slipMetre) {
      this.slipMetre = metre
      this.emit('slip', { slip })
    }
  }

  private startChange(to: number, limits: ProfileLimits): void {
    const from = this.rate
    const durationS = to === from ? 0 : rampDurationS(from, to, limits)
    this.change = { to, durationS, elapsedS: 0, at: (t) => rampAt(from, to, limits, t) }
  }

  /** Seconds into `change` past its elapsed time at which it has covered `commanded` more metres. */
  private timeInto(change: SpeedChange, from: number, commanded: number, upTo: number): number {
    let lo = 0
    let hi = upTo
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2
      if (change.at(change.elapsedS + mid).position - from < commanded) lo = mid
      else hi = mid
    }
    return hi
  }

  /** Metres of arc after the current motion that the rover drives on without coming to rest. */
  private restAhead(): number {
    const { o } = this
    let total = 0
    for (let k = this.cursor.motion + 1; k < this.motions.length; k++) {
      const motion = this.motions[k]!
      if (motion.type === 'turn') break
      if (steerTravelRad(this.wheels, steeringFor(motion, o.geometry).angles) > STEER_THRESHOLD_RAD)
        break
      total += motion.lengthM
    }
    return total
  }

  /** Whether the motion the cursor has reached starts from rest: the end, a turn, or a steering. */
  private restsHere(): boolean {
    const motion = this.motions[this.cursor.motion]
    return (
      !motion ||
      motion.type === 'turn' ||
      steerTravelRad(this.wheels, steeringFor(motion, this.o.geometry).angles) > STEER_THRESHOLD_RAD
    )
  }

  /** Turns in place for up to `remaining` seconds of the step `stepS` long; returns the rest. */
  private turn(
    motion: Extract<Motion, { type: 'turn' }>,
    remaining: number,
    stepS: number,
  ): number {
    const { o, cursor: c } = this
    this.speed = 0
    if (!this.turning) {
      const move = planMove(Math.abs(motion.angleRad), o.turn)
      this.turning = { move, elapsedS: 0 }
      this.emit(
        'turning',
        { angleDeg: motion.angleRad / DEG, durationS: move.durationS },
        stepS - remaining,
      )
    }
    const turning = this.turning
    const spent = Math.min(remaining, turning.move.durationS - turning.elapsedS)
    turning.elapsedS += spent
    const done = turning.elapsedS >= turning.move.durationS
    const at = done ? turning.move.distance : moveAt(turning.move, turning.elapsedS).position
    const turn = at - c.along
    const { roll } = steeringFor(motion, o.geometry)
    c.heading += Math.sign(motion.angleRad) * turn
    for (let w = 0; w < 6; w++) this.spins[w]! += (roll[w]! * turn) / o.geometry.wheelRadius
    c.along = at
    if (done) {
      this.turning = undefined
      this.nextMotion()
    }
    return remaining - spent
  }

  /**
   * Steers the corner wheels toward `target` standing still, for up to `remaining` seconds of
   * the step that is `stepS` long; returns the seconds left. A steering starts with its
   * `steering` event, and when the wheels already stand within the threshold the motion starts
   * at once.
   */
  private steer(target: SteeringAngles, remaining: number, stepS: number): number {
    this.speed = 0
    if (!this.steering) {
      const travel = steerTravelRad(this.wheels, target)
      if (travel <= STEER_THRESHOLD_RAD) {
        this.cursor.steered = true
        return remaining
      }
      const move = planMove(travel, this.o.steer)
      this.steering = { from: this.wheels, to: target, move, elapsedS: 0 }
      this.emit('steering', { durationS: move.durationS }, stepS - remaining)
    }
    const s = this.steering
    const spent = Math.min(remaining, s.move.durationS - s.elapsedS)
    s.elapsedS += spent
    if (s.elapsedS >= s.move.durationS) {
      this.wheels = s.to
      this.steering = undefined
      this.cursor.steered = true
      return remaining - spent
    }
    const u = moveAt(s.move, s.elapsedS).position / s.move.distance
    this.wheels = s.from.map((a, k) => a + (s.to[k]! - a) * u) as SteeringAngles
    return remaining - spent
  }

  private nextMotion(): void {
    this.cursor.motion++
    this.cursor.along = 0
    this.cursor.steered = false
  }

  private moveAlong(curvature: number, distance: number): void {
    const c = this.cursor
    if (curvature === 0) {
      c.x += Math.cos(c.heading) * distance
      c.y += Math.sin(c.heading) * distance
      return
    }
    const heading = c.heading + curvature * distance
    c.x += (Math.sin(heading) - Math.sin(c.heading)) / curvature
    c.y -= (Math.cos(heading) - Math.cos(c.heading)) / curvature
    c.heading = heading
  }

  /** Gradient magnitude of the true terrain under (x, y). */
  private tanSlopeAt(x: number, y: number): number {
    const h = this.world.heightAt
    const d = SLOPE_HALF_SPAN_M
    const gx = (h(x + d, y) - h(x - d, y)) / (2 * d)
    const gy = (h(x, y + d) - h(x, y - d)) / (2 * d)
    return Math.hypot(gx, gy)
  }

  /** Stands the rover at the cursor; returns the failure reasons when the pose fails. */
  private standHere(): string[] | undefined {
    const { x, y, heading } = this.cursor
    if (this.posed?.x === x && this.posed.y === y && this.posed.heading === heading) return
    const result = this.solve({ x, y, headingRad: heading })
    if (result.pose) {
      this.pose = result.pose
      this.posed = { x, y, heading }
    }
    return result.reasons
  }

  /** The pose at a planar pose and, when it fails, why; no pose when no contact exists. */
  private solve(pose: PlanarPose): { pose?: RoverPose; reasons?: string[] } {
    let solved: RoverPose
    try {
      solved = poseOnTerrain(this.world.heightAt, pose, { geometry: this.o.geometry })
    } catch (error) {
      if (error instanceof RoverError && error.code === 'NO_CONTACT') {
        return { reasons: ['no-contact'] }
      }
      throw error
    }
    const verdict = checkLimits(solved, { limits: this.o.limits })
    return verdict.level === 'fail' ? { pose: solved, reasons: verdict.reasons } : { pose: solved }
  }

  /** Checks samples every 25 cm along the next `lookaheadM` of path, and each turn's end. */
  private probe(): Probe {
    const c = { ...this.cursor }
    let travelled = 0
    while (c.motion < this.motions.length && travelled < this.o.lookaheadM) {
      const motion = this.motions[c.motion]!
      if (motion.type === 'turn') {
        c.heading += Math.sign(motion.angleRad) * (Math.abs(motion.angleRad) - c.along)
        c.motion++
        c.along = 0
      } else {
        const step = Math.min(PROBE_STEP_M, motion.lengthM - c.along, this.o.lookaheadM - travelled)
        const heading = c.heading + motion.curvature * step
        if (motion.curvature === 0) {
          c.x += Math.cos(c.heading) * step
          c.y += Math.sin(c.heading) * step
        } else {
          c.x += (Math.sin(heading) - Math.sin(c.heading)) / motion.curvature
          c.y -= (Math.cos(heading) - Math.cos(c.heading)) / motion.curvature
        }
        c.heading = heading
        c.along += step
        travelled += step
        if (c.along >= motion.lengthM) {
          c.motion++
          c.along = 0
        }
      }
      const vertex = this.vertexAt(c)
      if (vertex === undefined || !this.options.disk.traversable[vertex]) {
        return { ok: false, x: c.x, y: c.y, reasons: ['slope'] }
      }
      const { reasons } = this.solve({ x: c.x, y: c.y, headingRad: c.heading })
      if (reasons) return { ok: false, x: c.x, y: c.y, reasons }
    }
    return { ok: true }
  }

  /** Viewshed of `revealRadiusM` from the vertex under the rover, as vertex indices. */
  private revealViewshed(): number[] {
    const began = performance.now()
    const { disk } = this.options
    const { width, height } = disk.grid
    const viewer = this.vertexAt(this.cursor)
    const out: number[] = []
    if (viewer !== undefined && viewer !== this.lastRevealVertex) {
      this.lastRevealVertex = viewer
      const vi = viewer % width
      const vj = (viewer - vi) / width
      const radius = this.o.revealRadiusM / disk.grid.cellSize
      const visible = viewshed(disk.grid, {
        viewer: { i: vi, j: vj },
        mastHeight: this.world.config.mastHeight,
        radius,
      })
      const reach = Math.ceil(radius)
      for (let j = Math.max(0, vj - reach); j <= Math.min(height - 1, vj + reach); j++) {
        for (let i = Math.max(0, vi - reach); i <= Math.min(width - 1, vi + reach); i++) {
          if (visible[j * width + i]) out.push(j * width + i)
        }
      }
    }
    this.revealMs += performance.now() - began
    return out
  }

  /** Vertices within the discovery radius of a probed point. */
  private discoveryDisk(point: { x: number; y: number }): number[] {
    const { grid, origin } = this.options.disk
    const { width, height, cellSize } = grid
    const reach = Math.ceil(DISCOVERY_RADIUS_M / cellSize)
    const ci = Math.round(point.x / cellSize) - origin.i
    const cj = Math.round(point.y / cellSize) - origin.j
    const out: number[] = []
    for (let j = Math.max(0, cj - reach); j <= Math.min(height - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(width - 1, ci + reach); i++) {
        const dx = (origin.i + i) * cellSize - point.x
        const dy = (origin.j + j) * cellSize - point.y
        if (dx * dx + dy * dy <= DISCOVERY_RADIUS_M * DISCOVERY_RADIUS_M) out.push(j * width + i)
      }
    }
    return out
  }

  /** Marks vertices within the survey as seen, recording those not seen before. */
  private reveal(vertices: number[]): void {
    const { inside } = this.options.disk
    const fresh = vertices.filter((k) => !this.seen[k] && inside[k])
    if (fresh.length === 0) return
    for (const k of fresh) this.seen[k] = 1
    this.reveals.push({ t: this.time(), vertices: Uint32Array.from(fresh) })
  }

  /** Nearest disk-grid vertex to a point, or undefined off the grid. */
  private vertexAt(point: { x: number; y: number }): number | undefined {
    const { grid, origin } = this.options.disk
    const i = Math.round(point.x / grid.cellSize) - origin.i
    const j = Math.round(point.y / grid.cellSize) - origin.j
    if (i < 0 || j < 0 || i >= grid.width || j >= grid.height) return undefined
    return j * grid.width + i
  }

  private time(): number {
    return this.step / this.o.simHz
  }

  private frameIfDue(): void {
    if (this.step % this.o.frameEvery === 0) this.frame()
  }

  private frame(): void {
    const p = this.pose
    const { x, y, heading } = this.cursor
    // Before any pose stands (a failing start), the frame holds the planar pose on the ground.
    const z = p?.position.z ?? this.world.heightAt(x, y)
    const q = p?.quaternion ?? { x: 0, y: 0, z: Math.sin(heading / 2), w: Math.cos(heading / 2) }
    this.frames.push(this.time(), x, y, z, q.x, q.y, q.z, q.w, this.speed, ...this.spins)
    this.frames.push(
      p?.rocker.left ?? 0,
      p?.rocker.right ?? 0,
      p?.bogie.left ?? 0,
      p?.bogie.right ?? 0,
      ...this.wheels,
    )
  }

  /** Ends the drive where the rover stands: it has arrived, at rest at the end of its motions. */
  private finish(
    kind: DriveOutcome['kind'],
    reasons: string[],
    event: DriveEventType,
  ): DriveOutcome {
    this.emit(event, reasons.length > 0 ? { reasons } : undefined)
    return this.conclude(kind, reasons)
  }

  /** Stops short for `reasons`: comes to rest, then ends the drive with a `blocked` event. */
  private stopShort(reasons: string[], details?: Record<string, DriveEventDetail>): DriveOutcome {
    const failed = this.settle()
    if (failed) return failed
    this.emit('blocked', { reasons, ...details })
    return this.conclude('stopped-short', reasons)
  }

  /**
   * Fails the drive on a fault found where the rover stands, recorded there, then brakes at the
   * emergency deceleration.
   */
  private fail(
    reasons: string[],
    event: 'hazard' | 'stuck',
    details?: Record<string, DriveEventDetail>,
  ): DriveOutcome {
    this.emit(event, { reasons, ...details })
    this.brake()
    return this.conclude('failed', reasons)
  }

  /**
   * Brings the drive to rest at the emergency deceleration, constant and without a jerk limit;
   * a turn or steering under way halts where it stands. The poses on the way are not checked
   * against the limits: the drive has already failed.
   */
  private brake(): void {
    this.turning = undefined
    this.steering = undefined
    if (this.rate > 0) {
      const from = this.rate
      const decel = this.o.emergencyDecel
      const durationS = from / decel
      this.change = {
        to: 0,
        durationS,
        elapsedS: 0,
        at: (t) => {
          const u = Math.min(Math.max(t, 0), durationS)
          return { position: from * u - (decel * u * u) / 2, rate: from - decel * u, accel: -decel }
        },
      }
    }
    this.halting = 'fault'
    while (this.rate > 0 || this.change) {
      const before = { ...this.cursor }
      this.advance()
      this.step++
      if (this.standHere()?.includes('no-contact')) {
        this.cursor = before
        break
      }
      this.frameIfDue()
    }
    this.halting = undefined
    this.rate = 0
    this.change = undefined
  }

  /**
   * The drive's end: a last short-range reveal where the rover stopped, then standstill up to the
   * next keyframe so the block ends on the final pose.
   */
  private conclude(kind: DriveOutcome['kind'], reasons: string[]): DriveOutcome {
    this.reveal(this.revealViewshed())
    this.speed = 0
    while (this.step % this.o.frameEvery !== 0) {
      this.step++
      this.frameIfDue()
    }
    const { x, y, heading } = this.cursor
    return {
      kind,
      reasons,
      distanceM: this.odometer,
      durationS: this.time(),
      endPose: { x, y, headingRad: heading },
    }
  }

  /** A stop for a reason: the rover stands still, wheels unturned, for `steps` sim steps. */
  private hold(
    type: 'imaging' | 'assessing',
    steps: number,
    details?: Record<string, DriveEventDetail>,
  ): void {
    if (steps === 0) return
    this.emit(type, { durationS: steps / this.o.simHz, ...details })
    this.speed = 0
    for (let k = 0; k < steps; k++) {
      this.step++
      this.frameIfDue()
    }
  }

  /** Records an event `intoStepS` seconds into the step being simulated, at the cursor. */
  private emit(
    type: DriveEventType,
    details?: Record<string, DriveEventDetail>,
    intoStepS = 0,
  ): void {
    const t = this.step / this.o.simHz + intoStepS
    const event: DriveEvent = { t, type, x: this.cursor.x, y: this.cursor.y }
    if (details && Object.keys(details).length > 0) event.details = details
    this.events.push(event)
  }
}

function resolve(options: DriveOptions): Resolved {
  const {
    geometry = DEFAULT_ROVER_GEOMETRY,
    limits,
    speed = {},
    stops = {},
    slip = {},
    simHz = 2,
    keyframeHz = 2,
    lookaheadM = 1,
    replanHorizonM = 10,
    revealRadiusM = 50,
    maxDurationS = Infinity,
    maxReplans = 20,
  } = options
  const S = DEFAULT_SPEED_MODEL
  const {
    cruiseSpeedMps = S.cruiseSpeedMps,
    slopeSlowdown = S.slopeSlowdown,
    turnRateRadPerS = S.turnRateRadPerS,
    steerRateRadPerS = S.steerRateRadPerS,
    accelMps2 = S.accelMps2,
    jerkMps3 = S.jerkMps3,
    emergencyDecelMps2 = S.emergencyDecelMps2,
    turnAccelRadPerS2 = S.turnAccelRadPerS2,
    turnJerkRadPerS3 = S.turnJerkRadPerS3,
    steerAccelRadPerS2 = S.steerAccelRadPerS2,
    steerJerkRadPerS3 = S.steerJerkRadPerS3,
  } = speed
  const P = DEFAULT_STOP_MODEL
  const {
    imagingEveryM = P.imagingEveryM,
    imagingStopS = P.imagingStopS,
    assessStopS = P.assessStopS,
  } = stops
  const L = DEFAULT_SLIP_MODEL
  const {
    gain = L.gain,
    max = L.max,
    stuckAbove = L.stuckAbove,
    stuckAfterM = L.stuckAfterM,
    eventAbove = L.eventAbove,
  } = slip

  const check = (ok: boolean, name: string, value: number, expected: string): void => {
    if (!ok) {
      throw new DriveError('INVALID_INPUT', `driveSegment: ${name} is ${value}; pass ${expected}.`)
    }
  }
  const positive = (name: string, value: number): void =>
    check(Number.isFinite(value) && value > 0, name, value, 'a finite number greater than 0')
  const unit = (name: string, value: number, upper: '<' | '<='): void =>
    check(
      value >= 0 && (upper === '<' ? value < 1 : value <= 1),
      name,
      value,
      `a number from 0 to ${upper === '<' ? 'below ' : ''}1`,
    )

  positive('simHz', simHz)
  positive('keyframeHz', keyframeHz)
  const frameEvery = simHz / keyframeHz
  check(
    Number.isInteger(frameEvery),
    'simHz',
    simHz,
    `a whole multiple of keyframeHz (${keyframeHz})`,
  )
  positive('lookaheadM', lookaheadM)
  positive('revealRadiusM', revealRadiusM)
  check(replanHorizonM >= 0, 'replanHorizonM', replanHorizonM, 'metres ≥ 0')
  check(maxDurationS > 0, 'maxDurationS', maxDurationS, 'seconds greater than 0')
  check(Number.isInteger(maxReplans) && maxReplans >= 0, 'maxReplans', maxReplans, 'an integer ≥ 0')
  positive('speed.cruiseSpeedMps', cruiseSpeedMps)
  unit('speed.slopeSlowdown', slopeSlowdown, '<')
  positive('speed.turnRateRadPerS', turnRateRadPerS)
  positive('speed.steerRateRadPerS', steerRateRadPerS)
  positive('speed.accelMps2', accelMps2)
  positive('speed.jerkMps3', jerkMps3)
  positive('speed.emergencyDecelMps2', emergencyDecelMps2)
  positive('speed.turnAccelRadPerS2', turnAccelRadPerS2)
  positive('speed.turnJerkRadPerS3', turnJerkRadPerS3)
  positive('speed.steerAccelRadPerS2', steerAccelRadPerS2)
  positive('speed.steerJerkRadPerS3', steerJerkRadPerS3)
  const blendRadiusM = options.plan?.blendRadiusM
  const tightest = minArcRadiusM(geometry)
  if (blendRadiusM !== undefined && blendRadiusM < tightest) {
    throw new DriveError(
      'INVALID_INPUT',
      `driveSegment: plan.blendRadiusM is ${blendRadiusM}; pass at least ${tightest.toFixed(3)} m, the tightest arc the corner steering reaches.`,
    )
  }
  check(imagingEveryM > 0, 'stops.imagingEveryM', imagingEveryM, 'metres greater than 0')
  const seconds = (name: string, value: number): void =>
    check(Number.isFinite(value) && value >= 0, name, value, 'finite seconds ≥ 0')
  seconds('stops.imagingStopS', imagingStopS)
  seconds('stops.assessStopS', assessStopS)
  check(Number.isFinite(gain) && gain >= 0, 'slip.gain', gain, 'a finite number ≥ 0')
  unit('slip.max', max, '<')
  check(stuckAbove > 0 && stuckAbove <= 1, 'slip.stuckAbove', stuckAbove, 'a number in (0, 1]')
  positive('slip.stuckAfterM', stuckAfterM)
  unit('slip.eventAbove', eventAbove, '<=')

  return {
    geometry,
    limits,
    ground: { cruiseSpeedMps, slopeSlowdown },
    drive: { accelMps2, jerkMps3 },
    turn: turnLimits({ turnRateRadPerS, turnAccelRadPerS2, turnJerkRadPerS3 }),
    steer: steerLimits({ steerRateRadPerS, steerAccelRadPerS2, steerJerkRadPerS3 }),
    emergencyDecel: emergencyDecelMps2,
    imagingEveryM,
    imagingSteps: Math.round(imagingStopS * simHz),
    assessSteps: Math.round(assessStopS * simHz),
    slipGain: gain,
    slipMax: max,
    stuckAbove,
    stuckAfterM,
    slipEventAbove: eventAbove,
    simHz,
    frameEvery,
    lookaheadM,
    replanHorizonM,
    revealRadiusM,
    maxDurationS,
    maxReplans,
  }
}

function assertInDisk(disk: StopDisk, point: { x: number; y: number }, name: string): void {
  const { x, y } = point
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new DriveError(
      'INVALID_INPUT',
      `driveSegment: ${name} is (${x}, ${y}); pass finite world coordinates in metres.`,
    )
  }
  const distance = Math.hypot(x - disk.center.x, y - disk.center.y)
  if (distance > disk.radius) {
    throw new DriveError(
      'INVALID_INPUT',
      `driveSegment: ${name} (${x}, ${y}) is ${distance.toFixed(2)} m from the disk centre, beyond its ${disk.radius} m radius; pass a point within the disk.`,
    )
  }
}
