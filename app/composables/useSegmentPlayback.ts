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

/**
 * Plays a published segment in the browser: an animation-frame loop ticks the clock, polls for
 * what the playback time needs and exposes the interpolated keyframe with the stream's window up
 * to it (keyframes and events from the window's start, the totals there and the path before it)
 * and the reveals since the drive's start, and the outcome only once playback reaches it. The
 * stream opens where the clock does, at live, and reaches back only as far as a seek goes. A new
 * `segmentId` starts over; none stops playback and clears everything.
 * Playback runs on `display` (see `useDisplayClock`), stepped only by a seek or a new segment;
 * slice requests run on the browser's clock plus `serverOffsetMs` (server minus browser clock, see
 * `useMissionState`), the server's release times. `endsAt`, the end of a drive already settled
 * when it is started, keeps the slice requests from going past its last slice.
 */
export function useSegmentPlayback(
  segmentId: MaybeRefOrGetter<string | null | undefined>,
  options: {
    display: DisplayClock
    serverOffsetMs?: MaybeRefOrGetter<number | null>
    endsAt?: MaybeRefOrGetter<string | Date | null | undefined>
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

  function frameLoop(): void {
    handle = requestAnimationFrame(frameLoop)
    if (!clock || !stream) return
    const wall = display.now()
    const sim = clock.tick(wall)
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
    liveTime.value = 0
    heldUntil.value = 0
    mode.value = 'live'
    paused.value = false
    error.value = null
  }

  async function start(id: string): Promise<void> {
    const current = ++generation
    try {
      const loaded = await client.getSegmentManifest(id)
      if (current !== generation) return
      manifest.value = loaded
      display.snap()
      clock = createPlaybackClock({
        now: () => display.now(),
        startedAt: loaded.startedAt,
        sliceSeconds: loaded.sliceSeconds,
      })
      clock.setRate(rate.value)
      const endsAt = toValue(options.endsAt)
      stream = createSegmentStream({
        client,
        manifest: loaded,
        endsAt: endsAt ? new Date(endsAt).getTime() : undefined,
      })
      frameLoop()
    } catch (caught) {
      if (current === generation) error.value = caught
    }
  }

  onMounted(() => {
    watch(
      () => toValue(segmentId),
      (id) => {
        generation++
        stop()
        if (id) void start(id)
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
    liveTime,
    heldUntil,
    mode,
    rate,
    paused,
    error,
    seek(simSeconds: number): void {
      display.snap()
      clock?.seek(simSeconds)
      mode.value = clock?.mode ?? mode.value
    },
    setRate(next: PlaybackRate): void {
      clock?.setRate(next)
      rate.value = next
    },
    goLive(): void {
      clock?.goLive()
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
