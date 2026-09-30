import type { Object3D } from 'three'
import type { RoverPose } from '#shared/utils/rover'
import { DEFAULT_ROVER_LIMITS } from '#shared/utils/rover'
import { DIFFERENTIAL_RATIO } from '#shared/utils/client/scene'

/** One articulated node of the rover model, as the joints preview drives it. */
export interface JointControl {
  /** Model node name. */
  node: string
  /** URDF joint name. */
  joint: string
  /** Slider range, radians. */
  min: number
  max: number
  /** The value the model's rest pose holds. */
  rest: number
}

/**
 * Ranges for the joints the URDF leaves unlimited: the suspension over the solver's warning
 * limits (the differential's is the rocker's), steering a quarter turn each way, wheels a full
 * turn.
 */
function travel(node: string): [number, number] {
  const { differentialRad, bogieRad } = DEFAULT_ROVER_LIMITS
  if (node.endsWith('_rocker')) return [-differentialRad, differentialRad]
  if (node === 'differential') {
    return [-DIFFERENTIAL_RATIO * differentialRad, DIFFERENTIAL_RATIO * differentialRad]
  }
  if (node.endsWith('_bogie')) return [-bogieRad, bogieRad]
  if (node.startsWith('steer_')) return [-Math.PI / 2, Math.PI / 2]
  return [-Math.PI, Math.PI]
}

/** Every node of `model` carrying a URDF joint, in tree order, with its slider range. */
export function jointControls(model: Object3D): JointControl[] {
  const controls: JointControl[] = []
  model.traverse((node) => {
    const extras = node.userData as { joint?: string; limit?: [number, number]; baked?: number }
    if (!extras.joint) return
    const [min, max] = extras.limit ?? travel(node.name)
    controls.push({ node: node.name, joint: extras.joint, min, max, rest: extras.baked ?? 0 })
  })
  return controls
}

/** The joints a solved pose sets; the rest stay on their sliders. */
export const SOLVED_JOINTS: ReadonlySet<string> = new Set([
  'left_rocker',
  'right_rocker',
  'left_bogie',
  'right_bogie',
  'differential',
])

/**
 * The suspension's joint values for a solved pose, by model node name, as the rig turns them:
 * rockers and bogies as solved, the differential bar following the left rocker.
 */
export function solvedJoints(pose: RoverPose): Record<string, number> {
  return {
    left_rocker: pose.rocker.left,
    right_rocker: pose.rocker.right,
    left_bogie: pose.bogie.left,
    right_bogie: pose.bogie.right,
    differential: -DIFFERENTIAL_RATIO * pose.rocker.left,
  }
}

/**
 * The rocker values that go with `node` set to `value`: the differential keeps the rockers equal
 * and opposite, and its bar follows the left one.
 */
export function coupledJoints(node: string, value: number): Record<string, number> {
  const left =
    node === 'left_rocker'
      ? value
      : node === 'right_rocker'
        ? -value
        : node === 'differential'
          ? -value / DIFFERENTIAL_RATIO
          : undefined
  if (left === undefined) return { [node]: value }
  return { left_rocker: left, right_rocker: -left, differential: -DIFFERENTIAL_RATIO * left }
}
