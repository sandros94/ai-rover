import type { Point3 } from '../../rover/kinematics'
import type { Quat } from './placement'
import { fromTo } from './placement'

type Planar = { x: number; y: number }

const POST_HEIGHT_M = 1.6
const SPHERE_RADIUS_M = 0.12
/** The sphere's centre above the post's top, as a share of its radius: seated on it, not balanced. */
const SPHERE_SEAT = 0.6
const BAND_HEIGHT_M = 0.12
/** Post showing between the band and the sphere. */
const BAND_GAP_M = 0.03
const HEAD_Z = POST_HEIGHT_M + SPHERE_SEAT * SPHERE_RADIUS_M

/**
 * A stop's marker, metres, its foot at the ground: a thin post, a sphere seated on its top, a
 * coloured band round the post just under the sphere, and a dark disc where it meets the ground.
 * `headZ` and `bandZ` are the sphere's and the band's centres, `topZ` the sphere's top.
 */
export const STOP_MARKER = Object.freeze({
  postRadiusM: 0.04,
  postHeightM: POST_HEIGHT_M,
  sphereRadiusM: SPHERE_RADIUS_M,
  headZ: HEAD_Z,
  bandRadiusM: 0.06,
  bandHeightM: BAND_HEIGHT_M,
  bandZ: HEAD_Z - SPHERE_RADIUS_M - BAND_GAP_M - BAND_HEIGHT_M / 2,
  topZ: HEAD_Z + SPHERE_RADIUS_M,
  contactRadiusM: 0.3,
})

/** Where a stop's marker stands: its foot on the ground, and the turn laying its disc on the slope. */
export interface StopMarkerInstance {
  base: Point3
  /** Takes the disc's up (+z) onto the ground normal. */
  contact: Quat
  current: boolean
}

const UP: Point3 = Object.freeze({ x: 0, y: 0, z: 1 })

/**
 * The markers of `stops` on the ground at `heightAt`; unloaded ground is flat at 0. The slope
 * under the disc is measured across the disc, so a bump smaller than it does not tip it.
 */
export function stopMarkerInstances(
  stops: readonly (Planar & { current?: boolean })[],
  heightAt: (x: number, y: number) => number | undefined,
): StopMarkerInstance[] {
  const r = STOP_MARKER.contactRadiusM
  return stops.map((stop) => {
    const z = heightAt(stop.x, stop.y) ?? 0
    const at = (dx: number, dy: number) => heightAt(stop.x + dx, stop.y + dy) ?? z
    const gx = (at(r, 0) - at(-r, 0)) / (2 * r)
    const gy = (at(0, r) - at(0, -r)) / (2 * r)
    const length = Math.hypot(gx, gy, 1)
    const normal = { x: -gx / length, y: -gy / length, z: 1 / length }
    return {
      base: { x: stop.x, y: stop.y, z },
      contact: fromTo(UP, normal),
      current: stop.current === true,
    }
  })
}

/** A flag's pole and the cloth off its top, metres. */
export interface FlagSize {
  poleHeightM: number
  clothWidthM: number
  clothHeightM: number
}

/**
 * Flags, metres: a pole of the stop posts' family with a rectangular cloth off its top. The
 * current drive's destination flies the larger one; the open round's goals a smaller one.
 */
export const FLAG_MARKERS = Object.freeze({
  poleRadiusM: 0.04,
  destination: Object.freeze<FlagSize>({ poleHeightM: 2.2, clothWidthM: 0.7, clothHeightM: 0.45 }),
  goal: Object.freeze<FlagSize>({ poleHeightM: 1.5, clothWidthM: 0.45, clothHeightM: 0.3 }),
})

/** How far a flag's cloth turns off square to its viewer, so no side sees it edge-on. */
export const FLAG_CANT_RAD = (25 * Math.PI) / 180

/**
 * The direction a flag's cloth extends from its pole at `at`, radians counter-clockwise from
 * world +x: square to the line from `from`, then turned by {@link FLAG_CANT_RAD} so its tip
 * leans toward it. Seen from where it stands, it faces south.
 */
export function flagYaw(at: Planar, from: Planar): number {
  const dx = from.x - at.x
  const dy = from.y - at.y
  const toViewer = dx === 0 && dy === 0 ? -Math.PI / 2 : Math.atan2(dy, dx)
  return toViewer + Math.PI / 2 - FLAG_CANT_RAD
}

/** How far back along the route the destination flag faces: the stretch the camera follows in on. */
export const FLAG_APPROACH_M = 10

/** The point `backM` back along `route` from its end; its start if the route is shorter. */
export function routeApproach(route: readonly Planar[], backM: number = FLAG_APPROACH_M): Planar {
  let left = backM
  for (let k = route.length - 1; k > 0; k--) {
    const b = route[k]!
    const a = route[k - 1]!
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length >= left) {
      const f = left / length
      return { x: b.x + (a.x - b.x) * f, y: b.y + (a.y - b.y) * f }
    }
    left -= length
  }
  const start = route[0]
  return start ? { x: start.x, y: start.y } : { x: 0, y: 0 }
}

/**
 * Distance from a route's end within which a stop is the one its arrival left: the rover's end
 * pose, where the stop stands, can sit off the route's end by the slip on the way.
 */
export const ARRIVAL_RADIUS_M = 2

/**
 * Where the drive is headed: the route's last point, or none without a route or once a stop
 * stands there (the rover arrived and the stop replaces the flag).
 */
export function routeDestination(
  route: readonly Planar[],
  stops: readonly Planar[],
): Planar | null {
  if (route.length < 2) return null
  const end = route.at(-1)!
  if (stops.some((stop) => Math.hypot(stop.x - end.x, stop.y - end.y) <= ARRIVAL_RADIUS_M)) {
    return null
  }
  return { x: end.x, y: end.y }
}
