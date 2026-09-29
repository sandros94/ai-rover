/*
 * Framing the sun's shadow map so that it is drawn again, texel for texel, while nothing it shows
 * has moved: a shadow edge changes only when the ground, the rover or the light does. World x
 * east, y north, z up.
 */

type Vec3 = { x: number; y: number; z: number }

/** Half the side of the shadowed square at the least and at the most, metres. */
export const SHADOW_HALF_MIN_M = 30
export const SHADOW_HALF_MAX_M = 120
/** Each size is this much larger than the one below it. */
export const SHADOW_STEP = 1.25
/**
 * How much nearer the camera must come than a size's own threshold before the square shrinks
 * back to the size below: a camera resting on a threshold would otherwise swap the two, and
 * rescale every shadow edge, as damping settles it.
 */
export const SHADOW_SHRINK_MARGIN = 0.1
/**
 * Angle the sun must turn before the light follows it, radians (0.1°). A turn redraws the whole
 * map over a slightly different texel grid, so every edge shifts by up to a texel: the step makes
 * that happen every 25 s or so at the sol's real pace, not every frame, and 0.1° of shadow
 * direction is not visible between steps.
 */
export const SUN_HOLD_RAD = (0.1 * Math.PI) / 180
/** Step the shadow camera's distance along the light is snapped to, metres. */
export const SHADOW_DEPTH_STEP_M = 1

function halfFor(cameraDistance: number): number {
  const wanted = Math.max(1, (cameraDistance * 1.2) / SHADOW_HALF_MIN_M)
  const steps = Math.ceil(Math.log(wanted) / Math.log(SHADOW_STEP) - 1e-9)
  return Math.min(SHADOW_HALF_MAX_M, SHADOW_HALF_MIN_M * SHADOW_STEP ** steps)
}

/**
 * Half the side of the shadowed square for a camera `cameraDistance` metres from its target: at
 * least {@link SHADOW_HALF_MIN_M}, growing in {@link SHADOW_STEP} steps with the distance so a
 * zoomed-out view keeps its shadows, capped so a texel of a 2048 map stays under 12 cm. From the
 * size `current`, it grows as soon as the camera needs it and shrinks only past
 * {@link SHADOW_SHRINK_MARGIN}.
 */
export function shadowHalf(cameraDistance: number, current?: number): number {
  const needed = halfFor(cameraDistance)
  if (current === undefined || needed >= current) return needed
  const smaller = halfFor(cameraDistance * (1 + SHADOW_SHRINK_MARGIN))
  return smaller < current ? smaller : current
}

/**
 * The light's direction to draw: `held` until `wanted` has turned {@link SUN_HOLD_RAD} or more
 * from it, then `wanted`.
 */
export function heldSunDirection(held: Vec3 | undefined, wanted: Vec3): Vec3 {
  if (!held) return wanted
  const dot =
    (held.x * wanted.x + held.y * wanted.y + held.z * wanted.z) /
    (Math.hypot(held.x, held.y, held.z) * Math.hypot(wanted.x, wanted.y, wanted.z))
  return Math.acos(Math.min(1, dot)) >= SUN_HOLD_RAD ? wanted : held
}

/**
 * The light's axes as three's `Matrix4.lookAt` builds them for a shadow camera looking along
 * `-toSun` with world z up: snapping is only exact in the very basis the map is drawn in.
 */
function lightBasis(toSun: Vec3): { x: Vec3; y: Vec3; z: Vec3 } {
  let z = normalise(toSun)
  let x = { x: -z.y, y: z.x, z: 0 }
  if (Math.hypot(x.x, x.y) === 0) {
    z = normalise({ ...z, x: z.x + 0.0001 })
    x = { x: -z.y, y: z.x, z: 0 }
  }
  x = normalise(x)
  const y = { x: z.y * x.z - z.z * x.y, y: z.z * x.x - z.x * x.z, z: z.x * x.y - z.y * x.x }
  return { x, y, z }
}

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z

/**
 * `point` moved to the nearest whole shadow texel across the light (`texelM` metres) and the
 * nearest {@link SHADOW_DEPTH_STEP_M} along it, in the light's frame for the sun at `toSun`.
 * Centred there, the map's texel grid and depth range stay fixed in the world while the target
 * moves: consecutive maps agree texel for texel instead of re-rasterising every edge a fraction
 * of a texel over.
 */
export function snapShadowCentre(point: Vec3, toSun: Vec3, texelM: number): Vec3 {
  const { x, y, z } = lightBasis(toSun)
  const u = Math.round(dot(point, x) / texelM) * texelM
  const v = Math.round(dot(point, y) / texelM) * texelM
  const w = Math.round(dot(point, z) / SHADOW_DEPTH_STEP_M) * SHADOW_DEPTH_STEP_M
  return {
    x: x.x * u + y.x * v + z.x * w,
    y: x.y * u + y.y * v + z.y * w,
    z: x.z * u + y.z * v + z.z * w,
  }
}
