import type { MaybeRefOrGetter } from 'vue'
import type {
  DriveEvent,
  DriveOutcome,
  KeyframeBlock,
  SegmentSlice,
  StoredSegmentManifest,
} from '#shared/utils/drive'
import { KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { PlaybackClock, PlaybackMode, PlaybackRate, SegmentStream } from '#shared/utils/client'
import { createPlaybackClock, createSegmentStream } from '#shared/utils/client'
import { useJourneyClient } from './useJourneyClient'

/**
 * Plays a published segment in the browser: an animation-frame loop ticks the clock, polls for
 * released slices and exposes the interpolated keyframe with the keyframes, events and reveals
 * so far, and the outcome only once playback reaches it. A new `segmentId` starts over; none
 * stops playback and clears everything.
 * `serverOffsetMs` (server minus browser clock, see `useMissionState`) keeps release times on
 * the server's clock. `endsAt`, the end of a drive already settled when it is started, keeps the
 * slice requests from going past its last slice.
 */
export function useSegmentPlayback(
  segmentId: MaybeRefOrGetter<string | null | undefined>,
  options: {
    serverOffsetMs?: MaybeRefOrGetter<number>
    endsAt?: MaybeRefOrGetter<string | Date | null | undefined>
  } = {},
) {
  const client = useJourneyClient()
  const manifest = shallowRef<StoredSegmentManifest>()
  const frame = shallowRef<Float32Array>()
  const keyframes = shallowRef<KeyframeBlock>()
  const events = shallowRef<DriveEvent[]>([])
  const reveals = shallowRef<SegmentSlice['reveals']>([])
  /** Every reveal group held, reached or not: what the whole drive will have revealed so far. */
  const heldReveals = shallowRef<SegmentSlice['reveals']>([])
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

  const now = () => Date.now() + toValue(options.serverOffsetMs ?? 0)
  let clock: PlaybackClock | undefined
  let stream: SegmentStream | undefined
  let handle: number | undefined
  /** Bumped per segment, so a manifest arriving after a switch is dropped. */
  let generation = 0

  function frameLoop(): void {
    handle = requestAnimationFrame(frameLoop)
    if (!clock || !stream) return
    const wall = now()
    const sim = clock.tick(wall)
    stream.poll(wall).catch((caught: unknown) => {
      error.value = caught
    })
    frame.value = stream.frameAt(sim)
    keyframes.value = stream.keyframesUntil(sim)
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
      clock = createPlaybackClock({
        now,
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
