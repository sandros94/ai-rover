export type Vec3 = [number, number, number]
/** Row-major 3×3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number]
export interface Rigid {
  r: Mat3
  t: Vec3
}

export interface UrdfJoint {
  name: string
  type: string
  parent: string
  child: string
  origin: Rigid
  axis: Vec3
  /** Lower and upper joint limits, radians, for revolute joints. */
  limit?: [number, number]
}

export interface UrdfLink {
  name: string
  /** The visual mesh stem (file name without `.gltf`) and its origin, when the link has one. */
  visual?: { stem: string; origin: Rigid }
}

export function parseUrdf(xml: string): { links: Map<string, UrdfLink>; joints: UrdfJoint[] } {
  // Hidden visuals are commented out in the file; drop comments before matching.
  const text = xml.replace(/<!--[\s\S]*?-->/g, '')
  const links = new Map<string, UrdfLink>()
  for (const match of text.matchAll(/<link name="([^"]+)">([\s\S]*?)<\/link>/g)) {
    const [, name, body] = match
    const visual = /<visual[^>]*>([\s\S]*?)<\/visual>/.exec(body!)?.[1]
    const link: UrdfLink = { name: name! }
    if (visual) {
      const mesh = /<mesh filename="\.\/meshes\/([^"]+)\.gltf"/.exec(visual)
      if (mesh) link.visual = { stem: mesh[1]!, origin: originOf(visual) }
    }
    links.set(name!, link)
  }
  const joints: UrdfJoint[] = []
  for (const match of text.matchAll(/<joint name="([^"]+)" type="([^"]+)">([\s\S]*?)<\/joint>/g)) {
    const [, name, type, body] = match
    const axis = /<axis xyz="([^"]+)"/.exec(body!)?.[1]
    const limit = /<limit lower="([^"]+)" upper="([^"]+)"/.exec(body!)
    joints.push({
      name: name!,
      type: type!,
      parent: /<parent link="([^"]+)"/.exec(body!)![1]!,
      child: /<child link="([^"]+)"/.exec(body!)![1]!,
      origin: originOf(body!),
      axis: axis ? vec(axis) : [0, 0, 0],
      ...(limit && { limit: [Number(limit[1]), Number(limit[2])] as [number, number] }),
    })
  }
  return { links, joints }
}

export function originOf(xml: string): Rigid {
  const match = /<origin xyz="([^"]+)" rpy="([^"]+)"/.exec(xml)
  if (!match) return { r: rpy([0, 0, 0]), t: [0, 0, 0] }
  return { r: rpy(vec(match[2]!)), t: vec(match[1]!) }
}

export const vec = (s: string): Vec3 => s.trim().split(/\s+/).map(Number) as Vec3

/** URDF roll-pitch-yaw: fixed-axis x, then y, then z, i.e. Rz(yaw)·Ry(pitch)·Rx(roll). */
export function rpy([roll, pitch, yaw]: Vec3): Mat3 {
  const [cr, sr, cp, sp, cy, sy] = [
    Math.cos(roll),
    Math.sin(roll),
    Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw),
    Math.sin(yaw),
  ]
  return [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    -sp,
    cp * sr,
    cp * cr,
  ]
}

export function mulMat(a: Mat3, b: Mat3): Mat3 {
  const out = Array.from({ length: 9 }, () => 0) as Mat3
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0
      for (let k = 0; k < 3; k++) sum += a[3 * i + k]! * b[3 * k + j]!
      out[3 * i + j] = sum
    }
  }
  return out
}

export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

export const compose = (a: Rigid, b: Rigid): Rigid => ({
  r: mulMat(a.r, b.r),
  t: add(apply(a.r, b.t), a.t),
})
export const invert = (a: Rigid): Rigid => {
  const rt = transpose(a.r)
  const t = apply(rt, a.t)
  return { r: rt, t: [-t[0], -t[1], -t[2]] }
}
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const transformPoint = (a: Rigid, p: Vec3): Vec3 => add(apply(a.r, p), a.t)

/** URDF (x forward, y right, z down) to app (x forward, y left, z up). */
export const C: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1]
export const toApp = (a: Rigid): Rigid => ({ r: mulMat(mulMat(C, a.r), C), t: apply(C, a.t) })

/** Rotation by `angle` radians about the unit `axis` (Rodrigues). */
export function aboutAxis([x, y, z]: Vec3, angle: number): Mat3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const k = 1 - c
  return [
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
  ]
}

export type LinkPoses = Map<string, { pose: Rigid; joint?: UrdfJoint }>

/** Each link's pose in the rover frame, joints at `values` (radians, by joint name) or zero. */
export function linkPoses(joints: UrdfJoint[], values: Map<string, number>): LinkPoses {
  const byChild = new Map(joints.map((j) => [j.child, j]))
  const poses: LinkPoses = new Map()
  const resolve = (link: string): Rigid => {
    const known = poses.get(link)
    if (known) return known.pose
    const joint = byChild.get(link)
    // The chassis hangs off `ground` by a floating joint at the identity: it is the rover frame.
    if (!joint || joint.type === 'floating') {
      const pose = { r: rpy([0, 0, 0]), t: [0, 0, 0] as Vec3 }
      poses.set(link, { pose })
      return pose
    }
    const pose = compose(resolve(joint.parent), jointTransform(joint, values.get(joint.name) ?? 0))
    poses.set(link, { pose, joint })
    return pose
  }
  for (const joint of joints) resolve(joint.child)
  return poses
}

/** A joint's child frame in its parent's, the joint turned to `value`. */
export const jointTransform = (joint: UrdfJoint, value: number): Rigid =>
  value === 0
    ? joint.origin
    : { r: mulMat(joint.origin.r, aboutAxis(joint.axis, value)), t: joint.origin.t }

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/**
 * The value of revolute `joint` that turns `from` (a direction in its child frame) onto `to` (a
 * direction in its parent frame, perpendicular to the axis), within the joint's limits.
 */
export function aim(joint: UrdfJoint, from: Vec3, to: Vec3): number {
  // `to` in the joint's own frame, before it turns; both directions projected off the axis.
  const target = apply(transpose(joint.origin.r), to)
  const flat = (v: Vec3): Vec3 => sub(v, scale(joint.axis, dot(joint.axis, v)))
  const [f, t] = [flat(from), flat(target)]
  let angle = Math.atan2(dot(joint.axis, cross(f, t)), dot(f, t))
  const [lower, upper] = joint.limit ?? [-Infinity, Infinity]
  while (angle < lower) angle += 2 * Math.PI
  while (angle > upper) angle -= 2 * Math.PI
  if (angle < lower) throw new Error(`rover-model: ${joint.name} cannot reach the wanted pose.`)
  return angle
}

/**
 * The remote sensing mast deployed, as it drives on Mars: the mast is upright in the chassis
 * mesh; the head's elevation joint levels the Navcam boresight (the left Navcam frame towards its
 * field-of-view frame) and the azimuth joint turns it forward. At zero both joints leave the head
 * facing the deck and turned aft (the azimuth joint's origin carries a 179° yaw).
 */
export function deployedMast(joints: UrdfJoint[]): Map<string, number> {
  const byName = (name: string) => {
    const joint = joints.find((j) => j.name === name)
    if (!joint) throw new Error(`rover-model: joint ${name} is not in the URDF.`)
    return joint
  }
  const azimuth = byName('RSM_AZ_ENC')
  const elevation = byName('RSM_EL_ENC')
  const camera = byName('Joint_for_Frame_NCL').origin.t
  const boresight = sub(byName('Joint_for_Frame_NCL_FOV').origin.t, camera)
  const forward: Vec3 = [1, 0, 0]
  // Level within the azimuth link, whose z axis is the rover's: the boresight onto its +x ...
  const el = aim(elevation, boresight, forward)
  // ... and the azimuth link's +x onto the rover's (the chassis is the rover frame).
  const az = aim(azimuth, forward, forward)
  return new Map([
    [azimuth.name, az],
    [elevation.name, el],
  ])
}
