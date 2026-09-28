import type { RevealedMask, StopDisk, World } from '#shared/utils/terrain'
import {
  createRevealedMask,
  defineWorld,
  revealDisk,
  surveyMask,
  traversableMask,
} from '#shared/utils/terrain'
import type { RoverPose } from '#shared/utils/rover'
import type { SegmentRecord } from '#shared/utils/drive'
import { DriveError, KEYFRAME_FIELDS } from '#shared/utils/drive'

/** The DriveError thrown by `fn`, or undefined when it throws nothing or something else. */
export function driveErrorOf(fn: () => unknown): DriveError | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof DriveError) return error
  }
  return undefined
}

/** Index of a keyframe field within its 19-value frame. */
export const F = Object.fromEntries(KEYFRAME_FIELDS.map((name, k) => [name, k])) as Record<
  (typeof KEYFRAME_FIELDS)[number],
  number
>

/** Frame `k` of a keyframe block. */
export function frame(keyframes: SegmentRecord['keyframes'], k: number): Float32Array {
  return keyframes.data.subarray(k * 19, (k + 1) * 19)
}

/** A world with the default config (64 m chunks, 1 m cells, 16° limit) over analytic fields. */
export function syntheticWorld(options: {
  heightAt?: (x: number, y: number) => number
  looseAt?: (x: number, y: number) => number
}): World {
  const { heightAt = () => 0, looseAt = () => 0 } = options
  return { config: defineWorld({ seed: 'synthetic' }).config, heightAt, looseAt }
}

/** Half-width of {@link syntheticDisk} in metres: two 64 m chunks each side of the origin. */
export const HALF = 128

/**
 * A stop disk centred on world (0, 0) over the 4×4 chunks around the origin, heights sampled from
 * the world, traversable from the true slope unless `blocked` says otherwise, and visible from the
 * centre wherever `hidden` is false.
 */
export function syntheticDisk(
  world: World,
  options: {
    radius?: number
    blocked?: (x: number, y: number) => boolean
    hidden?: (x: number, y: number) => boolean
  } = {},
): StopDisk {
  const { radius = 120, blocked = () => false, hidden = () => false } = options
  const size = 2 * HALF + 1
  const heights = new Float32Array(size * size)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) heights[j * size + i] = world.heightAt(i - HALF, j - HALF)
  }
  const grid = { heights, width: size, height: size, cellSize: 1 }
  const traversable = traversableMask(grid, { slopeLimitDeg: world.config.slopeLimitDeg })
  const visible = new Uint8Array(size * size)
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i
      if (blocked(i - HALF, j - HALF)) traversable[k] = 0
      visible[k] = hidden(i - HALF, j - HALF) ? 0 : 1
    }
  }
  const chunks = []
  for (let cy = -2; cy < 2; cy++) for (let cx = -2; cx < 2; cx++) chunks.push({ cx, cy })
  return {
    center: { x: 0, y: 0 },
    radius,
    chunks,
    grid,
    origin: { i: -HALF, j: -HALF },
    traversable,
    inside: surveyMask(
      { grid, origin: { i: -HALF, j: -HALF } },
      { center: { x: 0, y: 0 }, radius },
    ),
    visible,
  }
}

/** The journey mask after the disk's own stop viewshed. */
export function revealedAfterStop(world: World, disk: StopDisk): RevealedMask {
  return revealDisk(createRevealedMask(world), disk)
}

/** Heading (yaw) of a world-from-body quaternion built as `Rz(heading) · Ry(pitch) · Rx(roll)`. */
export function yawOf(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
}

/** A frame's pose fields in `RoverPose` shape, for rebuilding its wheels. */
export function poseOfFrame(f: Float32Array): RoverPose {
  const quaternion = { x: f[F.qx]!, y: f[F.qy]!, z: f[F.qz]!, w: f[F.qw]! }
  return {
    position: { x: f[F.x]!, y: f[F.y]!, z: f[F.z]! },
    headingRad: yawOf(quaternion),
    pitchRad: 0,
    rollRad: 0,
    tiltRad: 0,
    quaternion,
    wheels: [],
    contacts: [],
    rocker: { left: f[F.rockerL]!, right: f[F.rockerR]! },
    bogie: { left: f[F.bogieL]!, right: f[F.bogieR]! },
    differentialRad: f[F.rockerL]!,
    bellyClearanceM: 0,
  }
}
