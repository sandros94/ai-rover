import type {
  DriveEvent,
  DriveOutcome,
  KeyframeBlock,
  SliceTotals,
  SliceTrace,
  StoredSegmentManifest,
} from '#shared/utils/drive'
import { KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { PlaybackMode, PlaybackRate, SegmentStream } from '#shared/utils/client'
import { createPlaylist, createPlaylistClock, createSegmentStream } from '#shared/utils/client'
import { useJourneyClient } from './useJourneyClient'
import { useStopTerrain } from './useStopTerrain'

/** What a playlist needs of each settled segment: its id, start, duration, end and stop left. */
export interface PlaylistSegment {
  id: string
  /** The segment's start, its row's: the clock its slices were released on. */
  startedAt: string | Date
  /** Sim seconds of the whole drive, from the settled drive: the public manifest omits it. */
  durationS: number
  /** When its last slice was released. */
  endedAt: string | Date
  /** The stop left: `manifestKey` names its objects. */
  from: { index: number; manifestKey: string }
}

/**
 * Plays settled segments back to back in the browser over one clock. Each segment's manifest and
 * slices come through its own stream, and its from-stop disk through {@link useStopTerrain}, both
 * loaded when the segment is reached or, for the next one, once the current one is 80 % through,
 * so the disk switches at each stop without a wait. Playback holds where the data held ends and
 * goes on when more arrives.
 *
 * The current segment's frame, window and reveals read like `useSegmentPlayback`'s,
 * so the same track and instruments draw either; `time` and `duration` are the playlist's own.
 * The segment list is fixed for the composable's life: remount for another.
 */
export function useSegmentPlaylist<T extends PlaylistSegment>(
  segments: readonly T[],
  options: { rate?: PlaybackRate } = {},
) {
  const client = useJourneyClient()
  const playlist = createPlaylist(segments)
  const now = () => Date.now()
  const clock = createPlaylistClock({ now, duration: playlist.duration })
  if (options.rate) clock.setRate(options.rate)

  /** Position of the playing segment in the list. */
  const index = ref(0)
  const segment = computed(() => segments[index.value]!)
  /** Playlist seconds played. */
  const time = ref(0)
  const ended = ref(false)

  const manifest = shallowRef<StoredSegmentManifest>()
  const frame = shallowRef<Float32Array>()
  const keyframes = shallowRef<KeyframeBlock>()
  const totals = shallowRef<SliceTotals>()
  const pathBefore = shallowRef<Float32Array>(new Float32Array(0))
  const events = shallowRef<DriveEvent[]>([])
  const reveals = shallowRef<SliceTrace['reveals']>([])
  const heldReveals = shallowRef<SliceTrace['reveals']>([])
  const outcome = shallowRef<DriveOutcome>()
  /** Sim time within the playing segment. */
  const simTime = ref(0)
  /**
   * Sim time within the playing segment that playback last jumped to: the start, a seek's target,
   * the segment entered. What the drive revealed up to it happened before playback got there.
   */
  const jumpedTo = ref(0)
  /** Set by a jump; the next step records where it landed. */
  let jumped = true
  /** A settled segment is released whole: its end. */
  const liveTime = ref(0)
  /** Sim time of the playing segment's last held keyframe. */
  const heldUntil = ref(0)
  const mode = ref<PlaybackMode>('replay')
  const rate = ref<PlaybackRate>(clock.rate)
  const paused = ref(false)
  const error = shallowRef<unknown>(null)

  const terrain = useStopTerrain(() => segment.value.from.manifestKey)
  /** Stops whose disk is loaded, by manifest key, so playback may enter a segment leaving them. */
  const readyStops = new Set<string>()
  watch(terrain.terrain, (disk) => {
    if (disk && terrain.manifestKey.value) readyStops.add(terrain.manifestKey.value)
  })
  const prefetchedStops = new Set<string>()
  function prefetchStop(manifestKey: string): void {
    if (prefetchedStops.has(manifestKey)) return
    prefetchedStops.add(manifestKey)
    terrain
      .prefetch(manifestKey)
      .then(() => readyStops.add(manifestKey))
      .catch(() => prefetchedStops.delete(manifestKey))
  }

  /** Loaded segments by position: the playing one and its neighbours. */
  const entries = new Map<number, { manifest?: StoredSegmentManifest; stream?: SegmentStream }>()
  function ensure(k: number): void {
    if (entries.has(k)) return
    const entry: { manifest?: StoredSegmentManifest; stream?: SegmentStream } = {}
    entries.set(k, entry)
    client
      .getSegmentManifest(segments[k]!.id)
      .then((loaded) => {
        entry.manifest = loaded
        entry.stream = createSegmentStream({
          client,
          manifest: loaded,
          startedAt: new Date(segments[k]!.startedAt).getTime(),
          endsAt: new Date(segments[k]!.endedAt).getTime(),
        })
      })
      .catch((caught: unknown) => {
        if (entries.get(k) === entry) entries.delete(k)
        error.value = caught
      })
  }

  /** Sim seconds segment `k` holds, 0 until its from-stop disk is in. */
  function held(k: number): number {
    const stream = entries.get(k)?.stream
    if (!stream || !readyStops.has(segments[k]!.from.manifestKey)) return 0
    return stream.done ? Infinity : stream.loadedUntil
  }

  const listeners = new Set<(to: number, from: number) => void>()
  /** Calls `listener` with the new and the old position each time playback enters another segment. */
  function onTransition(listener: (to: number, from: number) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** The position whose refs were last written, so a switch clears them. */
  let shown = -1

  function step(): void {
    const wall = now()
    const from = playlist.locate(clock.time).segmentIndex
    const t = clock.tick(wall, playlist.heldUntil(from, held))
    const { segmentIndex: k, simTime: sim } = playlist.locate(t)

    ensure(k)
    prefetchStop(segments[k]!.from.manifestKey)
    const ahead = playlist.prefetchIndex(t)
    if (ahead !== undefined) {
      ensure(ahead)
      prefetchStop(segments[ahead]!.from.manifestKey)
    }
    for (const key of entries.keys()) if (Math.abs(key - k) > 1) entries.delete(key)
    // The playing segment opens where playback stands; its neighbours are entered at their start.
    for (const [key, { stream }] of entries) {
      stream?.poll(wall, key === k ? sim : 0).catch((caught: unknown) => {
        error.value = caught
      })
    }

    // Before the reveals, which the fog reads against it.
    if (jumped || k !== shown) {
      jumpedTo.value = sim
      jumped = false
    }
    if (k !== shown) {
      const before = shown
      shown = k
      index.value = k
      events.value = []
      reveals.value = []
      heldReveals.value = []
      if (before !== -1) for (const listener of listeners) listener(k, before)
    }
    const entry = entries.get(k)!
    const stream = entry.stream
    manifest.value = entry.manifest
    frame.value = stream?.frameAt(sim)
    keyframes.value = stream?.keyframesUntil(sim)
    totals.value = stream?.totals
    pathBefore.value = stream?.pathBefore ?? new Float32Array(0)
    if (stream) {
      const nextEvents = stream.eventsUntil(sim)
      if (nextEvents.length !== events.value.length) events.value = nextEvents
      const nextReveals = stream.revealsUntil(sim)
      if (nextReveals.length !== reveals.value.length) reveals.value = nextReveals
      const all = stream.revealsUntil(Infinity)
      if (all.length !== heldReveals.value.length) heldReveals.value = all
      const frames = stream.keyframesUntil(Infinity)
      heldUntil.value = frames.count ? frames.data[(frames.count - 1) * KEYFRAME_STRIDE]! : 0
    } else heldUntil.value = 0
    outcome.value = stream?.outcomeAt(sim)
    liveTime.value = segments[k]!.durationS
    simTime.value = sim
    time.value = t
    ended.value = clock.ended
    paused.value = clock.paused
  }

  let handle: number | undefined
  function frameLoop(): void {
    handle = requestAnimationFrame(frameLoop)
    step()
  }

  onMounted(frameLoop)
  onBeforeUnmount(() => {
    if (handle !== undefined) cancelAnimationFrame(handle)
    handle = undefined
  })

  function seek(playlistSeconds: number): void {
    clock.seek(playlistSeconds)
    jumped = true
    step()
  }

  /** Starts segment `k` of the list, clamped to it. */
  function goTo(k: number): void {
    seek(playlist.starts[Math.min(segments.length - 1, Math.max(0, k))]!)
  }

  return {
    playlist,
    index,
    segment,
    time,
    duration: playlist.duration,
    ended,
    terrain,
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
    onTransition,
    seek,
    goTo,
    /** Starts the next segment; nothing after the last. */
    next(): void {
      if (index.value < segments.length - 1) goTo(index.value + 1)
    },
    /** Starts the segment before, or this one again from the first. */
    previous: () => goTo(index.value - 1),
    setRate(next: PlaybackRate): void {
      clock.setRate(next)
      rate.value = next
    },
    /** Pauses, or plays on from the pause; from the start once the end was reached. */
    togglePlay(): void {
      // Played again from the start once the end was reached.
      if (clock.ended) jumped = true
      if (clock.paused || clock.ended) clock.play()
      else clock.pause()
      step()
    },
  }
}
