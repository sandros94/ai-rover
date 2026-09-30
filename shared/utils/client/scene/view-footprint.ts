import { LOD_FAR_M } from './terrain-mesh'

/** Where the scene's haze has closed in entirely, metres from the camera: nothing past it shows. */
export const HAZE_FAR_M = 4 * LOD_FAR_M

type Vec3 = { x: number; y: number; z: number }

/** The scene camera as it stands: world metres, z up. */
export interface CameraPose {
  position: Vec3
  /** The point it looks at. */
  target: Vec3
  /** Vertical field of view, degrees. */
  fovDeg: number
  /** Width over height of its view. */
  aspect: number
  /** The view's up direction in the world, unit length. */
  up: Vec3
}

/** What of the ground a camera shows, in world x, y. */
export interface ViewFootprint {
  /**
   * The ground seen, near edge first: the view's bottom-left and bottom-right corners, then
   * top-right and top-left; a triangle from `apex` when the bottom corners miss the ground.
   */
  polygon: { x: number; y: number }[]
  /** The camera's position on the ground. */
  apex: { x: number; y: number }
  /** Where the camera faces, radians from +x toward +y. */
  headingRad: number
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => ({
  x: a.x + k * b.x,
  y: a.y + k * b.y,
  z: a.z + k * b.z,
})
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(a.x, a.y, a.z)
  return { x: a.x / length, y: a.y / length, z: a.z / length }
}

/**
 * The ground `camera` shows: where the rays through the four corners of its view meet the
 * plane at height `groundZ`. A corner ray that misses the ground, or meets it farther than
 * `maxRangeM` from the camera's ground position, stops at that range along its own bearing, so a
 * camera near the horizon shows a trapezoid opening from where it stands, and one looking
 * straight down the rectangle under it. Undefined for a camera at or below the ground.
 */
export function viewFootprint(
  camera: CameraPose,
  groundZ: number,
  maxRangeM: number,
): ViewFootprint | undefined {
  const { position } = camera
  const height = position.z - groundZ
  if (!(height > 0)) return undefined
  const forward = unit(sub(camera.target, position))
  const right = unit(cross(forward, camera.up))
  const up = cross(right, forward)
  const tanV = Math.tan((camera.fovDeg * Math.PI) / 360)
  const tanH = tanV * camera.aspect
  const apex = { x: position.x, y: position.y }

  /**
   * Where the ray through view corner (`sx`, `sy`, each ±1) meets the ground within range
   * (`hit`), else the point at range along its bearing; null for a ray straight up.
   */
  const corner = (sx: number, sy: number) => {
    const ray = add(add(forward, right, sx * tanH), up, sy * tanV)
    const along = Math.hypot(ray.x, ray.y)
    const t = ray.z < 0 ? height / -ray.z : Infinity
    if (t * along <= maxRangeM) {
      return { point: { x: apex.x + t * ray.x, y: apex.y + t * ray.y }, hit: true }
    }
    if (along < 1e-9) return null
    const k = maxRangeM / along
    return { point: { x: apex.x + k * ray.x, y: apex.y + k * ray.y }, hit: false }
  }

  const near = [corner(-1, -1), corner(1, -1)]
  const far = [corner(1, 1), corner(-1, 1)]
  const polygon = [
    ...(near.every((c) => c?.hit) ? near.map((c) => c!.point) : [apex]),
    ...far.flatMap((c) => (c ? [c.point] : [])),
  ]
  // Straight down, the view's up says where it faces.
  const facing = add(forward, up)
  return { polygon, apex, headingRad: Math.atan2(facing.y, facing.x) }
}
