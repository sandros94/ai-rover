import type { MaybeRefOrGetter } from 'vue'
import type {
  DriveEvent,
  DriveOutcome,
  KeyframeBlock,
  SliceTotals,
  SliceTrace,
  StoredSegmentManifest,
} from '#shared/utils/drive'
import { KEYFRAME_STRIDE } from '#shared/utils/drive'
import type {
  DisplayClock,
  PlaybackClock,
  PlaybackMode,
  PlaybackRate,
  SegmentStream,
} from '#shared/utils/client'
import { createPlaybackClock, createSegmentStream } from '#shared/utils/client'
import { useJourneyClient } from './useJourneyClient'

/** A segment to play, as the mission state names it. */
export interface PlayedSegment {
  id: string
  /** The segment's start: the clock its slices are released and played on. */
  startedAt: string | Date
  /** The release of its last slice, once public. */
  endsAt?: string | Date | null
}

/**
 * Plays a published segment in the browser: an animation-frame loop ticks the clock, polls for
 * what the playback time needs and exposes the interpolated keyframe with the stream's window up
 * to it (keyframes and events from the window's start, the totals there and the path before it)
 * and the reveals since the drive's start, and the outcome only once playback reaches it. The
 * stream opens where the clock does, at live, and reaches back only as far as a seek goes. A
 * segment with a new id starts over; none stops playback and clears everything.
 * Playback runs on `display` (see `useDisplayClock`), stepped only by a seek or a new segment;
 * slice requests run on the browser's clock plus `serverOffsetMs` (server minus browser clock, see
 * `useMissionState`), the server's release times, both from the segment's `startedAt`. `endsAt`,
 * the end of a drive already settled when it is started, keeps the slice requests from going past
 * its last slice.
 */
export function useSegmentPlayback(
  segment: MaybeRefOrGetter<PlayedSegment | null | undefined>,
  options: {
    display: DisplayClock
    serverOffsetMs?: MaybeRefOrGetter<number | null>
  },
) {
  const client = useJourneyClient()
  const manifest = shallowRef<StoredSegmentManifest>()
  const frame = shallowRef<Float32Array>()
  const keyframes = shallowRef<KeyframeBlock>()
  /** The drive's totals at the keyframes' first. */
  const totals = shallowRef<SliceTotals>()
  /** The drive's path before the keyframes' first: `t, x, y, z` per point. */
  const pathBefore = shallowRef<Float32Array>(new Float32Array(0))
  const events = shallowRef<DriveEvent[]>([])
  const reveals = shallowRef<SliceTrace['reveals']>([])
  /** Every reveal group held, reached or not: what the whole drive will have revealed so far. */
  const heldReveals = shallowRef<SliceTrace['reveals']>([])
  const outcome = shallowRef<DriveOutcome>()
  const simTime = ref(0)
  /**
   * Sim time playback last jumped to: where it opened, a seek's target, the live edge it went back
   * to. What the drive revealed up to it happened before playback got there.
   */
  const jumpedTo = ref(0)
  /** The live edge: the latest sim time playback may show. */
  const liveTime = ref(0)
  /** Sim time of the last held keyframe; seeking past it shows nothing new. */
  const heldUntil = ref(0)
  const mode = ref<PlaybackMode>('live')
  const rate = ref<PlaybackRate>(1)
  const paused = ref(false)
  const error = shallowRef<unknown>(null)

  const { display } = options
  const serverNow = () => Date.now() + (toValue(options.serverOffsetMs) ?? 0)
  let clock: PlaybackClock | undefined
  let stream: SegmentStream | undefined
  let handle: number | undefined
  /** Bumped per segment, so a manifest arriving after a switch is dropped. */
  let generation = 0
  /** Set by a jump; the next frame records where it landed. */
  let jumped = false

  function frameLoop(): void {
    handle = requestAnimationFrame(frameLoop)
    if (!clock || !stream) return
    const wall = display.now()
    const sim = clock.tick(wall)
    // Before the reveals, which the fog reads against it.
    if (jumped) {
      jumpedTo.value = sim
      jumped = false
    }
    stream.poll(serverNow(), sim).catch((caught: unknown) => {
      error.value = caught
    })
    frame.value = stream.frameAt(sim)
    keyframes.value = stream.keyframesUntil(sim)
    totals.value = stream.totals
    pathBefore.value = stream.pathBefore
    const nextEvents = stream.eventsUntil(sim)
    if (nextEvents.length !== events.value.length) events.value = nextEvents
    const nextReveals = stream.revealsUntil(sim)
    if (nextReveals.length !== reveals.value.length) reveals.value = nextReveals
    const held = stream.revealsUntil(Infinity)
    if (held.length !== heldReveals.value.length) heldReveals.value = held
    outcome.value = stream.outcomeAt(sim)
    const all = stream.keyframesUntil(Infinity)
    heldUntil.value = all.count ? all.data[(all.count - 1) * KEYFRAME_STRIDE]! : 0
    liveTime.value = clock.liveTimeAt(wall)
    simTime.value = sim
    mode.value = clock.mode
    paused.value = clock.paused
  }

  function stop(): void {
    if (handle !== undefined) cancelAnimationFrame(handle)
    handle = undefined
    clock = undefined
    stream = undefined
    manifest.value = undefined
    frame.value = undefined
    keyframes.value = undefined
    totals.value = undefined
    pathBefore.value = new Float32Array(0)
    events.value = []
    reveals.value = []
    heldReveals.value = []
    outcome.value = undefined
    simTime.value = 0
    jumpedTo.value = 0
    liveTime.value = 0
    heldUntil.value = 0
    mode.value = 'live'
    paused.value = false
    error.value = null
  }

  async function start(played: PlayedSegment): Promise<void> {
    const current = ++generation
    try {
      const startedAt = new Date(played.startedAt).getTime()
      const loaded = await client.getSegmentManifest(played.id)
      if (current !== generation) return
      manifest.value = loaded
      display.snap()
      clock = createPlaybackClock({
        now: () => display.now(),
        startedAt,
        sliceSeconds: loaded.sliceSeconds,
      })
      clock.setRate(rate.value)
      stream = createSegmentStream({
        client,
        manifest: loaded,
        startedAt,
        endsAt: played.endsAt ? new Date(played.endsAt).getTime() : undefined,
      })
      jumped = true
      frameLoop()
    } catch (caught) {
      if (current === generation) error.value = caught
    }
  }

  onMounted(() => {
    watch(
      () => toValue(segment)?.id,
      (id) => {
        generation++
        stop()
        const played = toValue(segment)
        if (id && played) void start(played)
      },
      { immediate: true },
    )
  })
  onBeforeUnmount(() => {
    generation++
    if (handle !== undefined) cancelAnimationFrame(handle)
  })

  return {
    manifest,
    frame,
    keyframes,
    totals,
    pathBefore,
    events,
    reveals,
    heldReveals,
    outcome,
    simTime,
    jumpedTo,
    liveTime,
    heldUntil,
    mode,
    rate,
    paused,
    error,
    seek(simSeconds: number): void {
      display.snap()
      clock?.seek(simSeconds)
      jumped = true
      mode.value = clock?.mode ?? mode.value
    },
    setRate(next: PlaybackRate): void {
      clock?.setRate(next)
      rate.value = next
    },
    goLive(): void {
      clock?.goLive()
      jumped = true
      mode.value = 'live'
      paused.value = false
    },
    /** Pauses playing playback, or plays paused playback on from where it holds. */
    togglePlay(): void {
      if (!clock) return
      if (clock.paused) clock.play()
      else clock.pause()
      mode.value = clock.mode
      paused.value = clock.paused
    },
  }
}
