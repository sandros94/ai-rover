import type { KeyframeBlock } from '../drive/keyframes'
import { interpolatePose, KEYFRAME_STRIDE } from '../drive/keyframes'
import type { DriveEvent, DriveOutcome } from '../drive/segment'
import type { SegmentSlice, SliceTotals, StoredSegmentManifest } from '../drive/slices'
import { sliceReleaseAt } from '../drive/slices'
import type { SliceTrace } from '../drive/traces'
import { ClientError } from './errors'
import type { JourneyClient, Released } from './journey'

/**
 * Shortest wait before asking again for a slice the server called not yet released at a time
 * the client's clock has already passed: the two clocks disagree, and polling every frame
 * would flood the server until they agree.
 */
export const NOT_YET_RETRY_FLOOR_MS = 1000

/** Wait after a failed request before the next poll asks again. */
export const ERROR_RETRY_MS = 5000

/** Requests a poll keeps open when none is given: slices and traces alike. */
export const DEFAULT_SLICE_CONCURRENCY = 8

/** Slices `start … end − 1` of a segment. */
export interface SliceWindow {
  start: number
  end: number
}

/** The totals of a window starting at the drive's first slice. */
const DRIVE_START: SliceTotals = Object.freeze({
  groundM: 0,
  wheelRad: 0,
  slipTrail: [],
  status: null,
}) as SliceTotals

export interface SegmentStream {
  readonly manifest: StoredSegmentManifest
  /**
   * The slices held, always contiguous, with every trace from the first slice to the window's
   * end: what every reader below reads. Undefined until the first window is in.
   */
  readonly window: SliceWindow | undefined
  /** Sim seconds the window starts at. */
  readonly loadedFrom: number
  /** Sim seconds the window reaches. */
  readonly loadedUntil: number
  /** The drive's totals at the window's first frame; undefined until the first window is in. */
  readonly totals: SliceTotals | undefined
  /**
   * `t, x, y, z` per point of the traces before the window: the drive's path up to it, a point
   * every few seconds. Empty for a window from the drive's start.
   */
  readonly pathBefore: Float32Array
  /**
   * Loaded, not yet reached: present once the last slice is held, before playback may have got
   * there. Show {@link outcomeAt} instead.
   */
  readonly outcome: DriveOutcome | undefined
  /** The last slice is held; nothing later will be fetched. */
  readonly done: boolean
  /** Epoch milliseconds from which the next poll will fetch forward; undefined once done. */
  readonly nextFetchAt: number | undefined
  /**
   * The keyframe at `simSeconds` interpolated over the window with the shared
   * `interpolatePose`, clamped to its frames; undefined before the first window.
   */
  frameAt(simSeconds: number): Float32Array | undefined
  /**
   * The window's frames with `t ≤ simSeconds` as one block (count 0 before the first window).
   * The same object comes back while the window and that count are unchanged, so a consumer can
   * skip recomputing; treat its data as read-only.
   */
  keyframesUntil(simSeconds: number): KeyframeBlock
  /**
   * The outcome once playback has reached it: the last slice is held and `simSeconds` is at or
   * past the record's end (`outcome.durationS`); undefined before either.
   */
  outcomeAt(simSeconds: number): DriveOutcome | undefined
  /** The window's events up to and including `simSeconds`. */
  eventsUntil(simSeconds: number): DriveEvent[]
  /** Reveal groups from the drive's start up to and including `simSeconds`, within the window's end. */
  revealsUntil(simSeconds: number): SliceTrace['reveals']
  /**
   * Fetches what showing `simSeconds` at `wallMs` needs. The first window opens at the slice
   * holding `simSeconds`, with every trace before it; later polls extend it forward to every
   * slice released at `wallMs` (with a known `endsAt`, none released after it) and backward to
   * the slice holding `simSeconds` when that lies before it. Nothing is fetched before its
   * release time, nor twice. Overlapping calls share one pass. Rejects with the client's error,
   * or NOT_FOUND when a released slice or trace is missing, or none up to `endsAt` held the
   * outcome; either way the next attempt waits {@link ERROR_RETRY_MS}.
   */
  poll(wallMs: number, simSeconds: number): Promise<void>
}

/**
 * The slices of one published segment, opened where playback stands and fetched as they are
 * released, up to `concurrency` requests at a time. Only the last slice says it is the last, so a
 * drive whose end is public (a settled one) passes `endsAt`, the release of its last slice, and
 * no request goes past it.
 *
 * Segments published before manifest version 3 have no totals and no traces: their window always
 * opens at the first slice, which the totals would otherwise stand in for, and their reveals come
 * inside the slices.
 */
export function createSegmentStream(options: {
  client: JourneyClient
  manifest: StoredSegmentManifest
  concurrency?: number
  /** Epoch milliseconds the drive ended, once public; undefined while it plays. */
  endsAt?: number
}): SegmentStream {
  const { client, manifest, concurrency = DEFAULT_SLICE_CONCURRENCY } = options
  const endsAt = options.endsAt ?? Infinity
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new ClientError(
      'INVALID_INPUT',
      `Slice concurrency is ${concurrency}; pass a positive integer.`,
    )
  }
  const { segmentId, startedAt, sliceSeconds, keyframeHz } = manifest
  const traced = manifest.version >= 3
  const releaseAt = (k: number) => sliceReleaseAt(startedAt, k, sliceSeconds)

  /** Fetched, not yet in the window. */
  const fetchedSlices = new Map<number, SegmentSlice>()
  const fetchedTraces = new Map<number, SliceTrace>()
  /** Traces 0 … traces.length − 1, within the window's end. */
  const traces: SliceTrace[] = []
  let window: SliceWindow | undefined
  /** The window's slices, in order. */
  let held: SegmentSlice[] = []
  let frames = new Float32Array(0)
  let frameCount = 0
  let events: DriveEvent[] = []
  const reveals: SliceTrace['reveals'] = []
  let outcome: DriveOutcome | undefined
  /** The slice the first window opens at, fixed by the first poll that can open it. */
  let opening: number | undefined
  /** Bumped when the window grows backward, which shifts every held frame. */
  let generation = 0
  /** Set by a not-yet answer or a failure; otherwise each slice's own release time applies. */
  let retryAt: number | undefined
  let pending: Promise<void> | undefined

  const sliceAt = (simSeconds: number) => Math.floor(Math.max(0, simSeconds) / sliceSeconds)

  /** Slices released at `wallMs`, and never past `endsAt`. */
  function releasedCount(wallMs: number): number {
    const until = Math.min(wallMs, endsAt)
    let count = Math.max(0, Math.floor((until - startedAt) / (sliceSeconds * 1000)))
    // The estimate can be off by one in floating point; the release times decide.
    while (count > 0 && releaseAt(count - 1) > until) count--
    while (releaseAt(count) <= until) count++
    return count
  }

  function append(slice: SegmentSlice): void {
    const added = slice.keyframes.length
    if (frameCount * KEYFRAME_STRIDE + added > frames.length) {
      const grown = new Float32Array(
        Math.max(frames.length * 2, frameCount * KEYFRAME_STRIDE + added),
      )
      grown.set(frames.subarray(0, frameCount * KEYFRAME_STRIDE))
      frames = grown
    }
    frames.set(slice.keyframes, frameCount * KEYFRAME_STRIDE)
    frameCount += added / KEYFRAME_STRIDE
    events.push(...slice.events)
    held.push(slice)
    if (slice.outcome) outcome = slice.outcome
  }

  function prepend(slices: SegmentSlice[]): void {
    held = [...slices, ...held]
    const data = new Float32Array(held.reduce((n, s) => n + s.keyframes.length, 0))
    let offset = 0
    for (const slice of held) {
      data.set(slice.keyframes, offset)
      offset += slice.keyframes.length
    }
    frames = data
    frameCount = data.length / KEYFRAME_STRIDE
    events = held.flatMap((slice) => slice.events)
    generation++
  }

  /** Moves traces up to `end` into the window's reach, in order. */
  function takeTraces(end: number): void {
    while (traces.length < end) {
      const trace = fetchedTraces.get(traces.length)!
      fetchedTraces.delete(trace.index)
      traces.push(trace)
      reveals.push(...trace.reveals)
    }
  }

  const tracesReady = (end: number) => {
    for (let k = traces.length; k < end; k++) if (!fetchedTraces.has(k)) return false
    return true
  }

  function take(k: number): SegmentSlice {
    const slice = fetchedSlices.get(k)!
    fetchedSlices.delete(k)
    if (traced && !slice.totals) {
      throw new ClientError(
        'DECODE',
        `Slice ${k} of segment ${segmentId} carries no totals, which its manifest version ${manifest.version} promises; the store is inconsistent.`,
      )
    }
    return slice
  }

  /** Moves whatever joins the window, keeping it contiguous. */
  function commit(): void {
    if (!window) {
      if (opening === undefined || !fetchedSlices.has(opening)) return
      if (traced && !tracesReady(opening + 1)) return
      window = { start: opening, end: opening }
      extend()
    }
    const before: SegmentSlice[] = []
    while (fetchedSlices.has(window.start - 1)) before.unshift(take(--window.start))
    if (before.length > 0) prepend(before)
    while (!outcome && fetchedSlices.has(window.end) && (!traced || tracesReady(window.end + 1))) {
      extend()
    }
  }

  /** Appends the slice at the window's end, with its trace or, untraced, its inline reveals. */
  function extend(): void {
    const slice = take(window!.end)
    if (traced) takeTraces(window!.end + 1)
    else reveals.push(...(slice.reveals ?? []))
    append(slice)
    window!.end++
  }

  /** What the pass still needs at `wallMs` for `simSeconds`, the most urgent first. */
  function wanted(wallMs: number, simSeconds: number): { kind: 'slice' | 'trace'; k: number }[] {
    const released = releasedCount(wallMs)
    const out: { kind: 'slice' | 'trace'; k: number }[] = []
    const slice = (k: number) => {
      if (!fetchedSlices.has(k)) out.push({ kind: 'slice', k })
    }
    const trace = (k: number) => {
      if (traced && k >= traces.length && !fetchedTraces.has(k)) out.push({ kind: 'trace', k })
    }
    if (!window) {
      if (released === 0) return out
      opening ??= traced ? Math.min(sliceAt(simSeconds), released - 1) : 0
      slice(opening)
      for (let k = 0; k <= opening; k++) trace(k)
      return out
    }
    // A window without frames shows nothing: it reaches back to the frames before it.
    const back = Math.min(sliceAt(simSeconds), frameCount === 0 ? window.start - 1 : Infinity)
    for (let k = window.start - 1; k >= back && k >= 0; k--) slice(k)
    for (let k = window.end; !outcome && k < released; k++) {
      slice(k)
      trace(k)
    }
    return out
  }

  function forwardDue(): number | undefined {
    if (outcome) return undefined
    return retryAt ?? releaseAt(window?.end ?? opening ?? 0)
  }

  async function pass(wallMs: number, simSeconds: number): Promise<void> {
    for (;;) {
      if (retryAt !== undefined) {
        if (wallMs < retryAt) return
        retryAt = undefined
      }
      if (window && !outcome && wallMs >= releaseAt(window.end) && releaseAt(window.end) > endsAt) {
        retryAt = wallMs + ERROR_RETRY_MS
        throw new ClientError(
          'NOT_FOUND',
          `Segment ${segmentId} ended with slice ${window.end - 1}, which held no outcome; the store is inconsistent.`,
        )
      }
      const batch = wanted(wallMs, simSeconds).slice(0, concurrency)
      if (batch.length === 0) return
      const settled = await Promise.allSettled(
        batch.map(({ kind, k }): Promise<Released<SegmentSlice | SliceTrace>> =>
          kind === 'slice' ? client.getSlice(segmentId, k) : client.getTrace(segmentId, k),
        ),
      )
      // What arrived is kept; only what failed is asked again.
      let stop: unknown
      let waitFor: number | undefined
      for (const [n, attempt] of settled.entries()) {
        const { kind, k } = batch[n]!
        if (attempt.status === 'rejected') {
          stop ??= attempt.reason
          continue
        }
        const result = attempt.value
        if (result.status === 'missing') {
          stop ??= new ClientError(
            'NOT_FOUND',
            `The ${kind} of slice ${k} of segment ${segmentId} is released but missing, and no earlier slice held the outcome.`,
          )
        } else if (result.status === 'not-yet') {
          waitFor = Math.max(waitFor ?? 0, result.releaseAt, wallMs + NOT_YET_RETRY_FLOOR_MS)
        } else if (kind === 'slice') fetchedSlices.set(k, result.value as SegmentSlice)
        else fetchedTraces.set(k, result.value as SliceTrace)
      }
      try {
        commit()
      } catch (error) {
        stop ??= error
      }
      if (stop !== undefined) {
        retryAt = wallMs + ERROR_RETRY_MS
        throw stop
      }
      if (waitFor !== undefined) {
        retryAt = waitFor
        return
      }
    }
  }

  const block = (count: number): KeyframeBlock => ({
    hz: keyframeHz,
    stride: KEYFRAME_STRIDE,
    count,
    data: frames.subarray(0, count * KEYFRAME_STRIDE),
  })

  let reached: { block: KeyframeBlock; generation: number } | undefined

  function keyframesUntil(simSeconds: number): KeyframeBlock {
    let lo = 0
    let hi = frameCount
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (frames[mid * KEYFRAME_STRIDE]! <= simSeconds) lo = mid + 1
      else hi = mid
    }
    // A buffer grown forward keeps the same leading frames, so a cached view stays correct.
    if (reached?.block.count !== lo || reached.generation !== generation) {
      reached = { block: block(lo), generation }
    }
    return reached.block
  }

  /** Items with `t ≤ simSeconds`, the list being ordered by `t`. */
  function until<T extends { t: number }>(list: T[], simSeconds: number): T[] {
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid]!.t <= simSeconds) lo = mid + 1
      else hi = mid
    }
    return list.slice(0, lo)
  }

  let path: { start: number; points: Float32Array } | undefined

  return {
    manifest,
    get window() {
      return window && { ...window }
    },
    get loadedFrom() {
      return (window?.start ?? 0) * sliceSeconds
    },
    get loadedUntil() {
      return (window?.end ?? 0) * sliceSeconds
    },
    get totals() {
      // Only a window from the first slice can lack them: see the untraced segments above.
      return window && (held[0]!.totals ?? DRIVE_START)
    },
    get pathBefore() {
      const start = window?.start ?? 0
      if (path?.start !== start) {
        const before = traces.slice(0, start)
        const points = new Float32Array(before.reduce((n, t) => n + t.path.length, 0))
        let offset = 0
        for (const trace of before) {
          points.set(trace.path, offset)
          offset += trace.path.length
        }
        path = { start, points }
      }
      return path.points
    },
    get outcome() {
      return outcome
    },
    get done() {
      return outcome !== undefined
    },
    get nextFetchAt() {
      return forwardDue()
    },
    frameAt(simSeconds) {
      return frameCount === 0 ? undefined : interpolatePose(block(frameCount), simSeconds)
    },
    keyframesUntil,
    outcomeAt: (simSeconds) => (outcome && simSeconds >= outcome.durationS ? outcome : undefined),
    eventsUntil: (simSeconds) => until(events, simSeconds),
    revealsUntil: (simSeconds) => until(reveals, simSeconds),
    poll(wallMs, simSeconds) {
      if (Number.isNaN(simSeconds)) {
        throw new ClientError(
          'INVALID_INPUT',
          `poll: the playback time is not a number; pass sim seconds.`,
        )
      }
      pending ??= pass(wallMs, simSeconds).finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}
