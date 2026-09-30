import type { Mission, Segment, Stop } from '../../database/schema'
import type { JourneyStore } from '../journey/store'
import type { SegmentSlice, SliceTrace } from '#shared/utils/drive'
import {
  decodeSlice,
  decodeTrace,
  parseStoredSegmentManifest,
  segmentSliceKey,
  segmentTraceKey,
} from '#shared/utils/drive'
import type { RevealedMask, StopDisk, World } from '#shared/utils/terrain'
import { computeStopDisk, decodeRevealedMask, defineWorld, worldHash } from '#shared/utils/terrain'
import { LifecycleError } from './errors'

/**
 * Worlds and stop disks are pure functions of stored rows, so each process keeps the recent ones.
 * A disk over the default 500 m survey and its margin holds about 1.3 M vertices (≈ 11 MB), hence
 * the small bound.
 */
const WORLD_LIMIT = 8
const DISK_LIMIT = 4

const worlds = new Map<string, World>()
const disks = new Map<string, StopDisk>()

/**
 * The mission's world, `defineWorld({ seed, ...config.world })`. Refuses a world whose hash
 * differs from the stored one: the blobs already published were computed from the stored world,
 * and a changed default would silently disagree with them.
 */
export function missionWorld(
  mission: Pick<Mission, 'id' | 'seed' | 'config' | 'worldHash'>,
): World {
  const cached = worlds.get(mission.id)
  if (cached) return touch(worlds, mission.id, cached)
  const world = defineWorld({ seed: mission.seed, ...mission.config.world })
  const hash = worldHash(world)
  if (hash !== mission.worldHash) {
    throw new LifecycleError(
      'WORLD_MISMATCH',
      `Mission ${mission.id} was created on world ${mission.worldHash} but its seed and config now build world ${hash}; restore the world defaults it was created with.`,
    )
  }
  return remember(worlds, WORLD_LIMIT, mission.id, world)
}

/** The disk of `radius` metres around a stop, centred on its position. */
export function stopDisk(
  world: World,
  stop: Pick<Stop, 'id' | 'x' | 'y'>,
  options: { radius: number },
): StopDisk {
  const cached = disks.get(stop.id)
  if (cached) return touch(disks, stop.id, cached)
  const disk = computeStopDisk(world, { center: stop, radius: options.radius })
  return remember(disks, DISK_LIMIT, stop.id, disk)
}

/** The journey's revealed mask as of the stop, from its published blob. */
export async function loadRevealedMask(
  store: JourneyStore,
  stop: Pick<Stop, 'id' | 'revealedKey'>,
): Promise<RevealedMask> {
  const bytes = await store.getInflated(stop.revealedKey)
  if (!bytes) {
    throw new LifecycleError(
      'NOT_PUBLISHED',
      `Stop ${stop.id} has no revealed mask at "${stop.revealedKey}" in the journey store; publish the stop before planning from it.`,
    )
  }
  return decodeRevealedMask(bytes)
}

/**
 * Every vertex a segment's record revealed (disk-grid indices of its from-stop's disk), read back
 * from its published traces, or its slices for a manifest before version 3: the record is not
 * kept anywhere else.
 */
export async function loadRecordReveals(
  store: JourneyStore,
  segment: Pick<Segment, 'id' | 'manifestKey' | 'startedAt' | 'endsAt'>,
): Promise<number[]> {
  const manifest = await store.getJson(segment.manifestKey)
  if (manifest === null) throw notPublished(segment.id, segment.manifestKey)
  const { sliceSeconds, version } = parseStoredSegmentManifest(manifest)
  // The last slice is released at the segment's end, one slice length after it starts.
  const count = Math.round(
    (segment.endsAt.getTime() - segment.startedAt.getTime()) / (sliceSeconds * 1000),
  )
  const range = { from: 0, to: count }
  const groups =
    version >= 3
      ? (await loadTraces(store, segment, range)).flatMap((trace) => trace.reveals)
      : (await loadSlices(store, segment, range)).flatMap((slice) => slice.reveals ?? [])
  return groups.flatMap((reveal) => Array.from(reveal.vertices))
}

/** Traces `from … to − 1` of a published segment, in order. */
export async function loadTraces(
  store: JourneyStore,
  segment: Pick<Segment, 'id'>,
  options: { from: number; to: number },
): Promise<SliceTrace[]> {
  return loadRange(options, async (index) => {
    const key = segmentTraceKey(segment.id, index)
    const bytes = await store.getInflated(key)
    if (!bytes) throw notPublished(segment.id, key)
    return decodeTrace(bytes)
  })
}

/** Slices `from … to − 1` of a published segment, in order. */
export async function loadSlices(
  store: JourneyStore,
  segment: Pick<Segment, 'id'>,
  options: { from: number; to: number },
): Promise<SegmentSlice[]> {
  return loadRange(options, async (index) => {
    const key = segmentSliceKey(segment.id, index)
    const bytes = await store.getInflated(key)
    if (!bytes) throw notPublished(segment.id, key)
    return decodeSlice(bytes)
  })
}

function loadRange<T>(
  options: { from: number; to: number },
  load: (index: number) => Promise<T>,
): Promise<T[]> {
  const { from, to } = options
  return Promise.all(Array.from({ length: Math.max(0, to - from) }, (_, k) => load(from + k)))
}

function notPublished(segmentId: string, key: string): LifecycleError {
  return new LifecycleError(
    'NOT_PUBLISHED',
    `Segment ${segmentId} has nothing at "${key}" in the journey store; settle it with the store it was published to.`,
  )
}

function touch<V>(cache: Map<string, V>, key: string, value: V): V {
  cache.delete(key)
  cache.set(key, value)
  return value
}

function remember<V>(cache: Map<string, V>, limit: number, key: string, value: V): V {
  cache.set(key, value)
  while (cache.size > limit) cache.delete(cache.keys().next().value!)
  return value
}
