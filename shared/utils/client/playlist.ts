import { ClientError } from './errors'
import type { PlaybackRate } from './playback'
import { PLAYBACK_RATES } from './playback'

/** Share of a segment played before the next one's data is fetched. */
export const PLAYLIST_PREFETCH_AT = 0.8

/**
 * Consecutive settled segments played back to back, their idle time between drives left out:
 * playlist time runs from 0 to the sum of their durations, and each segment owns the half-open
 * span from its start to the next one's, the last one closed at the end. A segment of no
 * duration owns nothing and is passed over.
 */
export interface Playlist<T extends { durationS: number }> {
  readonly segments: readonly T[]
  /** Playlist seconds: the sum of the segments' durations. */
  readonly duration: number
  /** Playlist time at which each segment starts. */
  readonly starts: readonly number[]
  /** The segment playing at playlist time `time`, clamped to the playlist, and its sim time. */
  locate(time: number): { segmentIndex: number; simTime: number }
  /** Playlist time of sim time `simTime` of a segment, clamped to that segment. */
  timeOf(segmentIndex: number, simTime: number): number
  /**
   * How far playback may run from segment `segmentIndex`, in playlist time: through what
   * `held(k)` says segment k holds (sim seconds), on into the next segment while one is held
   * whole.
   */
  heldUntil(segmentIndex: number, held: (segmentIndex: number) => number): number
  /** The segment to fetch ahead at `time`: the next one once the current is {@link PLAYLIST_PREFETCH_AT} through. */
  prefetchIndex(time: number, fraction?: number): number | undefined
}

export function createPlaylist<T extends { durationS: number }>(
  segments: readonly T[],
): Playlist<T> {
  if (segments.length === 0) {
    throw new ClientError('INVALID_INPUT', 'A playlist needs at least one segment.')
  }
  const starts: number[] = []
  let duration = 0
  for (const [k, { durationS }] of segments.entries()) {
    if (!Number.isFinite(durationS) || durationS < 0) {
      throw new ClientError(
        'INVALID_INPUT',
        `Segment ${k} of the playlist lasts ${durationS} s; pass a finite, non-negative duration.`,
      )
    }
    starts.push(duration)
    duration += durationS
  }
  const last = segments.length - 1

  function checkIndex(segmentIndex: number): void {
    if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > last) {
      throw new ClientError(
        'INVALID_INPUT',
        `Segment ${segmentIndex} is not in the playlist; pass 0 to ${last}.`,
      )
    }
  }

  function locate(time: number): { segmentIndex: number; simTime: number } {
    if (Number.isNaN(time)) {
      throw new ClientError('INVALID_INPUT', `Playlist time ${time} is not a number of seconds.`)
    }
    const t = Math.min(duration, Math.max(0, time))
    // The last segment starting at or before t, found by bisection.
    let lo = 0
    let hi = last
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= t) lo = mid
      else hi = mid - 1
    }
    return { segmentIndex: lo, simTime: Math.min(t - starts[lo]!, segments[lo]!.durationS) }
  }

  return {
    segments,
    duration,
    starts,
    locate,
    timeOf(segmentIndex, simTime) {
      checkIndex(segmentIndex)
      return (
        starts[segmentIndex]! + Math.min(segments[segmentIndex]!.durationS, Math.max(0, simTime))
      )
    },
    heldUntil(segmentIndex, held) {
      checkIndex(segmentIndex)
      let k = segmentIndex
      for (;;) {
        const own = segments[k]!.durationS
        const reach = Math.min(own, Math.max(0, held(k)))
        if (reach < own || k === last) return starts[k]! + reach
        k++
      }
    },
    prefetchIndex(time, fraction = PLAYLIST_PREFETCH_AT) {
      const { segmentIndex, simTime } = locate(time)
      if (segmentIndex === last) return undefined
      const own = segments[segmentIndex]!.durationS
      return own === 0 || simTime / own >= fraction ? segmentIndex + 1 : undefined
    },
  }
}

export interface PlaylistClock {
  readonly rate: PlaybackRate
  readonly paused: boolean
  /** Playlist time as of the last {@link PlaylistClock.tick}. */
  readonly time: number
  /** The last tick reached the end. */
  readonly ended: boolean
  /** Moves to `time`, clamped to the playlist, keeping any pause. */
  seek(time: number): void
  /** Keeps the time shown at `now()` and continues at `rate`. */
  setRate(rate: PlaybackRate): void
  /** Holds the time shown at `now()`. */
  pause(): void
  /** Continues from the pause; from the start once the end was reached. */
  play(): void
  /**
   * Advances to `wallMs`, never past `heldUntil` (what the streams hold) nor the end. A hold
   * keeps the time where it is and playback continues from there once more arrives; it never
   * moves the time back behind a seek.
   */
  tick(wallMs: number, heldUntil?: number): number
}

/** A replay-only clock over a playlist of `duration` seconds, playing from 0 at 1×. */
export function createPlaylistClock(options: {
  /** Wall-clock, epoch milliseconds; used when seeking, pausing and changing rate. */
  now: () => number
  duration: number
}): PlaylistClock {
  const { now, duration } = options
  if (!Number.isFinite(duration) || duration < 0) {
    throw new ClientError(
      'INVALID_INPUT',
      `Playlist duration is ${duration} s; pass a finite, non-negative number of seconds.`,
    )
  }
  let rate: PlaybackRate = 1
  let paused = false
  let time = 0
  // Playlist time `anchorTime` at wall `anchorWall`, advancing at `rate` unless paused.
  let anchorTime = 0
  let anchorWall = now()

  const clamp = (t: number) => Math.min(duration, Math.max(0, t))
  const at = (wallMs: number) =>
    clamp(anchorTime + (paused ? 0 : ((wallMs - anchorWall) / 1000) * rate))

  function anchor(t: number, wallMs = now()): void {
    anchorTime = clamp(t)
    anchorWall = wallMs
  }

  return {
    get rate() {
      return rate
    },
    get paused() {
      return paused
    },
    get time() {
      return time
    },
    get ended() {
      return time >= duration
    },
    seek(t) {
      if (Number.isNaN(t)) {
        throw new ClientError('INVALID_INPUT', `seek: ${t} is not a playlist time in seconds.`)
      }
      anchor(t)
      time = anchorTime
    },
    setRate(next) {
      if (!PLAYBACK_RATES.includes(next)) {
        throw new ClientError(
          'INVALID_INPUT',
          `Playback rate ${next} is not offered; pass one of ${PLAYBACK_RATES.join(', ')}.`,
        )
      }
      anchor(at(now()))
      rate = next
    },
    pause() {
      anchor(at(now()))
      paused = true
    },
    play() {
      const current = at(now())
      if (!paused && current < duration) return
      anchor(current >= duration ? 0 : current)
      time = anchorTime
      paused = false
    },
    tick(wallMs, heldUntil = Infinity) {
      const wanted = at(wallMs)
      const limit = Math.max(heldUntil, anchorTime)
      if (wanted > limit) {
        // Hold: continue from the edge once more is held, rather than jump ahead.
        anchor(limit, wallMs)
        time = anchorTime
      } else time = wanted
      return time
    },
  }
}
