import type { MaybeRefOrGetter } from 'vue'
import type { ChunkCache, DiskGround, GroundView, TerrainSampler } from '#shared/utils/client'
import {
  ClientError,
  createChunkCache,
  createDiskGround,
  createTerrainSampler,
  DEFAULT_CHUNK_CACHE_SIZE,
  groundView,
  loadOrder,
} from '#shared/utils/client'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { Chunk, RevealedMask, StopManifest } from '#shared/utils/terrain'
import { revealedOverDisk } from '#shared/utils/terrain'
import { useJourneyClient } from './useJourneyClient'
import { useThrottled } from './useThrottled'

/**
 * Chunks held across stops: the disk shown and the next one fetched ahead of it. Two
 * neighbouring disks share most of their chunks, so the cache serves both.
 */
export const STOP_TERRAIN_CACHE_SIZE = 2 * DEFAULT_CHUNK_CACHE_SIZE

/** Views of the arriving ground per second: each one repaints what arrived since the last. */
export const GROUND_VIEW_HZ = 10

/**
 * A stop's terrain in the browser: manifest, revealed mask, and its chunks loaded progressively,
 * from the stop's disk pack in one request when most of the disk is not held yet, else (or for a
 * stop without a pack) chunk by chunk, the viewport and the pick ring around `center` (default:
 * the stop) first. `loaded` counts loaded chunks; `ground` is the disk as it arrives, at most
 * {@link GROUND_VIEW_HZ} views a second, for views that draw it chunk by chunk; `terrain` is the
 * stitched disk once every chunk is in, and `revealed` the stop's mask over the disk, one byte per
 * disk vertex, as soon as the mask is in.
 *
 * A new `stopIndex` shows that stop's disk instead, the one before kept until the new manifest
 * is in; `prefetch` loads a stop's disk ahead so the switch is immediate. Stops share one chunk
 * cache per world.
 */
export function useStopTerrain(
  missionId: string,
  stopIndex: MaybeRefOrGetter<number>,
  options: {
    center?: { x: number; y: number }
    ring?: { minM: number; maxM: number }
    viewport?: { x: number; y: number; halfSizeM: number }
  } = {},
) {
  const client = useJourneyClient()
  const manifest = shallowRef<StopManifest>()
  const mask = shallowRef<RevealedMask>()
  const cache = shallowRef<ChunkCache>()
  const sampler = shallowRef<TerrainSampler>()
  const loaded = ref(0)
  /** The shown stop's disk, filled in place as chunks arrive. */
  const disk = shallowRef<DiskGround>()
  const arriving = shallowRef<GroundView>()
  const ground = useThrottled(() => arriving.value, GROUND_VIEW_HZ)
  const total = computed(() => manifest.value?.chunks.length ?? 0)
  const progress = computed(() => (total.value === 0 ? 0 : loaded.value / total.value))
  const error = shallowRef<unknown>(null)
  const terrain = computed(() =>
    manifest.value && sampler.value && total.value > 0 && loaded.value >= total.value
      ? sampler.value.assembleDiskGrid(manifest.value)
      : undefined,
  )
  // The disk's layout comes from the manifest, so the fog is known before any ground.
  const revealed = computed(() =>
    disk.value && mask.value ? revealedOverDisk(mask.value, disk.value) : undefined,
  )

  /** Each stop's manifest and mask, requested once; a failed request is asked again next time. */
  const requested = new Map<
    number,
    { manifest: Promise<StopManifest>; mask: Promise<RevealedMask> }
  >()
  function request(index: number) {
    let entry = requested.get(index)
    if (!entry) {
      entry = {
        manifest: client.getStopManifest(missionId, index),
        mask: client.getRevealedMask(missionId, index),
      }
      const forget = () => {
        if (requested.get(index) === entry) requested.delete(index)
      }
      entry.manifest.catch(forget)
      entry.mask.catch(forget)
      requested.set(index, entry)
    }
    return entry
  }

  function chunksOf(worldHash: string): ChunkCache {
    if (cache.value?.worldHash !== worldHash) {
      const chunks = createChunkCache({ client, worldHash, max: STOP_TERRAIN_CACHE_SIZE })
      cache.value = chunks
      sampler.value = createTerrainSampler(chunks)
    }
    return cache.value
  }

  const orderOf = (stop: StopManifest) =>
    loadOrder(stop, {
      center: options.center ?? { x: stop.stop.x, y: stop.stop.y },
      ring: options.ring ?? DEFAULT_MISSION_RULES.segmentDistanceBand,
      viewport: options.viewport,
    })

  /**
   * Every chunk of stop `index` into the cache, `onChunk` called for each, held ones first. The
   * pack costs the whole disk, so it is fetched only while most of the disk is missing, and only
   * for a manifest that names one; a pack missing or broken off leaves the rest to per-chunk
   * requests.
   */
  async function load(
    index: number,
    stop: StopManifest,
    chunks: ChunkCache,
    onChunk?: (chunk: Chunk) => void,
  ): Promise<void> {
    const order = orderOf(stop)
    let missing = 0
    for (const { cx, cy } of order) {
      const held = chunks.peek(cx, cy)
      if (held) onChunk?.(held)
      else missing++
    }
    if (stop.packKey && 2 * missing > order.length) {
      try {
        await chunks.loadPack(missionId, index, { onChunk })
      } catch (caught) {
        if (!(caught instanceof ClientError) || caught.code !== 'NETWORK') throw caught
      }
    }
    await chunks.prefetch(order, { onChunk })
  }

  /** Bumped per stop shown, so a stop arriving after a switch is dropped. */
  let generation = 0

  async function show(index: number): Promise<void> {
    const current = ++generation
    try {
      const entry = request(index)
      const stop = await entry.manifest
      if (current !== generation) return
      const chunks = chunksOf(stop.worldHash)
      const shown = createDiskGround(stop)
      mask.value = undefined
      loaded.value = 0
      error.value = null
      manifest.value = stop
      disk.value = shown
      // Without the manifest's height range the tint is measured over the whole disk, so ground
      // is shown only once all of it is in.
      const view = () => {
        if (stop.heightRange || shown.complete) arriving.value = groundView(shown, stop.heightRange)
      }
      arriving.value = undefined
      view()
      const masked = entry.mask.then((m) => {
        if (current === generation) mask.value = m
      })
      await load(index, stop, chunks, (chunk) => {
        if (current !== generation || !shown.place(chunk)) return
        loaded.value = shown.placed.length
        view()
      })
      await masked
    } catch (caught) {
      if (current === generation) error.value = caught
    }
  }

  /** Loads stop `index`'s manifest, mask and chunks without showing them. */
  async function prefetch(index: number): Promise<void> {
    const entry = request(index)
    const stop = await entry.manifest
    await Promise.all([entry.mask, load(index, stop, chunksOf(stop.worldHash))])
  }

  onMounted(() => {
    watch(
      () => toValue(stopIndex),
      (index) => void show(index),
      { immediate: true },
    )
  })

  return {
    manifest,
    mask,
    cache,
    sampler,
    loaded,
    total,
    progress,
    ground,
    terrain,
    revealed,
    error,
    prefetch,
  }
}
