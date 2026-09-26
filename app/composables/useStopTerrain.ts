import type { MaybeRefOrGetter } from 'vue'
import type { ChunkCache, TerrainSampler } from '#shared/utils/client'
import {
  createChunkCache,
  createTerrainSampler,
  DEFAULT_CHUNK_CACHE_SIZE,
  loadOrder,
} from '#shared/utils/client'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { RevealedMask, StopManifest } from '#shared/utils/terrain'
import { revealedOverDisk } from '#shared/utils/terrain'
import { useJourneyClient } from './useJourneyClient'

/**
 * Chunks held across stops: the disk shown and the next one fetched ahead of it. Two
 * neighbouring disks share most of their chunks, so the cache serves both.
 */
export const STOP_TERRAIN_CACHE_SIZE = 2 * DEFAULT_CHUNK_CACHE_SIZE

/**
 * A stop's terrain in the browser: manifest, revealed mask, and its chunks loaded progressively,
 * the viewport and the pick ring around `center` (default: the stop) first. `loaded` counts
 * loaded chunks so views can redraw as ground arrives; `terrain` is the stitched disk once every
 * chunk is in, and `revealed` the stop's mask over it, one byte per disk vertex.
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
  const total = computed(() => manifest.value?.chunks.length ?? 0)
  const progress = computed(() => (total.value === 0 ? 0 : loaded.value / total.value))
  const error = shallowRef<unknown>(null)
  const terrain = computed(() =>
    manifest.value && sampler.value && total.value > 0 && loaded.value >= total.value
      ? sampler.value.assembleDiskGrid(manifest.value)
      : undefined,
  )
  const revealed = computed(() =>
    terrain.value && mask.value ? revealedOverDisk(mask.value, terrain.value) : undefined,
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

  /** Bumped per stop shown, so a stop arriving after a switch is dropped. */
  let generation = 0

  async function show(index: number): Promise<void> {
    const current = ++generation
    try {
      const entry = request(index)
      const stop = await entry.manifest
      if (current !== generation) return
      const chunks = chunksOf(stop.worldHash)
      mask.value = undefined
      loaded.value = 0
      error.value = null
      manifest.value = stop
      const masked = entry.mask.then((m) => {
        if (current === generation) mask.value = m
      })
      await chunks.prefetch(orderOf(stop), {
        onChunk: () => {
          if (current === generation) loaded.value++
        },
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
    await Promise.all([entry.mask, chunksOf(stop.worldHash).prefetch(orderOf(stop))])
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
    terrain,
    revealed,
    error,
    prefetch,
  }
}
