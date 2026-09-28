import { ClientError } from './errors'

/**
 * Server minus browser clock, milliseconds, from one answer carrying the server's `now`: the
 * server's clock when it answered, plus the answer's `Age` header (whole seconds it spent in a
 * cache, the CDN's included), against the middle of the browser's round trip. An `Age` that is
 * not a non-negative integer counts as none.
 */
export function serverClockOffset(options: {
  serverNow: string
  age: string | null
  sentAt: number
  receivedAt: number
}): number {
  const { serverNow, age, sentAt, receivedAt } = options
  const cachedMs = age !== null && /^\d+$/.test(age) ? Number(age) * 1000 : 0
  return Date.parse(serverNow) + cachedMs - (sentAt + receivedAt) / 2
}

/** Polls whose offsets {@link createClockOffsetEstimate} keeps. */
export const CLOCK_OFFSET_WINDOW = 8

export interface ClockOffsetEstimate {
  /** Server minus browser clock, milliseconds; null before the first sample. */
  readonly offsetMs: number | null
  /** Adds one poll's {@link serverClockOffset}, dropping the oldest past the window; the estimate. */
  add(sampleMs: number): number
}

/**
 * Server minus browser clock over the last {@link CLOCK_OFFSET_WINDOW} polls: their median.
 * The median rather than the sample with the shortest round trip, because the round trip does not
 * bound the error here: a copy the CDN serves quickly still carries an `Age` truncated to whole
 * seconds, so a fast sample can be up to a second off while a slow one is exact.
 */
export function createClockOffsetEstimate(): ClockOffsetEstimate {
  const samples: number[] = []
  let offsetMs: number | null = null
  return {
    get offsetMs() {
      return offsetMs
    },
    add(sampleMs) {
      if (!Number.isFinite(sampleMs)) {
        throw new ClientError('INVALID_INPUT', `Clock offset ${sampleMs} is not finite ms.`)
      }
      samples.push(sampleMs)
      if (samples.length > CLOCK_OFFSET_WINDOW) samples.shift()
      const sorted = samples.toSorted((a, b) => a - b)
      const middle = sorted.length >> 1
      offsetMs = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
      return offsetMs
    },
  }
}
