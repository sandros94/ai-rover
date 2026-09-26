import type { KeyframeBlock } from '../drive/keyframes'
import { interpolatePose, KEYFRAME_STRIDE } from '../drive/keyframes'
import type { DriveEvent, DriveOutcome } from '../drive/segment'
import type { SegmentSlice, StoredSegmentManifest } from '../drive/slices'
import { sliceReleaseAt } from '../drive/slices'
import { ClientError } from './errors'
import type { JourneyClient } from './journey'

/**
 * Shortest wait before asking again for a slice the server called not yet released at a time
 * the client's clock has already passed: the two clocks disagree, and polling every frame
 * would flood the server until they agree.
 */
export const NOT_YET_RETRY_FLOOR_MS = 1000

/** Wait after a failed slice request before the next poll asks again. */
export const ERROR_RETRY_MS = 5000

/** Released slice requests a poll keeps open when none is given. */
export const DEFAULT_SLICE_CONCURRENCY = 4

export interface SegmentStream {
  readonly manifest: StoredSegmentManifest
  /** Slices held, always 0 … loadedSlices − 1. */
  readonly loadedSlices: number
  /** Sim seconds the held slices cover. */
  readonly loadedUntil: number
  /**
   * Loaded, not yet reached: present once the last slice is held, before playback may have got
   * there. Show {@link outcomeAt} instead.
   */
  readonly outcome: DriveOutcome | undefined
  /** The last slice is held; nothing more will be fetched. */
  readonly done: boolean
  /** Epoch milliseconds from which the next poll will fetch; undefined once done. */
  readonly nextFetchAt: number | undefined
  /**
   * The keyframe at `simSeconds` interpolated over every held slice with the shared
   * `interpolatePose`, clamped to the held frames; undefined before the first slice.
   */
  frameAt(simSeconds: number): Float32Array | undefined
  /**
   * The held frames with `t ≤ simSeconds` as one block (count 0 before the first slice). The
   * same object comes back while that count is unchanged, so a consumer can skip recomputing;
   * treat its data as read-only.
   */
  keyframesUntil(simSeconds: number): KeyframeBlock
  /**
   * The outcome once playback has reached it: the last slice is held and `simSeconds` is at or
   * past the record's end (`outcome.durationS`); undefined before either.
   */
  outcomeAt(simSeconds: number): DriveOutcome | undefined
  /** Held events up to and including `simSeconds`. */
  eventsUntil(simSeconds: number): DriveEvent[]
  /** Held reveal groups up to and including `simSeconds`. */
  revealsUntil(simSeconds: number): SegmentSlice['reveals']
  /**
   * Fetches, in order, every slice released at `wallMs` and not yet held; nothing before the
   * next release time. Overlapping calls share one pass. Rejects with the client's error, or
   * NOT_FOUND when a released slice is missing before the outcome; either way the next attempt
   * waits {@link ERROR_RETRY_MS}.
   */
  poll(wallMs: number): Promise<void>
}

/** The slices of one published segment, fetched as they are released. */
export function createSegmentStream(options: {
  client: JourneyClient
  manifest: StoredSegmentManifest
  concurrency?: number
}): SegmentStream {
  const { client, manifest, concurrency = DEFAULT_SLICE_CONCURRENCY } = options
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new ClientError(
      'INVALID_INPUT',
      `Slice concurrency is ${concurrency}; pass a positive integer.`,
    )
  }
  const { segmentId, startedAt, sliceSeconds, keyframeHz } = manifest
  const releaseAt = (k: number) => sliceReleaseAt(startedAt, k, sliceSeconds)

  let loaded = 0
  let frames = new Float32Array(0)
  let frameCount = 0
  const events: DriveEvent[] = []
  const reveals: SegmentSlice['reveals'] = []
  let outcome: DriveOutcome | undefined
  /** Set by a not-yet answer; otherwise the next slice's own release time applies. */
  let retryAt: number | undefined
  let pending: Promise<void> | undefined

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
    reveals.push(...slice.reveals)
    if (slice.outcome) outcome = slice.outcome
    loaded++
  }

  const nextFetchAt = () => (outcome ? undefined : (retryAt ?? releaseAt(loaded)))

  async function pass(wallMs: number): Promise<void> {
    while (!outcome) {
      const due = nextFetchAt()!
      if (wallMs < due) return
      const batch: number[] = []
      for (let k = loaded; batch.length < concurrency && releaseAt(k) <= wallMs; k++) batch.push(k)
      // A retry may be due before the clock reaches the slice's own release time.
      if (batch.length === 0) batch.push(loaded)
      retryAt = undefined
      const settled = await Promise.allSettled(batch.map((k) => client.getSlice(segmentId, k)))
      // Slices before a failure are kept; the failed one and those after it are asked again.
      for (const [n, attempt] of settled.entries()) {
        if (attempt.status === 'rejected') {
          retryAt = wallMs + ERROR_RETRY_MS
          throw attempt.reason
        }
        const result = attempt.value
        if (result.status === 'missing') {
          retryAt = wallMs + ERROR_RETRY_MS
          throw new ClientError(
            'NOT_FOUND',
            `Slice ${batch[n]} of segment ${segmentId} is released but missing, and no earlier slice held the outcome.`,
          )
        }
        if (result.status === 'not-yet') {
          retryAt = Math.max(result.releaseAt, wallMs + NOT_YET_RETRY_FLOOR_MS)
          return
        }
        append(result.slice)
        if (outcome) return
      }
    }
  }

  const block = (): KeyframeBlock => ({
    hz: keyframeHz,
    stride: KEYFRAME_STRIDE,
    count: frameCount,
    data: frames.subarray(0, frameCount * KEYFRAME_STRIDE),
  })

  let reached: KeyframeBlock | undefined

  function keyframesUntil(simSeconds: number): KeyframeBlock {
    let lo = 0
    let hi = frameCount
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (frames[mid * KEYFRAME_STRIDE]! <= simSeconds) lo = mid + 1
      else hi = mid
    }
    // A buffer grown since keeps the same leading frames, so a cached view stays correct.
    if (reached?.count !== lo) {
      reached = {
        hz: keyframeHz,
        stride: KEYFRAME_STRIDE,
        count: lo,
        data: frames.subarray(0, lo * KEYFRAME_STRIDE),
      }
    }
    return reached
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

  return {
    manifest,
    get loadedSlices() {
      return loaded
    },
    get loadedUntil() {
      return loaded * sliceSeconds
    },
    get outcome() {
      return outcome
    },
    get done() {
      return outcome !== undefined
    },
    get nextFetchAt() {
      return nextFetchAt()
    },
    frameAt(simSeconds) {
      return frameCount === 0 ? undefined : interpolatePose(block(), simSeconds)
    },
    keyframesUntil,
    outcomeAt: (simSeconds) => (outcome && simSeconds >= outcome.durationS ? outcome : undefined),
    eventsUntil: (simSeconds) => until(events, simSeconds),
    revealsUntil: (simSeconds) => until(reveals, simSeconds),
    poll(wallMs) {
      pending ??= pass(wallMs).finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}
