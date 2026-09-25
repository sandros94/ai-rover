import type { ResolvedRoverGeometry, RoverPose } from '#shared/utils/rover'
import { RoverError } from '#shared/utils/rover'

/** The RoverError thrown by `fn`, or undefined when it throws nothing or something else. */
export function roverErrorOf(fn: () => unknown): RoverError | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof RoverError) return error
  }
  return undefined
}

export const DEG = Math.PI / 180

type Vec3 = { x: number; y: number; z: number }

/** Rotates `v` by the unit quaternion `q`. */
function rotate(q: RoverPose['quaternion'], v: Vec3): Vec3 {
  const { x: qx, y: qy, z: qz, w: qw } = q
  const tx = 2 * (qy * v.z - qz * v.y)
  const ty = 2 * (qz * v.x - qx * v.z)
  const tz = 2 * (qx * v.y - qy * v.x)
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  }
}

/** Nose-up rotation by `angle` of (x, z) about (cx, cz), in a body side plane. */
function rotateUp(x: number, z: number, cx: number, cz: number, angle: number): [number, number] {
  const dx = x - cx
  const dz = z - cz
  return [
    cx + dx * Math.cos(angle) - dz * Math.sin(angle),
    cz + dx * Math.sin(angle) + dz * Math.cos(angle),
  ]
}

/**
 * Wheel centres rebuilt independently from the solved pose: the linkage is posed in the body
 * frame from its rocker and bogie angles, then carried to the world by the quaternion and
 * position. Order FL, FR, ML, MR, RL, RR.
 */
export function wheelsFromPose(pose: RoverPose, geometry: ResolvedRoverGeometry): Vec3[] {
  const { wheelRadius: r, frontWheel, middleWheel, rearWheel, rockerPivot, bogiePivot } = geometry
  const out: Vec3[] = []
  const sides = [
    { sign: 1, rocker: pose.rocker.left, bogie: pose.bogie.left },
    { sign: -1, rocker: pose.rocker.right, bogie: pose.bogie.right },
  ]
  const body: Vec3[] = []
  for (const [k, wheel] of [frontWheel, middleWheel, rearWheel].entries()) {
    for (const { sign, rocker, bogie } of sides) {
      let [x, z] = [wheel.x, r]
      if (k > 0) [x, z] = rotateUp(x, z, bogiePivot.x, bogiePivot.z, bogie)
      ;[x, z] = rotateUp(x, z, rockerPivot.x, rockerPivot.z, rocker)
      body.push({ x, y: sign * wheel.y, z })
    }
  }
  for (const b of body) {
    const w = rotate(pose.quaternion, b)
    out.push({ x: pose.position.x + w.x, y: pose.position.y + w.y, z: pose.position.z + w.z })
  }
  return out
}
