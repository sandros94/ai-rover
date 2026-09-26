import { KEYFRAME_FIELDS } from '../../drive/keyframes'
import type { ResolvedRoverGeometry } from '../../rover/geometry'
import { DEFAULT_ROVER_GEOMETRY } from '../../rover/geometry'
import type { Point3 } from '../../rover/kinematics'
import { bodyLinkage } from '../../rover/kinematics'
import type { RoverLimits } from '../../rover/limits'
import { DEFAULT_ROVER_LIMITS } from '../../rover/limits'

/** A keyframe's attitude and suspension, with the conventions of `RoverPose`. */
export interface FrameAttitude {
  pitchRad: number
  rollRad: number
  /** Angle between body z and world up. */
  tiltRad: number
  rocker: { left: number; right: number }
  bogie: { left: number; right: number }
  /** The left rocker angle. */
  differentialRad: number
  /** Cumulative wheel rotation, radians, order FL, FR, ML, MR, RL, RR. */
  spins: number[]
}

const at = (frame: ArrayLike<number>, name: (typeof KEYFRAME_FIELDS)[number]): number =>
  frame[KEYFRAME_FIELDS.indexOf(name)]!

const SPIN_FIELDS = ['spinFL', 'spinFR', 'spinML', 'spinMR', 'spinRL', 'spinRR'] as const

/** Reads attitude and suspension from the 19 keyframe values. */
export function frameAttitude(frame: ArrayLike<number>): FrameAttitude {
  const [x, y, z, w] = [at(frame, 'qx'), at(frame, 'qy'), at(frame, 'qz'), at(frame, 'qw')]
  // Pitch and roll of `Rz(heading) · Ry(pitch) · Rx(roll)`, independent of heading.
  const pitchRad = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))))
  const rollRad = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
  const rockerL = at(frame, 'rockerL')
  return {
    pitchRad,
    rollRad,
    tiltRad: Math.acos(Math.min(1, Math.cos(pitchRad) * Math.cos(rollRad))),
    rocker: { left: rockerL, right: at(frame, 'rockerR') },
    bogie: { left: at(frame, 'bogieL'), right: at(frame, 'bogieR') },
    differentialRad: rockerL,
    spins: SPIN_FIELDS.map((name) => at(frame, name)),
  }
}

/**
 * Linkage joints in the level frame: the body frame turned by pitch and roll only, so x points
 * along the heading on the horizontal, y left, z up; the origin stays at the body origin.
 */
export interface RoverLinkage {
  /** Order FL, FR, ML, MR, RL, RR. */
  wheels: Point3[]
  /**
   * Left, right. The geometry places pivots only in the side plane; laterally the rocker pivots
   * sit at the belly-pan sides and the bogie pivots in the rear wheels' plane.
   */
  rockerPivots: Point3[]
  /** Left, right. */
  bogiePivots: Point3[]
}

type Articulation = Pick<FrameAttitude, 'pitchRad' | 'rollRad' | 'rocker' | 'bogie'>

/** Turns a body-frame point into the level frame by `Ry(pitch) · Rx(roll)`. */
export function levelPoint(
  attitude: Pick<FrameAttitude, 'pitchRad' | 'rollRad'>,
  p: Point3,
): Point3 {
  const cp = Math.cos(attitude.pitchRad)
  const sp = Math.sin(attitude.pitchRad)
  const cr = Math.cos(attitude.rollRad)
  const sr = Math.sin(attitude.rollRad)
  return {
    x: cp * p.x + sp * sr * p.y + sp * cr * p.z,
    y: cr * p.y - sr * p.z,
    z: -sp * p.x + cp * sr * p.y + cp * cr * p.z,
  }
}

/** The rocker-bogie joints at an articulation, from the same linkage the pose solver uses. */
export function roverLinkage(
  attitude: Articulation,
  geometry: ResolvedRoverGeometry = DEFAULT_ROVER_GEOMETRY,
): RoverLinkage {
  const body = bodyLinkage(
    geometry,
    attitude.rocker.left,
    attitude.bogie.left,
    attitude.bogie.right,
  )
  const point = (k: number, y = body[4 * k + 1]!): Point3 =>
    levelPoint(attitude, { x: body[4 * k]!, y, z: body[4 * k + 2]! })
  const { x, z } = geometry.rockerPivot
  const side = geometry.bellyWidth / 2
  const arm = geometry.rearWheel.y
  return {
    wheels: [0, 1, 2, 3, 4, 5].map((k) => point(k)),
    rockerPivots: [side, -side].map((y) => levelPoint(attitude, { x, y, z })),
    bogiePivots: [point(6, arm), point(7, -arm)],
  }
}

/** Closed set, in rising severity. */
export type AttitudeLevel = 'ok' | 'warn' | 'fail'

export type AttitudeReading =
  | 'pitch'
  | 'roll'
  | 'tilt'
  | 'differential'
  | 'bogieLeft'
  | 'bogieRight'

/**
 * Grades each reading against the flight limits: `warn` past its limit, `fail` past the
 * tip-over tilt for pitch, roll and tilt. Belly clearance needs the terrain under the body, which
 * a keyframe does not carry, so it is not graded here.
 */
export function attitudeLevels(
  attitude: FrameAttitude,
  limits: RoverLimits = {},
): Record<AttitudeReading, AttitudeLevel> {
  const l = { ...DEFAULT_ROVER_LIMITS, ...limits }
  const grade = (value: number, warnAbove: number, failAbove = Infinity): AttitudeLevel =>
    Math.abs(value) > failAbove ? 'fail' : Math.abs(value) > warnAbove ? 'warn' : 'ok'
  return {
    pitch: grade(attitude.pitchRad, l.pitchRad, l.tipOverRad),
    roll: grade(attitude.rollRad, l.rollRad, l.tipOverRad),
    tilt: grade(attitude.tiltRad, l.tiltRad, l.tipOverRad),
    differential: grade(attitude.differentialRad, l.differentialRad),
    bogieLeft: grade(attitude.bogie.left, l.bogieRad),
    bogieRight: grade(attitude.bogie.right, l.bogieRad),
  }
}
