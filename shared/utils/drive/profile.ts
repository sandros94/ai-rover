/**
 * Limits of a jerk-limited motion, in the motion's own unit (metres for a drive, radians for a
 * turn or a steering joint): the top `rate` per second, the largest `accel`eration per second²
 * and the largest `jerk` per second³. All three positive.
 */
export interface ProfileLimits {
  rate: number
  accel: number
  jerk: number
}

/** A profiled motion at one instant: `position` from its start, its `rate` and `accel`eration. */
export interface ProfileSample {
  position: number
  rate: number
  accel: number
}

/**
 * A rest-to-rest move of `distance` on the seven-segment jerk-limited profile: a ramp up to
 * `peak`, `cruiseS` at it, and the mirrored ramp down. A move too short to reach the top rate
 * peaks lower and has no cruise; one shorter still has no constant-acceleration phase either.
 */
export interface Move {
  distance: number
  peak: number
  /** Seconds of each ramp. */
  rampS: number
  cruiseS: number
  durationS: number
  limits: ProfileLimits
}

/**
 * Seconds a jerk-limited change of rate from `from` to `to` takes, starting and ending with no
 * acceleration: jerk to the acceleration limit, hold it, jerk back to zero; a change too small
 * to reach the limit is two jerk phases alone.
 */
export function rampDurationS(from: number, to: number, limits: ProfileLimits): number {
  const change = Math.abs(to - from)
  const { accel, jerk } = limits
  return change >= (accel * accel) / jerk
    ? change / accel + accel / jerk
    : 2 * Math.sqrt(change / jerk)
}

/** Distance a ramp from `from` to `to` covers: the mean of the two rates over its duration. */
export function rampDistance(from: number, to: number, limits: ProfileLimits): number {
  return ((from + to) / 2) * rampDurationS(from, to, limits)
}

/** The ramp from `from` to `to` at `t` seconds into it, clamped to its span. */
export function rampAt(from: number, to: number, limits: ProfileLimits, t: number): ProfileSample {
  const change = Math.abs(to - from)
  const sign = to >= from ? 1 : -1
  const { accel, jerk } = limits
  const full = change >= (accel * accel) / jerk
  // Jerk phase length, the acceleration it reaches, and the constant-acceleration phase between.
  const jerkS = full ? accel / jerk : Math.sqrt(change / jerk)
  const top = jerk * jerkS
  const holdS = full ? change / accel - accel / jerk : 0
  const total = 2 * jerkS + holdS
  const at = Math.min(Math.max(t, 0), total)

  if (at <= jerkS) {
    return {
      position: from * at + (sign * jerk * at ** 3) / 6,
      rate: from + (sign * jerk * at * at) / 2,
      accel: sign * jerk * at,
    }
  }
  const rate1 = from + (sign * jerk * jerkS * jerkS) / 2
  const position1 = from * jerkS + (sign * jerk * jerkS ** 3) / 6
  if (at <= jerkS + holdS) {
    const s = at - jerkS
    return {
      position: position1 + rate1 * s + (sign * top * s * s) / 2,
      rate: rate1 + sign * top * s,
      accel: sign * top,
    }
  }
  const rate2 = rate1 + sign * top * holdS
  const position2 = position1 + rate1 * holdS + (sign * top * holdS * holdS) / 2
  const s = at - jerkS - holdS
  if (at === total) {
    return { position: rampDistance(from, to, limits), rate: to, accel: 0 }
  }
  return {
    position: position2 + rate2 * s + sign * ((top * s * s) / 2 - (jerk * s ** 3) / 6),
    rate: rate2 + sign * (top * s - (jerk * s * s) / 2),
    accel: sign * (top - jerk * s),
  }
}

/**
 * The highest rate a move already at `from` can ramp to and still come to rest within
 * `distance`: at least `from` when stopping from `from` fits, capped at the top rate; `from`
 * itself when even stopping does not fit.
 */
export function peakRate(from: number, distance: number, limits: ProfileLimits): number {
  const fits = (peak: number): boolean =>
    rampDistance(from, peak, limits) + rampDistance(peak, 0, limits) <= distance
  if (fits(limits.rate)) return limits.rate
  if (!fits(from)) return from
  let lo = from
  let hi = limits.rate
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * The rest-to-rest move of `distance` (≥ 0) under `limits`: the top rate when both ramps fit
 * with room to cruise, else the peak whose two ramps cover the distance exactly.
 */
export function planMove(distance: number, limits: ProfileLimits): Move {
  const { rate, accel, jerk } = limits
  const d = Math.max(0, distance)
  let peak = rate
  if (2 * rampDistance(0, rate, limits) > d) {
    // Two ramps up to `p` cover p · rampDurationS(0, p): solved in closed form on either side of
    // the rate a ramp needs to reach the acceleration limit.
    peak =
      d >= (2 * accel ** 3) / (jerk * jerk)
        ? (-(accel * accel) / jerk +
            Math.sqrt((accel * accel) ** 2 / (jerk * jerk) + 4 * accel * d)) /
          2
        : ((d * Math.sqrt(jerk)) / 2) ** (2 / 3)
  }
  const rampS = peak > 0 ? rampDurationS(0, peak, limits) : 0
  const cruiseS = peak > 0 ? Math.max(0, (d - peak * rampS) / peak) : 0
  return { distance: d, peak, rampS, cruiseS, durationS: 2 * rampS + cruiseS, limits }
}

/** The move at `t` seconds from its start, clamped: at rest at 0 before, at its distance after. */
export function moveAt(move: Move, t: number): ProfileSample {
  const { distance, peak, rampS, cruiseS, durationS, limits } = move
  if (t <= 0 || peak === 0) return { position: 0, rate: 0, accel: 0 }
  if (t >= durationS) return { position: distance, rate: 0, accel: 0 }
  if (t < rampS) return rampAt(0, peak, limits, t)
  const up = rampDistance(0, peak, limits)
  if (t < rampS + cruiseS) return { position: up + peak * (t - rampS), rate: peak, accel: 0 }
  const down = rampAt(peak, 0, limits, t - rampS - cruiseS)
  return {
    position: Math.min(distance, up + peak * cruiseS + down.position),
    rate: down.rate,
    accel: down.accel,
  }
}
