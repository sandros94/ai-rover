import type { KeyframeBlock } from './keyframes'
import { KEYFRAME_FIELDS } from './keyframes'

/** Ground covered over which slip is measured, metres: the slip gauge's window. */
export const SLIP_WINDOW_M = 1

const X = KEYFRAME_FIELDS.indexOf('x')
const Y = KEYFRAME_FIELDS.indexOf('y')
const ML = KEYFRAME_FIELDS.indexOf('spinML')
const MR = KEYFRAME_FIELDS.indexOf('spinMR')

/** Ground distance and middle-wheel rotation at each frame of a block. */
export interface Odometry {
  /** Metres: `groundM` at the first frame plus the planar steps between frames since. */
  groundM: Float64Array
  /**
   * Radians: `wheelRad` at the first frame plus the change in the mean middle-wheel spin since.
   * The middle wheels sit on the axle through the turn centre, so a turn in place spins them
   * equal and opposite, and on an arc their mean speed is the body's; times the wheel radius,
   * the commanded distance.
   */
  wheelRad: Float64Array
}

/**
 * The odometry of `keyframes`, continuing `from` (the readings at its first frame; zero at a
 * drive's first frame). Ground distance sums the planar steps between frames, which are
 * centimetres apart at rover speed.
 */
export function frameOdometry(
  keyframes: KeyframeBlock,
  from: { groundM: number; wheelRad: number } = { groundM: 0, wheelRad: 0 },
): Odometry {
  const { data, count, stride } = keyframes
  const groundM = new Float64Array(count)
  const wheelRad = new Float64Array(count)
  const spin0 = count > 0 ? middleSpin(data, 0) : 0
  for (let k = 0; k < count; k++) {
    const f = k * stride
    if (k === 0) groundM[k] = from.groundM
    else {
      const p = f - stride
      groundM[k] =
        groundM[k - 1]! + Math.hypot(data[f + X]! - data[p + X]!, data[f + Y]! - data[p + Y]!)
    }
    wheelRad[k] = from.wheelRad + (middleSpin(data, f) - spin0)
  }
  return { groundM, wheelRad }
}

/** Mean spin of the two middle wheels of the frame stored from `offset`, radians. */
function middleSpin(data: Float32Array, offset: number): number {
  return (data[offset + ML]! + data[offset + MR]!) / 2
}
