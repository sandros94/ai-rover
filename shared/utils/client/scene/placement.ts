import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '../../drive/keyframes'
import type { Point3 } from '../../rover/kinematics'

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

/**
 * The shortest rotation taking unit vector `a` onto unit vector `b`. For opposite vectors it
 * turns half a revolution about an axis perpendicular to `a`.
 */
export function fromTo(a: Point3, b: Point3): Quat {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  if (dot < -1 + 1e-12) {
    const axis = Math.abs(a.x) < 0.9 ? { x: 0, y: a.z, z: -a.y } : { x: -a.z, y: 0, z: a.x }
    const n = Math.hypot(axis.x, axis.y, axis.z)
    return { x: axis.x / n, y: axis.y / n, z: axis.z / n, w: 0 }
  }
  const q = {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
    w: 1 + dot,
  }
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }
}

const field = (name: (typeof KEYFRAME_FIELDS)[number]) => KEYFRAME_FIELDS.indexOf(name)

/**
 * Where a keyframe puts the body frame in the world: the recorded position and world-from-body
 * quaternion, used as they are. The producer solved the pose; the client never re-solves it.
 */
export function framePlacement(frame: ArrayLike<number>): { position: Point3; quaternion: Quat } {
  return {
    position: { x: frame[field('x')]!, y: frame[field('y')]!, z: frame[field('z')]! },
    quaternion: {
      x: frame[field('qx')]!,
      y: frame[field('qy')]!,
      z: frame[field('qz')]!,
      w: frame[field('qw')]!,
    },
  }
}

/** A keyframe of a level, unarticulated rover at rest: for markers such as death ghosts. */
export function flatFrame(pose: Point3 & { headingRad: number }): Float32Array {
  const frame = new Float32Array(KEYFRAME_STRIDE)
  frame[field('x')] = pose.x
  frame[field('y')] = pose.y
  frame[field('z')] = pose.z
  frame[field('qz')] = Math.sin(pose.headingRad / 2)
  frame[field('qw')] = Math.cos(pose.headingRad / 2)
  return frame
}
