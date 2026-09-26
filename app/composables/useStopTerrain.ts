import type { ChunkCache, TerrainSampler } from '#shared/utils/client'
import { createChunkCache, createTerrainSampler, loadOrder } from '#shared/utils/client'
import { DEFAULT_MISSION_RULES } from '#shared/utils/mission'
import type { RevealedMask, StopManifest } from '#shared/utils/terrain'
import { useJourneyClient } from './useJourneyClient'

/**
 * A stop's terrain in the browser: manifest, revealed mask, and its chunks loaded progressively,
 * the viewport and the pick ring around `center` (default: the stop) first. `version` counts
 * loaded chunks so views can redraw as ground arrives.
 */
export function useStopTerrain(
  missionId: string,
  stopIndex: number,
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

  async function load(): Promise<void> {
    const stop = await client.getStopManifest(missionId, stopIndex)
    manifest.value = stop
    const chunks = createChunkCache({ client, worldHash: stop.worldHash })
    cache.value = chunks
    sampler.value = createTerrainSampler(chunks)
    const masked = client.getRevealedMask(missionId, stopIndex).then((m) => {
      mask.value = m
    })
    // Any chunk tells the world's chunk size, which the manifest does not carry; the middle of
    // its (cy, cx)-sorted list lies near the stop, where ground is wanted first anyway.
    const first = stop.chunks[stop.chunks.length >> 1]
    if (first) {
      await chunks.get(first.cx, first.cy)
      loaded.value = 1
      const { vertexCount, cellSize } = chunks.geometry!
      const order = loadOrder(stop, {
        chunkSize: (vertexCount - 1) * cellSize,
        center: options.center ?? { x: stop.stop.x, y: stop.stop.y },
        ring: options.ring ?? DEFAULT_MISSION_RULES.segmentDistanceBand,
        viewport: options.viewport,
      })
      await chunks.prefetch(
        order.filter((c) => c.cx !== first.cx || c.cy !== first.cy),
        {
          onChunk: () => {
            loaded.value++
          },
        },
      )
    }
    await masked
  }

  onMounted(() => {
    load().catch((caught: unknown) => {
      error.value = caught
    })
  })

  return { manifest, mask, cache, sampler, loaded, total, progress, error }
}
