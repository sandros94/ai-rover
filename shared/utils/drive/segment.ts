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
import type { SpeedModel, StopModel } from './models'
import { DEFAULT_SPEED_MODEL, DEFAULT_STOP_MODEL, groundSpeedMps, imagingAllowed } from './models'

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
 * stops carry `durationS`: `turning` also its signed `angleDeg` (positive to the left),
 * `assessing` the `cause` of the replan it precedes.
 */
export type DriveEventType =
  | 'start'
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
 * Drives a segment over the true terrain: plans on what the rover has seen, then executes the
 * motions step by step at `simHz`, standing the rover on the ground every step, and records
 * keyframes, events, reveals and the outcome. Equal inputs give deep-equal records.
 *
 * Driving is continuous: after each metre the rover reveals a viewshed of `revealRadiusM` and
 * checks the next `lookaheadM` of path without stopping. It stops only for a reason (see
 * {@link StopModel}): to turn in place, to image every `imagingEveryM`, and to assess before it
 * replans, which it does when seen ground blocks its route within `replanHorizonM` or the
 * lookahead finds a hazard; when no route is left it stops short. A limit failure under the rover
 * itself, or sustained slip, fails the segment.
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
  turnRate: number
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
  private readonly wheelX: number[]
  private readonly wheelY: number[]

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
  private speed = 0
  private readonly spins = new Float64Array(6)
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
    const { frontWheel: f, middleWheel: m, rearWheel: r } = this.o.geometry
    this.wheelX = [f.x, f.x, m.x, m.x, r.x, r.x]
    this.wheelY = [f.y, -f.y, m.y, -m.y, r.y, -r.y]
    this.cursor = { x: start.x, y: start.y, heading: start.headingRad, motion: 0, along: 0 }
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
    if (underfoot) return this.finish('failed', underfoot, 'hazard')
    if (!plan.metrics.reached) {
      return this.finish('stopped-short', [plan.metrics.failureReason!], 'blocked')
    }
    this.follow(plan)
    const decided = this.lookAhead()
    if (decided) return decided

    for (;;) {
      if (this.cursor.motion >= this.motions.length) return this.finish('arrived', [], 'arrived')
      if (this.time() >= this.o.maxDurationS) {
        return this.finish('stopped-short', ['max-duration'], 'blocked')
      }
      const before = { ...this.cursor }
      this.advance()
      this.step++
      const hazard = this.standHere()
      // With no contact there is no pose to show; the rover stays where it last stood.
      if (hazard?.includes('no-contact')) this.cursor = before
      if (hazard) {
        this.frameIfDue()
        return this.finish('failed', hazard, 'hazard')
      }
      if (this.stuckRun >= this.o.stuckAfterM) {
        this.frameIfDue()
        return this.finish('failed', ['stuck'], 'stuck', {
          commandedM: this.stuckRun,
        })
      }
      this.frameIfDue()
      if (this.odometer >= this.nextMetre && this.cursor.motion < this.motions.length) {
        this.nextMetre = Math.floor(this.odometer) + 1
        const decided = this.metre()
        if (decided) return decided
      }
    }
  }

  /** The per-metre routine, on the move: look around, image when due, check the way ahead. */
  private metre(): DriveOutcome | undefined {
    this.reveal(this.revealViewshed())
    if (this.odometer >= this.nextImaging) {
      this.nextImaging =
        (Math.floor(this.odometer / this.o.imagingEveryM) + 1) * this.o.imagingEveryM
      if (imagingAllowed(this.odometer, this.plannedM)) this.hold('imaging', this.o.imagingSteps)
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
        return this.finish('stopped-short', ['hazard-ahead', ...probe.reasons], 'blocked', {
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
    this.hold('assessing', this.o.assessSteps, { cause })
    if (this.replans === this.o.maxReplans) {
      return this.finish('stopped-short', ['replan-limit'], 'blocked')
    }
    this.replans++
    const plan = this.plan()
    if (!plan.metrics.reached) {
      return this.finish('stopped-short', [plan.metrics.failureReason!], 'blocked', { cause })
    }
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
    this.cursor = { x, y, heading, motion: 0, along: 0 }
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
    let remaining = 1 / o.simHz
    let moved = 0
    while (remaining > 0 && c.motion < this.motions.length) {
      const motion = this.motions[c.motion]!
      if (motion.type === 'turn') {
        if (c.along === 0) {
          this.emit('turning', {
            angleDeg: motion.angleRad / DEG,
            durationS: Math.abs(motion.angleRad) / o.turnRate,
          })
        }
        const left = Math.abs(motion.angleRad) - c.along
        const turn = Math.min(left, o.turnRate * remaining)
        const signed = Math.sign(motion.angleRad) * turn
        c.heading += signed
        if (turn === left) remaining -= turn / o.turnRate
        for (let w = 0; w < 6; w++) {
          const x = this.wheelX[w]!
          const y = this.wheelY[w]!
          this.spins[w]! -= (Math.sign(y) * signed * Math.hypot(x, y)) / o.geometry.wheelRadius
        }
        if (turn === left) {
          this.nextMotion()
        } else {
          c.along += turn
          remaining = 0
        }
        continue
      }
      const tanSlope = this.tanSlopeAt(c.x, c.y)
      const ratio = tanSlope / this.tanLimit
      const v = groundSpeedMps(ratio, o.ground)
      const slip = Math.min(o.slipMax, this.world.looseAt(c.x, c.y) * o.slipGain * ratio * ratio)
      const left = motion.lengthM - c.along
      let commanded = v * remaining
      let actual = commanded * (1 - slip)
      const ends = actual >= left
      if (ends) {
        actual = left
        commanded = left / (1 - slip)
      }
      remaining = ends ? remaining - commanded / v : 0
      this.moveAlong(motion.curvature, actual)
      moved += actual
      this.odometer += actual
      for (let w = 0; w < 6; w++) {
        const forward = 1 - motion.curvature * this.wheelY[w]!
        const lateral = motion.curvature * this.wheelX[w]!
        this.spins[w]! +=
          (commanded * Math.sign(forward) * Math.hypot(forward, lateral)) / o.geometry.wheelRadius
      }
      this.stuckRun = slip >= o.stuckAbove ? this.stuckRun + commanded : 0
      const metre = Math.floor(this.odometer)
      if (slip > o.slipEventAbove && metre !== this.slipMetre) {
        this.slipMetre = metre
        this.emit('slip', { slip })
      }
      if (ends) this.nextMotion()
      else c.along += actual
      if (this.stuckRun >= o.stuckAfterM) break
    }
    this.speed = moved * o.simHz
  }

  private nextMotion(): void {
    this.cursor.motion++
    this.cursor.along = 0
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
    )
  }

  /**
   * Ends the drive: a last short-range reveal where the rover stopped, then standstill up to the
   * next keyframe so the block ends on the final pose.
   */
  private finish(
    kind: DriveOutcome['kind'],
    reasons: string[],
    event: DriveEventType,
    details?: Record<string, DriveEventDetail>,
  ): DriveOutcome {
    this.emit(event, { ...(reasons.length > 0 && { reasons }), ...details })
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

  private emit(type: DriveEventType, details?: Record<string, DriveEventDetail>): void {
    const event: DriveEvent = { t: this.time(), type, x: this.cursor.x, y: this.cursor.y }
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
    turnRate: turnRateRadPerS,
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
