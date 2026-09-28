import { ClientError } from './errors'

/**
 * Most the display clock runs fast or slow while it catches up with a new offset, as a fraction
 * of real time. At 2 % the rover's speed changes less than a viewer can see, and a one-second
 * correction still lands within a minute.
 */
export const DISPLAY_SLEW_RATE = 0.02

export interface DisplayClock {
  /** Epoch milliseconds on the server's clock, as shown: never steps back between snaps. */
  now(): number
  /** The offset to show: server clock minus the monotonic source, ms. Reached by slewing. */
  setOffset(offsetMs: number): void
  /** Takes the latest offset at once: for a seek or a new segment, which step anyway. */
  snap(): void
}

/**
 * The clock playback and countdowns show, on a monotonic source such as `performance.now()`.
 * `offsetMs` is shown until the first {@link DisplayClock.setOffset}, which is taken at once;
 * every later one is approached at {@link DISPLAY_SLEW_RATE}, so estimates that jitter from poll
 * to poll never make the shown time jump.
 */
export function createDisplayClock(options: {
  monotonic: () => number
  offsetMs: number
}): DisplayClock {
  const { monotonic } = options
  const finite = (offsetMs: number) => {
    if (!Number.isFinite(offsetMs)) {
      throw new ClientError('INVALID_INPUT', `Display clock offset ${offsetMs} is not finite ms.`)
    }
    return offsetMs
  }
  let shown = finite(options.offsetMs)
  let target = shown
  let settled = false
  let last = monotonic()

  return {
    now() {
      const at = monotonic()
      const budget = Math.max(0, at - last) * DISPLAY_SLEW_RATE
      shown += Math.min(budget, Math.max(-budget, target - shown))
      last = at
      return at + shown
    },
    setOffset(offsetMs) {
      target = finite(offsetMs)
      if (settled) return
      settled = true
      shown = target
    },
    snap() {
      shown = target
    },
  }
}
