/** Limits of a scripted move, in the move's own unit (radians, metres) per second. */
export interface MotionLimits {
  /** Peak rate, unit per second. */
  rate: number
  /** Peak acceleration, unit per second². */
  acceleration: number
  /** Peak jerk, unit per second³. */
  jerk: number
}

/** A move from rest to rest over a distance. */
export interface MotionProfile {
  /** Seconds the move takes. */
  durationS: number
  /** How far along the move is `t` seconds in: 0 at and before the start, the distance from the end. */
  positionAt: (t: number) => number
}

/**
 * The jerk-limited S-curve over `distance` (≥ 0): acceleration ramps up at the jerk limit, holds
 * at its peak, ramps down to reach the peak rate, which holds, and the stop mirrors the start, so
 * rate and acceleration are continuous and zero at both ends. A move too short to reach the peak
 * rate (or the peak acceleration) peaks at the highest one it can reach, with no cruise (or no
 * hold). The profile is symmetric in time: played backwards it is the same move the other way.
 */
export function motionProfile(distance: number, limits: MotionLimits): MotionProfile {
  const { rate, acceleration: accel, jerk } = limits
  if (!(distance >= 0) || !(rate > 0) || !(accel > 0) || !(jerk > 0)) {
    throw new RangeError(
      `motionProfile: expected a distance ≥ 0 and positive limits, got ${distance} with ${JSON.stringify(limits)}.`,
    )
  }
  // The rate reached, and the seconds taken to reach it from rest: with the acceleration held at
  // its peak once rate ≥ accel²/jerk, a pure jerk ramp up and down below that.
  const rampS = (v: number) =>
    v >= (accel * accel) / jerk ? v / accel + accel / jerk : 2 * Math.sqrt(v / jerk)
  let peak = rate
  if (peak * rampS(peak) > distance) {
    // Speeding up and slowing down cover `peak × rampS(peak)`: solve for the peak that covers the distance.
    const noHold = Math.cbrt((distance * distance * jerk) / 4)
    peak =
      noHold < (accel * accel) / jerk
        ? noHold
        : (accel / 2) * (Math.sqrt((accel / jerk) ** 2 + (4 * distance) / accel) - accel / jerk)
  }
  const rampT = rampS(peak)
  const peakAccel = Math.min(accel, Math.sqrt(peak * jerk))
  const jerkS = peakAccel / jerk
  const rampD = (peak * rampT) / 2
  const cruiseS = peak > 0 ? Math.max(0, (distance - 2 * rampD) / peak) : 0
  const durationS = 2 * rampT + cruiseS

  /** Position `s` seconds into the ramp from rest, for `s` in [0, rampT / 2]. */
  const rising = (s: number) =>
    s <= jerkS
      ? (jerk * s ** 3) / 6
      : (jerk * jerkS ** 3) / 6 +
        ((jerk * jerkS ** 2) / 2) * (s - jerkS) +
        (peakAccel * (s - jerkS) ** 2) / 2
  /** Position `s` seconds into the ramp from rest, its second half mirroring the first. */
  const ramp = (s: number) =>
    s <= rampT / 2 ? rising(s) : rampD - peak * (rampT - s) + rising(rampT - s)

  return {
    durationS,
    positionAt: (t) => {
      if (!(t > 0)) return 0
      if (t >= durationS) return distance
      if (t < rampT) return ramp(t)
      if (t <= rampT + cruiseS) return rampD + peak * (t - rampT)
      return distance - ramp(durationS - t)
    },
  }
}
