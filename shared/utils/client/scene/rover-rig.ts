import type { Point3 } from '../../rover/kinematics'
import { frameAttitude } from '../instruments/attitude-geometry'
import type { FrameAttitude } from '../instruments/attitude-geometry'
import type { Quat } from './placement'
import { framePlacement } from './placement'

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
