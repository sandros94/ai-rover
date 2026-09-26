import type { MaybeRefOrGetter } from 'vue'
import type {
  DriveEvent,
  DriveOutcome,
  SegmentSlice,
  StoredSegmentManifest,
} from '#shared/utils/drive'
import type { PlaybackClock, PlaybackMode, PlaybackRate, SegmentStream } from '#shared/utils/client'
import { createPlaybackClock, createSegmentStream } from '#shared/utils/client'
import { useJourneyClient } from './useJourneyClient'

/**
 * Plays a published segment in the browser: an animation-frame loop ticks the clock, polls for
 * released slices and exposes the interpolated keyframe with the events and reveals so far.
 * `serverOffsetMs` (server minus browser clock, see `useMissionState`) keeps release times on
 * the server's clock.
 */
export function useSegmentPlayback(
  segmentId: string,
  options: { serverOffsetMs?: MaybeRefOrGetter<number> } = {},
) {
  const client = useJourneyClient()
  const manifest = shallowRef<StoredSegmentManifest>()
  const frame = shallowRef<Float32Array>()
  const events = shallowRef<DriveEvent[]>([])
  const reveals = shallowRef<SegmentSlice['reveals']>([])
  const outcome = shallowRef<DriveOutcome>()
  const simTime = ref(0)
  const mode = ref<PlaybackMode>('live')
  const rate = ref<PlaybackRate>(1)
  const error = shallowRef<unknown>(null)

  const now = () => Date.now() + toValue(options.serverOffsetMs ?? 0)
  let clock: PlaybackClock | undefined
  let stream: SegmentStream | undefined
  let handle: number | undefined

  function frameLoop(): void {
    handle = requestAnimationFrame(frameLoop)
    if (!clock || !stream) return
    const wall = now()
    const sim = clock.tick(wall)
    stream.poll(wall).catch((caught: unknown) => {
      error.value = caught
    })
    frame.value = stream.frameAt(sim)
    const nextEvents = stream.eventsUntil(sim)
    if (nextEvents.length !== events.value.length) events.value = nextEvents
    const nextReveals = stream.revealsUntil(sim)
    if (nextReveals.length !== reveals.value.length) reveals.value = nextReveals
    outcome.value = stream.outcome
    simTime.value = sim
    mode.value = clock.mode
  }

  onMounted(async () => {
    try {
      const loaded = await client.getSegmentManifest(segmentId)
      manifest.value = loaded
      clock = createPlaybackClock({
        now,
        startedAt: loaded.startedAt,
        sliceSeconds: loaded.sliceSeconds,
      })
      stream = createSegmentStream({ client, manifest: loaded })
      frameLoop()
    } catch (caught) {
      error.value = caught
    }
  })
  onBeforeUnmount(() => {
    if (handle !== undefined) cancelAnimationFrame(handle)
  })

  return {
    manifest,
    frame,
    events,
    reveals,
    outcome,
    simTime,
    mode,
    rate,
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
    },
  }
}
