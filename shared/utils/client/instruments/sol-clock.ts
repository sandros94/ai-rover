import { ClientError } from '../errors'

/** One mean Mars solar day in SI seconds. */
export const MARS_SOL_SECONDS = 88_775.244

/** A moment on the mission's sol clock. */
export interface SolTime {
  /** Whole sols since the epoch; sol 0 is the epoch's own sol. */
  sol: number
  /** Fraction of the current sol elapsed, 0 to below 1. */
  fraction: number
  /** Local mean solar time: the sol divided into 24 hours of 60 minutes of 60 seconds. */
  hours: number
  minutes: number
  seconds: number
}

/**
 * The sol and local mean solar time at `atMs` for a mission whose epoch is `epochMs`, both
 * epoch milliseconds. Convention: the mission epoch is 00:00:00 LMST of sol 0, sols counting from
 * 0 as landed missions number the landing sol; LMST hours are 1/24 of a sol, about 1.0275 Earth
 * hours. The world has no longitude, so there is no true local solar time to anchor on.
 */
export function solTime(epochMs: number, atMs: number): SolTime {
  if (!Number.isFinite(epochMs) || !Number.isFinite(atMs)) {
    throw new ClientError(
      'INVALID_INPUT',
      `solTime: epoch ${epochMs} and instant ${atMs}; pass finite epoch milliseconds.`,
    )
  }
  // LMST seconds since the epoch, rounded to the microsecond so an instant a float ulp short of
  // a boundary reads on it.
  const lmst = Math.round(((atMs - epochMs) / (MARS_SOL_SECONDS * 1000)) * 86_400e6) / 1e6
  const sol = Math.floor(lmst / 86_400)
  const within = lmst - sol * 86_400
  const whole = Math.floor(within)
  return {
    sol,
    fraction: within / 86_400,
    hours: Math.floor(whole / 3600),
    minutes: Math.floor((whole % 3600) / 60),
    seconds: whole % 60,
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `HH:MM:SS` LMST. */
export function formatLmst(time: Pick<SolTime, 'hours' | 'minutes' | 'seconds'>): string {
  return `${pad(time.hours)}:${pad(time.minutes)}:${pad(time.seconds)}`
}

/** `M:SS` below an hour, `H:MM:SS` from one; whole seconds, rounded down, never negative. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}
