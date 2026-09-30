import type { KeyframeBlock } from '../../drive/keyframes'
import { frameOdometry, SLIP_WINDOW_M } from '../../drive/odometry'
import type { SliceTotals } from '../../drive/slices'
import type { ResolvedRoverGeometry } from '../../rover/geometry'
import { DEFAULT_ROVER_GEOMETRY } from '../../rover/geometry'
import { ROVER_MAX_SPEED_MPS } from '../../rover/speed'

/** Distances driven by sim time `t`, metres. */
export interface OdometerReading {
  /** Ground distance covered. */
  actualM: number
  /** Distance the wheels turned through: what was commanded, slip included. */
  commandedM: number
}

export interface Odometer {
  /** The reading at sim time `t`, clamped to the frames. */
  at(t: number): OdometerReading
  /**
   * The reading where the ground distance first reached `metres`, interpolated from the frame
   * before; the first reading below it and the last above.
   */
  atDistance(metres: number): OdometerReading
}

/**
 * Odometry of a keyframe block (see `frameOdometry`) as readings over sim time. A block from
 * mid-drive continues `totals`, the drive's at its first frame, and reads back through their
 * slip trail before it; without them the block starts the drive. Commanded distance is the
 * middle-wheel rotation times the radius.
 */
export function createOdometer(
  keyframes: KeyframeBlock,
  totals?: Pick<SliceTotals, 'groundM' | 'wheelRad' | 'slipTrail'>,
  geometry: ResolvedRoverGeometry = DEFAULT_ROVER_GEOMETRY,
): Odometer {
  const { data, count, stride } = keyframes
  const r = geometry.wheelRadius
  const from = totals ?? { groundM: 0, wheelRad: 0, slipTrail: [] }
  const { groundM, wheelRad } = frameOdometry(keyframes, from)
  // The trail, then the frames: ground and wheel rotation by distance.
  const trail = from.slipTrail
  const n = trail.length + count
  const ground = new Float64Array(n)
  const wheel = new Float64Array(n)
  trail.forEach(([g, w], k) => {
    ground[k] = from.groundM - g
    wheel[k] = from.wheelRad - w
  })
  ground.set(groundM, trail.length)
  wheel.set(wheelRad, trail.length)
  const start = { actualM: from.groundM, commandedM: from.wheelRad * r }
  const reading = (k: number, u: number): OdometerReading => ({
    actualM: ground[k]! + (u === 0 ? 0 : (ground[k + 1]! - ground[k]!) * u),
    commandedM: (wheel[k]! + (u === 0 ? 0 : (wheel[k + 1]! - wheel[k]!) * u)) * r,
  })
  return {
    at(t) {
      if (count === 0) return start
      // Frames with time ≤ t.
      let lo = 0
      let hi = count
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (data[mid * stride]! <= t) lo = mid + 1
        else hi = mid
      }
      if (lo === 0) return reading(trail.length, 0)
      if (lo === count) return reading(n - 1, 0)
      const k = lo - 1
      const t0 = data[k * stride]!
      const t1 = data[lo * stride]!
      return reading(trail.length + k, (t - t0) / (t1 - t0))
    },
    atDistance(metres) {
      if (n === 0) return start
      if (metres <= ground[0]!) return reading(0, 0)
      if (metres >= ground[n - 1]!) return reading(n - 1, 0)
      // The first entry at or past `metres`, and the one before it.
      let lo = 0
      let hi = n - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (ground[mid]! < metres) lo = mid
        else hi = mid
      }
      const span = ground[hi]! - ground[lo]!
      return reading(lo, span > 0 ? (metres - ground[lo]!) / span : 0)
    },
  }
}

/**
 * AutoNav-style efficiency: effective speed so far (ground distance over elapsed sim time) as a
 * fraction of the commanded cap, `ROVER_MAX_SPEED_MPS` unless given; undefined before any time
 * has passed. Flat ground at the AutoNav rate with no stops reads 0.033 / 0.042 ≈ 79 %.
 */
export function driveEfficiency(options: {
  actualM: number
  elapsedS: number
  maxSpeedMps?: number
}): number | undefined {
  const { actualM, elapsedS, maxSpeedMps = ROVER_MAX_SPEED_MPS } = options
  if (!(elapsedS > 0)) return undefined
  return actualM / elapsedS / maxSpeedMps
}

/** Slip over the last `windowM` of ground covered by `t` (all of it when less was driven). */
export function slipOverLastMetre(
  odometer: Odometer,
  t: number,
  windowM = SLIP_WINDOW_M,
): { actualM: number; commandedM: number; slip: number } {
  const now = odometer.at(t)
  const from = odometer.atDistance(Math.max(0, now.actualM - windowM))
  const actualM = now.actualM - from.actualM
  const commandedM = now.commandedM - from.commandedM
  return { actualM, commandedM, slip: commandedM > 0 ? Math.max(0, 1 - actualM / commandedM) : 0 }
}
