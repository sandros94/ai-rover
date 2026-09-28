import type { ArmPose } from '../../rover/arm'
import { ARM_JOINTS, ARM_STOWED } from '../../rover/arm'
import type { Point3 } from '../../rover/kinematics'
import { MARS_SOL_SECONDS } from '../instruments/sol-clock'
import { frameAttitude } from '../instruments/attitude-geometry'
import type { FrameAttitude } from '../instruments/attitude-geometry'
import type { Quat } from './rover-parts'
import { framePlacement } from './rover-parts'
import { DEFAULT_LATITUDE_DEG, sunCrossings } from './sun'

/**
 * The articulated nodes of the JPL rover model (`public/models/rover/*.glb`), named after the
 * URDF joints they carry. The steering links are nodes too but stay straight: keyframes carry no
 * steering.
 */
export const ROVER_RIG_NODES = [
  'differential',
  'left_rocker',
  'right_rocker',
  'left_bogie',
  'right_bogie',
  'wheel_lf',
  'wheel_rf',
  'wheel_lm',
  'wheel_rm',
  'wheel_lr',
  'wheel_rr',
] as const

export type RigNode = (typeof ROVER_RIG_NODES)[number]

/**
 * The model's differential bar turns this many radians per radian of left rocker. Each rocker
 * carries a crank rising 273.6 mm above its pivot, and a rod joins the crank's top to the bar's
 * end, 639.2 mm out from the bar's pivot (`scripts/rover-model.ts` prints both), so the bar end
 * follows the crank's top fore and aft.
 */
export const DIFFERENTIAL_RATIO = 0.2736 / 0.6392

type Articulation = Pick<FrameAttitude, 'rocker' | 'bogie' | 'spins'>

/**
 * Each rig node's URDF joint, its axis in the body frame (x forward, y left, z up) and its joint
 * value from a keyframe. The URDF frame is x forward, y right, z down, so its `0 1 0` rocker and
 * bogie axes are −y here: a positive value raises the front, the solver's nose-up convention, and
 * its `0 −1 0` drive axes are +y: forward spin carries the top of the wheel forward.
 */
export const RIG_JOINTS: Record<
  RigNode,
  { urdf: string; axis: Point3; value: (a: Articulation) => number }
> = {
  differential: {
    urdf: 'CENTER_DIFFERENTIAL',
    axis: { x: 0, y: 0, z: -1 },
    // The left rocker's crank top swings aft as its front rises, dragging the bar's left end aft:
    // a turn about +z, which is a negative value about the URDF's downward axis.
    value: (a) => -DIFFERENTIAL_RATIO * a.rocker.left,
  },
  left_rocker: {
    urdf: 'LEFT_DIFFERENTIAL',
    axis: { x: 0, y: -1, z: 0 },
    value: (a) => a.rocker.left,
  },
  right_rocker: {
    urdf: 'RIGHT_DIFFERENTIAL',
    axis: { x: 0, y: -1, z: 0 },
    value: (a) => a.rocker.right,
  },
  left_bogie: { urdf: 'LEFT_BOGIE', axis: { x: 0, y: -1, z: 0 }, value: (a) => a.bogie.left },
  right_bogie: { urdf: 'RIGHT_BOGIE', axis: { x: 0, y: -1, z: 0 }, value: (a) => a.bogie.right },
  wheel_lf: { urdf: 'LF_DRIVE', axis: { x: 0, y: 1, z: 0 }, value: (a) => a.spins[0] ?? 0 },
  wheel_rf: { urdf: 'RF_DRIVE', axis: { x: 0, y: 1, z: 0 }, value: (a) => a.spins[1] ?? 0 },
  wheel_lm: { urdf: 'LM_DRIVE', axis: { x: 0, y: 1, z: 0 }, value: (a) => a.spins[2] ?? 0 },
  wheel_rm: { urdf: 'RM_DRIVE', axis: { x: 0, y: 1, z: 0 }, value: (a) => a.spins[3] ?? 0 },
  wheel_lr: { urdf: 'LR_DRIVE', axis: { x: 0, y: 1, z: 0 }, value: (a) => a.spins[4] ?? 0 },
  wheel_rr: { urdf: 'RR_DRIVE', axis: { x: 0, y: 1, z: 0 }, value: (a) => a.spins[5] ?? 0 },
}

export interface RigTransforms {
  /** Where the model's root (the chassis node, at the body origin) goes in the world. */
  position: Point3
  /** World-from-body rotation. */
  quaternion: Quat
  /** Rotation of each rig node on top of its rest transform in the model. */
  joints: Record<RigNode, Quat>
}

/**
 * Poses the JPL model from a keyframe: the body placement as recorded, and each joint turned by
 * the recorded suspension angle or wheel spin about its URDF axis. The solver's default geometry
 * shares the model's pivots, so the hubs sit on the solver's wheel centres to within the 2.5 mm
 * the wheel mounts differ by.
 */
export function rigTransforms(frame: ArrayLike<number>): RigTransforms {
  const attitude = frameAttitude(frame)
  const { position, quaternion } = framePlacement(frame)
  const joints = {} as Record<RigNode, Quat>
  for (const name of ROVER_RIG_NODES) {
    const { axis, value } = RIG_JOINTS[name]
    joints[name] = aboutAxis(axis, value(attitude))
  }
  return { position, quaternion, joints }
}

function aboutAxis(axis: Point3, angle: number): Quat {
  const s = Math.sin(angle / 2)
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) }
}

/**
 * The arm at night: raised above and ahead of the front deck, the turret turned so the WATSON
 * camera's LEDs light the ground about 3 m ahead of the front wheels. A design choice for the
 * night view, not a configuration the rover drives in: Perseverance drives by day with its arm
 * stowed and carries no headlights. Within the URDF's limits, and clear of the mast, the deck
 * and the wheels over the suspension's travel (the model's tests measure it).
 */
export const ARM_NIGHT: ArmPose = {
  arm_1: -1.9437,
  arm_2: -1.2606,
  arm_3: -1.0837,
  arm_4: 1.2433,
  arm_5: 4.2319,
}

/** Seconds of playback the arm takes from stowed to its night pose after sunset, and back after sunrise. */
export const ARM_EASE_S = 30

/**
 * How far the arm has gone from stowed towards {@link ARM_NIGHT} at `solFraction`: 0 by day, 1
 * by night, easing in and out over {@link ARM_EASE_S} of the sol's clock from the moment the
 * sun's centre sets, and back from the moment it rises. A function of the clock alone, so a
 * replay scrubbed to any moment draws the arm where it would be.
 */
export function nightArmBlend(solFraction: number, latitudeDeg = DEFAULT_LATITUDE_DEG): number {
  const { rise, set } = sunCrossings(latitudeDeg)
  const f = solFraction - Math.floor(solFraction)
  const since = (from: number) => ((f - from + 1) % 1) * MARS_SOL_SECONDS
  const night = f >= set || f < rise
  const progress = night
    ? Math.min(1, since(set) / ARM_EASE_S)
    : 1 - Math.min(1, since(rise) / ARM_EASE_S)
  return progress * progress * (3 - 2 * progress)
}

/** The arm's joint values `blend` of the way from stowed to {@link ARM_NIGHT}, joint by joint. */
export function armPose(blend: number): ArmPose {
  const pose = {} as ArmPose
  for (const { node } of ARM_JOINTS) {
    pose[node] = ARM_STOWED[node] + (ARM_NIGHT[node] - ARM_STOWED[node]) * blend
  }
  return pose
}
