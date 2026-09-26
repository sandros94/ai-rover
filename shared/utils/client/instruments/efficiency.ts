import { DEFAULT_SPEED_MODEL } from '../../drive/segment'
import type { KeyframeBlock } from '../../drive/keyframes'
import { KEYFRAME_FIELDS } from '../../drive/keyframes'
import type { ResolvedRoverGeometry } from '../../rover/geometry'
import { DEFAULT_ROVER_GEOMETRY } from '../../rover/geometry'

/** Distances driven by sim time `t`, metres. */
export interface OdometerReading {
  /** Ground distance covered. */
  actualM: number
  /** Distance the wheels turned through: what was commanded, slip included. */
  commandedM: number
}

export interface Odometer {
  at(t: number): OdometerReading
  /** The earliest sim time at which `actualM` reached `metres`; 0 below the first frame. */
  timeAtDistance(metres: number): number
}

const X = KEYFRAME_FIELDS.indexOf('x')
const Y = KEYFRAME_FIELDS.indexOf('y')
const ML = KEYFRAME_FIELDS.indexOf('spinML')
const MR = KEYFRAME_FIELDS.indexOf('spinMR')

/**
 * Odometry of a keyframe block. Ground distance sums the planar steps between frames, which are
 * centimetres apart at rover speed. Commanded distance is the mean middle-wheel rotation times the
 * radius: the middle wheels sit on the axle through the turn centre, so a turn in place spins them
 * equal and opposite, and on an arc their mean speed is the body's.
 */
export function createOdometer(
  keyframes: KeyframeBlock,
  geometry: ResolvedRoverGeometry = DEFAULT_ROVER_GEOMETRY,
): Odometer {
  const { data, count, stride, hz } = keyframes
  const actual = new Float64Array(count)
  const commanded = new Float64Array(count)
  const r = geometry.wheelRadius
  const spin0 = count > 0 ? (data[ML]! + data[MR]!) / 2 : 0
  for (let k = 0; k < count; k++) {
    const f = k * stride
    if (k > 0) {
      const p = f - stride
      actual[k] =
        actual[k - 1]! + Math.hypot(data[f + X]! - data[p + X]!, data[f + Y]! - data[p + Y]!)
    }
    commanded[k] = ((data[f + ML]! + data[f + MR]!) / 2 - spin0) * r
  }
  const lerp = (series: Float64Array, t: number): number => {
    if (count === 0) return 0
    const u = Math.max(0, Math.min(count - 1, t * hz))
    const k = Math.min(count - 2, Math.floor(u))
    if (k < 0) return series[0]!
    return series[k]! + (series[k + 1]! - series[k]!) * (u - k)
  }
  return {
    at: (t) => ({ actualM: lerp(actual, t), commandedM: lerp(commanded, t) }),
    timeAtDistance(metres) {
      let lo = 0
      let hi = count - 1
      if (count === 0 || metres <= actual[0]!) return 0
      if (metres >= actual[hi]!) return hi / hz
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (actual[mid]! < metres) lo = mid
        else hi = mid
      }
      const span = actual[hi]! - actual[lo]!
      return (lo + (span > 0 ? (metres - actual[lo]!) / span : 0)) / hz
    },
  }
}

/**
 * AutoNav-style efficiency: effective speed so far (ground distance over elapsed sim time) as a
 * fraction of the commanded drive speed; undefined before any time has passed.
 */
export function driveEfficiency(options: {
  actualM: number
  elapsedS: number
  maxSpeedMps?: number
}): number | undefined {
  const { actualM, elapsedS, maxSpeedMps = DEFAULT_SPEED_MODEL.maxSpeedMps } = options
  if (!(elapsedS > 0)) return undefined
  return actualM / elapsedS / maxSpeedMps
}

/** Slip over the last `windowM` of ground covered by `t` (all of it when less was driven). */
export function slipOverLastMetre(
  odometer: Odometer,
  t: number,
  windowM = 1,
): { actualM: number; commandedM: number; slip: number } {
  const now = odometer.at(t)
  const from = odometer.at(odometer.timeAtDistance(Math.max(0, now.actualM - windowM)))
  const actualM = now.actualM - from.actualM
  const commandedM = now.commandedM - from.commandedM
  return { actualM, commandedM, slip: commandedM > 0 ? Math.max(0, 1 - actualM / commandedM) : 0 }
}
