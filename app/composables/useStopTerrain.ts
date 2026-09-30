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
 * stop without a pack) chunk by chunk, the viewport first, then nearest `center` (default: the
 * stop). `loaded` counts loaded chunks; `ground` is the disk as it arrives, at most
 * {@link GROUND_VIEW_HZ} views a second, for views that draw it chunk by chunk; `terrain` is the
 * stitched disk once every chunk is in, and `revealed` the stop's mask over the disk, one byte per
 * disk vertex, as soon as the mask is in.
 *
 * A stop is named by its manifest's key, as the mission state or a drive gives it; the mask and
 * the pack are read by the keys the manifest names. A new `manifestKey` shows that stop's disk
 * instead, the one before kept until the new manifest is in; `prefetch` loads a stop's disk ahead
 * so the switch is immediate. Stops share one chunk cache per world.
 */
export function useStopTerrain(
  manifestKey: MaybeRefOrGetter<string>,
  options: {
    center?: { x: number; y: number }
    viewport?: { x: number; y: number; halfSizeM: number }
  } = {},
) {
  const client = useJourneyClient()
  const manifest = shallowRef<StopManifest>()
  /** The manifest key of the stop `manifest` describes. */
  const shownKey = shallowRef<string>()
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

  /**
   * Each stop's manifest and the mask it names, requested once by manifest key; a failed request
   * is asked again next time.
   */
  const requested = new Map<
    string,
    { manifest: Promise<StopManifest>; mask: Promise<RevealedMask> }
  >()
  function request(key: string) {
    let entry = requested.get(key)
    if (!entry) {
      const manifest = client.getStopManifest(key)
      entry = { manifest, mask: manifest.then((stop) => client.getRevealedMask(stop.revealedKey)) }
      const forget = () => {
        if (requested.get(key) === entry) requested.delete(key)
      }
      entry.manifest.catch(forget)
      entry.mask.catch(forget)
      requested.set(key, entry)
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
      viewport: options.viewport,
    })

  /**
   * Every chunk of the stop into the cache, `onChunk` called for each, held ones first. The pack
   * costs the whole disk, so it is fetched only while most of the disk is missing, and only for a
   * manifest that names one; a pack missing or broken off leaves the rest to per-chunk requests.
   */
  async function load(
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
        await chunks.loadPack(stop.packKey, { onChunk })
      } catch (caught) {
        if (!(caught instanceof ClientError) || caught.code !== 'NETWORK') throw caught
      }
    }
    await chunks.prefetch(order, { onChunk })
  }

  /** Bumped per stop shown, so a stop arriving after a switch is dropped. */
  let generation = 0

  async function show(key: string): Promise<void> {
    const current = ++generation
    try {
      const entry = request(key)
      const stop = await entry.manifest
      if (current !== generation) return
      const chunks = chunksOf(stop.worldHash)
      const shown = createDiskGround(stop)
      mask.value = undefined
      loaded.value = 0
      error.value = null
      manifest.value = stop
      shownKey.value = key
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
      await load(stop, chunks, (chunk) => {
        if (current !== generation || !shown.place(chunk)) return
        loaded.value = shown.placed.length
        view()
      })
      await masked
    } catch (caught) {
      if (current === generation) error.value = caught
    }
  }

  /** Loads the manifest at `key`, its mask and its chunks without showing them. */
  async function prefetch(key: string): Promise<void> {
    const entry = request(key)
    const stop = await entry.manifest
    await Promise.all([entry.mask, load(stop, chunksOf(stop.worldHash))])
  }

  onMounted(() => {
    watch(
      () => toValue(manifestKey),
      (key) => void show(key),
      { immediate: true },
    )
  })

  return {
    manifest,
    manifestKey: shownKey,
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
