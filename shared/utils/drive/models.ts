import type { Motion } from '../nav/motions'
import type { ResolvedRoverGeometry } from '../rover/geometry'
import { DEFAULT_ROVER_GEOMETRY } from '../rover/geometry'
import { AUTONAV_EFFECTIVE_MPS, ROVER_MAX_SPEED_MPS } from '../rover/speed'
import { DriveError } from './errors'
import type { ProfileLimits } from './profile'
import { planMove } from './profile'

/** Rover speed on the ground; omitted fields take the defaults below. */
export interface SpeedModel {
  /**
   * Flat-ground drive speed, m/s. Default `AUTONAV_EFFECTIVE_MPS` (0.033, Perseverance's 120 m/h
   * under AutoNav): the rover thinks while driving, so this is its speed, not an average over stops.
   */
  cruiseSpeedMps?: number
  /** Fraction of `cruiseSpeedMps` lost at the slope limit, linear in tan(slope). Default 0.5. */
  slopeSlowdown?: number
  /**
   * Turn-in-place rate, rad/s. Default about 1.5°/s: the corner wheels farthest from the centre
   * roll at the 0.042 m/s wheel-speed cap, as the flight software drives the wheel on the widest
   * circle at the top rate and the others in proportion.
   */
  turnRateRadPerS?: number
  /** Rate each corner wheel steers at, rad/s, standing still. Default 0.168 (about 9.6°/s). */
  steerRateRadPerS?: number
  /**
   * Largest drive acceleration and deceleration, m/s². Default 0.025: with the jerk below, rest
   * to 0.033 m/s in about 2 s over about 3 cm.
   */
  accelMps2?: number
  /** Largest rate of change of the drive acceleration, m/s³. Default 0.04. */
  jerkMps3?: number
  /**
   * Deceleration of a drive ended by a fault under the rover (a failing pose, getting stuck),
   * m/s², constant and without a jerk limit. Default 0.1: from 0.033 m/s to rest in 0.33 s.
   */
  emergencyDecelMps2?: number
  /** Largest angular acceleration of a turn in place, rad/s². Default about 0.0157. */
  turnAccelRadPerS2?: number
  /** Largest angular jerk of a turn in place, rad/s³. Default about 0.0251. */
  turnJerkRadPerS3?: number
  /** Largest angular acceleration of a corner wheel steering, rad/s². Default about 0.095. */
  steerAccelRadPerS2?: number
  /** Largest angular jerk of a corner wheel steering, rad/s³. Default about 0.152. */
  steerJerkRadPerS3?: number
}

/**
 * The rover stops only for a reason, and each stop is an event: steering (timed by the speed
 * model's steering rate), turns in place (by its turn rate), an assessment before every replan,
 * and periodic imaging.
 */
export interface StopModel {
  /**
   * Ground distance between imaging stops, metres; none within {@link IMAGING_END_MARGIN} of
   * either end. Default 25.
   */
  imagingEveryM?: number
  /** Length of an imaging stop, seconds. Default 30. */
  imagingStopS?: number
  /** Standstill while the rover assesses newly found blocking ground before replanning, seconds. Default 20. */
  assessStopS?: number
}

const DEG = Math.PI / 180

/** Distance from the body centre to the corner wheel on the widest turn-in-place circle, metres. */
const OUTER_CORNER_M = Math.max(
  Math.hypot(DEFAULT_ROVER_GEOMETRY.frontWheel.x, DEFAULT_ROVER_GEOMETRY.frontWheel.y),
  Math.hypot(DEFAULT_ROVER_GEOMETRY.rearWheel.x, DEFAULT_ROVER_GEOMETRY.rearWheel.y),
)
// UNVERIFIED, both: no acceleration or jerk of the rover is published. Judgement calls that make
// a start or a stop take about 2 s, a ramp visible at 1× yet short beside the stops; at 1,025 kg
// the acceleration asks 26 N of the wheels, far inside their traction on Mars.
const ACCEL_MPS2 = 0.025
const JERK_MPS3 = 0.04

/** The speed model a drive uses for omitted fields. */
export const DEFAULT_SPEED_MODEL: Readonly<Required<SpeedModel>> = Object.freeze({
  cruiseSpeedMps: AUTONAV_EFFECTIVE_MPS,
  slopeSlowdown: 0.5,
  turnRateRadPerS: ROVER_MAX_SPEED_MPS / OUTER_CORNER_M,
  // UNVERIFIED: no steering rate is published. The steer actuators are identical to the drive
  // actuators, whose output tops out at 0.168 rad/s, so the steering is taken to turn as fast.
  steerRateRadPerS: 0.168,
  accelMps2: ACCEL_MPS2,
  jerkMps3: JERK_MPS3,
  // UNVERIFIED: a judgement call, four times the drive's deceleration.
  emergencyDecelMps2: 0.1,
  // The turn is driven by its outer corner wheels, which ramp as a drive does.
  turnAccelRadPerS2: ACCEL_MPS2 / OUTER_CORNER_M,
  turnJerkRadPerS3: JERK_MPS3 / OUTER_CORNER_M,
  // The steer actuators are identical to the drive actuators: a steering joint ramps as a drive
  // wheel does to roll the drive's ramp.
  steerAccelRadPerS2: ACCEL_MPS2 / DEFAULT_ROVER_GEOMETRY.wheelRadius,
  steerJerkRadPerS3: JERK_MPS3 / DEFAULT_ROVER_GEOMETRY.wheelRadius,
})

/** The drive's profile limits at the cruise speed `rate`, m/s. */
export function driveLimits(
  rate: number,
  model: Pick<Required<SpeedModel>, 'accelMps2' | 'jerkMps3'> = DEFAULT_SPEED_MODEL,
): ProfileLimits {
  return { rate, accel: model.accelMps2, jerk: model.jerkMps3 }
}

/** The profile limits of a turn in place, radians of heading. */
export function turnLimits(
  model: Pick<
    Required<SpeedModel>,
    'turnRateRadPerS' | 'turnAccelRadPerS2' | 'turnJerkRadPerS3'
  > = DEFAULT_SPEED_MODEL,
): ProfileLimits {
  return {
    rate: model.turnRateRadPerS,
    accel: model.turnAccelRadPerS2,
    jerk: model.turnJerkRadPerS3,
  }
}

/** The profile limits of a steering joint, radians. */
export function steerLimits(
  model: Pick<
    Required<SpeedModel>,
    'steerRateRadPerS' | 'steerAccelRadPerS2' | 'steerJerkRadPerS3'
  > = DEFAULT_SPEED_MODEL,
): ProfileLimits {
  return {
    rate: model.steerRateRadPerS,
    accel: model.steerAccelRadPerS2,
    jerk: model.steerJerkRadPerS3,
  }
}

/** Seconds a turn in place of `angleRad` takes, from rest to rest. */
export function turnDurationS(angleRad: number, limits: ProfileLimits = turnLimits()): number {
  return planMove(Math.abs(angleRad), limits).durationS
}

/**
 * The stop model a drive uses for omitted fields. UNVERIFIED, all three: the references give no
 * periodic imaging stop (AutoNav images while driving) and no assessment time; a stop "when it
 * cannot quickly determine a safe path" is documented, and ENav's planning cycle takes 3–4 s,
 * scoring every candidate path more than 3 min. The values are judgement calls that keep 100 m
 * on flat ground near 0.032 m/s overall, inside the 0.026–0.033 m/s the record drives averaged.
 */
export const DEFAULT_STOP_MODEL: Readonly<Required<StopModel>> = Object.freeze({
  imagingEveryM: 25,
  imagingStopS: 30,
  assessStopS: 20,
})

/**
 * Share of the planned path at each end where a due imaging stop is skipped: the ground around
 * the stop left and the stop reached is imaged there, so a stop this close adds little.
 */
export const IMAGING_END_MARGIN = 0.05

/** Whether a due imaging stop is made `drivenM` along a path planned `plannedM` long. */
export function imagingAllowed(drivenM: number, plannedM: number): boolean {
  const margin = IMAGING_END_MARGIN * plannedM
  return drivenM >= margin && plannedM - drivenM >= margin
}

/** Where along a path of `lengthM` the imaging stops fall: every `everyM` where {@link imagingAllowed}. */
export function imagingStopsAt(lengthM: number, everyM: number): number[] {
  const at: number[] = []
  for (let k = 1; k * everyM < lengthM; k++) {
    if (imagingAllowed(k * everyM, lengthM)) at.push(k * everyM)
  }
  return at
}

/** Imaging stops along a path of `lengthM`, one every `everyM` where {@link imagingAllowed}. */
export function imagingStopCount(lengthM: number, everyM: number): number {
  return imagingStopsAt(lengthM, everyM).length
}

/**
 * Speed over ground at a slope `ratio` (tan slope over tan of the slope limit), m/s: the cruise
 * speed less `slopeSlowdown` of it at the limit, linear in between and held beyond. Drives and
 * the planner's time estimate both move by it.
 */
export function groundSpeedMps(
  ratio: number,
  model: Pick<Required<SpeedModel>, 'cruiseSpeedMps' | 'slopeSlowdown'> = DEFAULT_SPEED_MODEL,
): number {
  return model.cruiseSpeedMps * (1 - model.slopeSlowdown * Math.min(1, ratio))
}

/**
 * Corner steering angles, radians, order FL, FR, RL, RR: each about the body's up axis from
 * straight ahead, positive when the wheel's front turns left (counter-clockwise from above).
 * The middle wheels do not steer.
 */
export type SteeringAngles = [number, number, number, number]

/** How the wheels stand and roll for one motion. */
export interface Steering {
  angles: SteeringAngles
  /**
   * Ground each wheel rolls per unit of the motion's progress (a metre of the body's arc, or a
   * radian of a turn in place), metres, positive forward; order FL, FR, ML, MR, RL, RR.
   */
  roll: [number, number, number, number, number, number]
}

/** Travel limit of the corner steering, either way from straight ahead: the flight software's 85°. */
export const STEER_LIMIT_RAD = 85 * DEG
/**
 * A motion whose corner angles all lie within this of the wheels' current ones drives without
 * re-steering first. UNVERIFIED: a judgement call.
 */
export const STEER_THRESHOLD_RAD = 2 * DEG

/** Straight wheels, as a drive starts. */
export const STRAIGHT_WHEELS: Readonly<SteeringAngles> = Object.freeze([0, 0, 0, 0])

/**
 * The wheel angles and roll rates of a motion, about its turn centre (double Ackermann): each
 * corner wheel points along the tangent of its own circle about the common centre and rolls in
 * proportion to that circle's radius. A turn in place centres on the body origin, so the corner
 * wheels stand across the diagonals and the two sides roll opposite ways; a straight arc keeps
 * every wheel straight. A middle wheel, fixed straight, rolls the forward part of its motion.
 * Throws when the arc is so tight that a corner wheel would steer past {@link STEER_LIMIT_RAD}.
 */
export function steeringFor(
  motion: Motion,
  geometry: ResolvedRoverGeometry = DEFAULT_ROVER_GEOMETRY,
): Steering {
  const { frontWheel: f, middleWheel: m, rearWheel: r } = geometry
  const mounts = [
    [f.x, f.y],
    [f.x, -f.y],
    [m.x, m.y],
    [m.x, -m.y],
    [r.x, r.y],
    [r.x, -r.y],
  ] as const
  // The wheel's velocity in the body frame per unit of progress.
  const velocity =
    motion.type === 'turn'
      ? (x: number, y: number) => [-Math.sign(motion.angleRad) * y, Math.sign(motion.angleRad) * x]
      : (x: number, y: number) => [1 - motion.curvature * y, motion.curvature * x]
  const roll = [0, 0, 0, 0, 0, 0] as Steering['roll']
  const angles = [0, 0, 0, 0] as SteeringAngles
  for (const [w, [x, y]] of mounts.entries()) {
    const [forward, lateral] = velocity(x, y) as [number, number]
    if (w === 2 || w === 3) {
      roll[w] = forward
      continue
    }
    // Pointed along its velocity or against it, whichever lies within a quarter turn of straight.
    const angle =
      lateral === 0
        ? 0
        : forward === 0
          ? Math.sign(lateral) * (Math.PI / 2)
          : Math.atan(lateral / forward)
    if (Math.abs(angle) > STEER_LIMIT_RAD + 1e-12) {
      throw new DriveError(
        'INVALID_INPUT',
        `steeringFor: the motion needs a corner wheel at ${(angle / DEG).toFixed(1)}°, past the ±85° steering limit; pass an arc of radius at least ${minArcRadiusM(geometry).toFixed(3)} m.`,
      )
    }
    angles[w < 2 ? w : w - 2] = angle
    roll[w] = (forward < 0 ? -1 : 1) * Math.hypot(forward, lateral)
  }
  return { angles, roll }
}

/**
 * The tightest arc radius the corner steering reaches, metres: the inner corner wheels at
 * {@link STEER_LIMIT_RAD}.
 */
export function minArcRadiusM(geometry: ResolvedRoverGeometry = DEFAULT_ROVER_GEOMETRY): number {
  const { frontWheel: f, rearWheel: r } = geometry
  const tan = Math.tan(STEER_LIMIT_RAD)
  return Math.max(f.y + Math.abs(f.x) / tan, r.y + Math.abs(r.x) / tan)
}

/** The largest change any corner wheel makes from `from` to `to`, radians. */
export function steerTravelRad(
  from: Readonly<SteeringAngles>,
  to: Readonly<SteeringAngles>,
): number {
  let most = 0
  for (let k = 0; k < 4; k++) most = Math.max(most, Math.abs(to[k]! - from[k]!))
  return most
}

/**
 * Seconds the corner wheels take to steer from `from` to `to` standing still, all four at once
 * on one profile whose largest change moves from rest to rest under `limits`; 0 when every wheel
 * is already within {@link STEER_THRESHOLD_RAD}, when the rover drives on without steering.
 */
export function steerDurationS(
  from: Readonly<SteeringAngles>,
  to: Readonly<SteeringAngles>,
  limits: ProfileLimits = steerLimits(),
): number {
  const most = steerTravelRad(from, to)
  return most > STEER_THRESHOLD_RAD ? planMove(most, limits).durationS : 0
}

/**
 * Standstill spent steering along `motions` from straight wheels: before each motion whose
 * angles need it, {@link steerDurationS}. Drives and the planner's time estimate steer alike.
 */
export function steeringTimeS(
  motions: readonly Motion[],
  options: { geometry?: ResolvedRoverGeometry; limits?: ProfileLimits } = {},
): number {
  const { geometry, limits } = options
  let wheels: Readonly<SteeringAngles> = STRAIGHT_WHEELS
  let total = 0
  for (const motion of motions) {
    const { angles } = steeringFor(motion, geometry)
    const seconds = steerDurationS(wheels, angles, limits)
    if (seconds > 0) {
      total += seconds
      wheels = angles
    }
  }
  return total
}

/**
 * Seconds that starting and stopping add to driving `motions` at `limits.rate` throughout: the
 * drive comes to rest before each steering and turn in place, at each of `stopsAtM` (metres of
 * arc driven, as imaging stops fall) and at the end, and each run between two rests ramps up and
 * down on {@link planMove}. Drives and the planner's time estimate ramp alike.
 */
export function rampTimeS(
  motions: readonly Motion[],
  options: {
    geometry?: ResolvedRoverGeometry
    limits?: ProfileLimits
    stopsAtM?: readonly number[]
  } = {},
): number {
  const {
    geometry,
    limits = driveLimits(DEFAULT_SPEED_MODEL.cruiseSpeedMps),
    stopsAtM = [],
  } = options
  const rests = [...stopsAtM]
  let wheels: Readonly<SteeringAngles> = STRAIGHT_WHEELS
  let driven = 0
  for (const motion of motions) {
    const { angles } = steeringFor(motion, geometry)
    if (motion.type === 'turn' || steerTravelRad(wheels, angles) > STEER_THRESHOLD_RAD) {
      rests.push(driven)
      wheels = angles
    }
    if (motion.type === 'arc') driven += motion.lengthM
  }
  rests.push(driven)
  rests.sort((a, b) => a - b)
  let total = 0
  let from = 0
  for (const at of rests) {
    const run = Math.min(at, driven) - from
    if (run <= 0) continue
    total += planMove(run, limits).durationS - run / limits.rate
    from = Math.min(at, driven)
  }
  return total
}
