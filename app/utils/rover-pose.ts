import type { Object3D } from 'three'
import { Quaternion, Vector3 } from 'three'
import type { RigNode } from '#shared/utils/client/scene'
import { rigTransforms, ROVER_RIG_NODES } from '#shared/utils/client/scene'

/**
 * A copy of a rover model (either build: both carry the same nodes, joints and extras) with its
 * articulated nodes and their rest rotations.
 */
export interface PosableRover {
  object: Object3D
  rig: { node: Object3D; rest: Quaternion; name: RigNode }[]
  /** Nodes kept pointing at a point on another node: the differential's rods. */
  aims: Aim[]
  /** Every node carrying a URDF joint, by name: its rest, axis and the value baked into its rest. */
  jointed: Map<string, { node: Object3D; rest: Quaternion; axis: Vector3; baked: number }>
}

/**
 * A node that turns to keep its rest direction `from` (its own frame) pointing at `point` on
 * `target` (the target's frame), as the model's `extras.aim` declares.
 */
interface Aim {
  node: Object3D
  rest: Quaternion
  target: Object3D
  point: Vector3
  from: Vector3
}

/** `object`, a fresh copy of a rover model at rest, ready to pose. */
export function posableRover(object: Object3D): PosableRover {
  const rig = ROVER_RIG_NODES.map((name) => {
    const node = object.getObjectByName(name)
    if (!node) throw new Error(`posableRover: the rover model has no node ${name}.`)
    return { node, rest: node.quaternion.clone(), name }
  })
  const aims: Aim[] = []
  const jointed: PosableRover['jointed'] = new Map()
  object.traverse((node) => {
    const joint = node.userData as {
      joint?: string
      axis?: [number, number, number]
      baked?: number
    }
    if (joint.joint && joint.axis) {
      jointed.set(node.name, {
        node,
        rest: node.quaternion.clone(),
        axis: new Vector3(...joint.axis).normalize(),
        baked: joint.baked ?? 0,
      })
    }
    const aim = node.userData.aim as
      | { node: string; point: [number, number, number]; from: [number, number, number] }
      | undefined
    const target = aim && object.getObjectByName(aim.node)
    if (!aim || !target) return
    aims.push({
      node,
      rest: node.quaternion.clone(),
      target,
      point: new Vector3(...aim.point),
      from: new Vector3(...aim.from).normalize(),
    })
  })
  return { object, rig, aims, jointed }
}

const turn = new Quaternion()
const aimAt = new Vector3()
const aimTurn = new Quaternion()

/**
 * Poses `rover` at `frame`'s suspension and wheel spins, then `joints` (URDF joint values,
 * radians, by node name) over them: steering, mast and arm, or any rig joint turned by hand. The
 * body's placement is the caller's: the copy's own position and rotation stay as they are.
 */
export function poseRover(
  rover: PosableRover,
  frame: Float32Array,
  joints?: Readonly<Record<string, number>>,
): void {
  const { joints: rig } = rigTransforms(frame)
  for (const { node, rest, name } of rover.rig) {
    const q = rig[name]
    node.quaternion.copy(rest).multiply(turn.set(q.x, q.y, q.z, q.w))
  }
  for (const [name, value] of Object.entries(joints ?? {})) {
    const joint = rover.jointed.get(name)
    if (!joint) continue
    joint.node.quaternion
      .copy(joint.rest)
      .multiply(turn.setFromAxisAngle(joint.axis, value - joint.baked))
  }
  aimAll(rover)
}

/** Turns each aimed node, from its rest, so its `from` direction meets its target point. */
function aimAll(rover: PosableRover): void {
  if (!rover.aims.length) return
  rover.object.updateMatrixWorld(true)
  for (const { node, rest, target, point, from } of rover.aims) {
    // The target point in the node's parent frame, then relative to the node at rest.
    node.parent!.worldToLocal(target.localToWorld(aimAt.copy(point)))
    aimAt.sub(node.position).applyQuaternion(aimTurn.copy(rest).invert()).normalize()
    node.quaternion.copy(rest).multiply(aimTurn.setFromUnitVectors(from, aimAt))
  }
}
