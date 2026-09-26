import { sliceReleaseAt } from '../drive/slices'
import { ClientError } from './errors'

/** Replay speeds on offer, times real time. */
export const PLAYBACK_RATES = [1, 10, 60, 200] as const

/** Closed set: one of {@link PLAYBACK_RATES}. */
export type PlaybackRate = (typeof PLAYBACK_RATES)[number]

/** Closed set. `live` follows wall-clock; `replay` plays from a seek at the chosen rate. */
export type PlaybackMode = 'live' | 'replay'

/**
 * Seconds the live view trails wall-clock beyond one slice: time to fetch a slice once it is
 * released before playback needs its first frame.
 */
export const DEFAULT_LIVE_MARGIN_SECONDS = 5

export interface PlaybackClock {
  readonly mode: PlaybackMode
  /** Applies to replay; live always runs at 1. */
  readonly rate: PlaybackRate
  /** Replay holds its sim time while wall-clock passes; live is never paused. */
  readonly paused: boolean
  /** Sim time as of the last {@link PlaybackClock.tick}. */
  readonly simTime: number
  /** Sim seconds shown at `wallMs` in the current mode, never past the live edge. */
  simTimeAt(wallMs: number): number
  /** The live edge at `wallMs`: elapsed time minus the lag, at least 0. */
  liveTimeAt(wallMs: number): number
  /** Slices whose window has passed at `wallMs`, as the server's slice gate releases them. */
  releasedSliceCount(wallMs: number): number
  /** Epoch milliseconds from which slice `sliceIndex` is served. */
  releaseAt(sliceIndex: number): number
  /** Enters replay at `simSeconds`, clamped to [0, live edge], from `now()`. */
  seek(simSeconds: number): void
  /** Keeps the sim time shown at `now()` and continues at `rate`. */
  setRate(rate: PlaybackRate): void
  /** Holds the sim time shown at `now()`, entering replay there; seeks and rates keep the pause. */
  pause(): void
  /** Continues a paused replay from where it holds, at `rate`. */
  play(): void
  /** Follows the live edge again, ending any pause. */
  goLive(): void
  /** Advances to `wallMs`: records the sim time and rejoins live once replay reaches the edge. */
  tick(wallMs: number): number
}

/**
 * Plays a segment against wall-clock. Live sim time is the time since `startedAt` minus
 * `liveLagSeconds`, which must be at least one slice: slice k is released only when its window
 * has fully passed, so anything less would ask for frames not yet served.
 */
export function createPlaybackClock(options: {
  /** Wall-clock, epoch milliseconds; used when seeking and changing rate. */
  now: () => number
  /** The segment's wall-clock start, epoch milliseconds. */
  startedAt: number
  sliceSeconds: number
  /** Default `sliceSeconds + DEFAULT_LIVE_MARGIN_SECONDS`. */
  liveLagSeconds?: number
}): PlaybackClock {
  const { now, startedAt, sliceSeconds } = options
  if (!Number.isFinite(startedAt)) {
    throw new ClientError('INVALID_INPUT', `startedAt is ${startedAt}; pass epoch milliseconds.`)
  }
  if (!Number.isFinite(sliceSeconds) || sliceSeconds <= 0) {
    throw new ClientError(
      'INVALID_INPUT',
      `Slice length is ${sliceSeconds} s; pass a positive number of seconds.`,
    )
  }
  const lag = options.liveLagSeconds ?? sliceSeconds + DEFAULT_LIVE_MARGIN_SECONDS
  if (!Number.isFinite(lag) || lag < sliceSeconds) {
    throw new ClientError(
      'INVALID_INPUT',
      `Live lag is ${lag} s; pass at least one slice (${sliceSeconds} s).`,
    )
  }

  let mode: PlaybackMode = 'live'
  let rate: PlaybackRate = 1
  let paused = false
  let simTime = 0
  // Replay: sim time `anchorSim` at wall `anchorWall`, advancing at `rate`.
  let anchorSim = 0
  let anchorWall = 0

  const releaseAt = (sliceIndex: number) => sliceReleaseAt(startedAt, sliceIndex, sliceSeconds)

  function releasedSliceCount(wallMs: number): number {
    const sliceMs = sliceSeconds * 1000
    let count = Math.max(0, Math.floor((wallMs - startedAt) / sliceMs))
    // The estimate can be off by one in floating point; the release times decide.
    while (count > 0 && releaseAt(count - 1) > wallMs) count--
    while (releaseAt(count) <= wallMs) count++
    return count
  }

  const liveTimeAt = (wallMs: number) => Math.max(0, (wallMs - startedAt) / 1000 - lag)

  function simTimeAt(wallMs: number): number {
    const live = liveTimeAt(wallMs)
    if (mode === 'live') return live
    const elapsed = paused ? 0 : ((wallMs - anchorWall) / 1000) * rate
    return Math.min(live, Math.max(0, anchorSim + elapsed))
  }

  function anchor(sim: number): void {
    anchorWall = now()
    anchorSim = Math.min(liveTimeAt(anchorWall), Math.max(0, sim))
  }

  return {
    get mode() {
      return mode
    },
    get rate() {
      return rate
    },
    get paused() {
      return paused
    },
    get simTime() {
      return simTime
    },
    simTimeAt,
    liveTimeAt,
    releasedSliceCount,
    releaseAt,
    seek(simSeconds) {
      if (!Number.isFinite(simSeconds)) {
        throw new ClientError('INVALID_INPUT', `seek: ${simSeconds} is not finite seconds.`)
      }
      mode = 'replay'
      anchor(simSeconds)
    },
    setRate(next) {
      if (!PLAYBACK_RATES.includes(next)) {
        throw new ClientError(
          'INVALID_INPUT',
          `Playback rate ${next} is not offered; pass one of ${PLAYBACK_RATES.join(', ')}.`,
        )
      }
      if (mode === 'replay') anchor(simTimeAt(now()))
      rate = next
    },
    pause() {
      anchor(simTimeAt(now()))
      mode = 'replay'
      paused = true
    },
    play() {
      if (!paused) return
      anchor(anchorSim)
      paused = false
    },
    goLive() {
      mode = 'live'
      paused = false
    },
    tick(wallMs) {
      simTime = simTimeAt(wallMs)
      if (mode === 'replay' && !paused && simTime >= liveTimeAt(wallMs)) mode = 'live'
      return simTime
    },
  }
}
