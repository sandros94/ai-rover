import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { useStopTerrain } from '~/composables/useStopTerrain'
import { journeyFixture } from '../unit/client/helpers'

const { stopManifest, stopKeys, files } = journeyFixture()

afterEach(() => vi.unstubAllGlobals())

/**
 * `/journey/{key}` over the fixture journey, rebuilt in memory (the unit tests hold it byte for
 * byte against the recorded files); `missing` keys answer 404. Every URL asked is in `calls`.
 */
function journeyFetch(
  missing: (key: string) => boolean = () => false,
  served: Map<string, Uint8Array> = files,
) {
  const calls: string[] = []
  async function fetch(input: string): Promise<Response> {
    calls.push(input)
    const key = input.replace(/^\/journey\//, '')
    const bytes = served.get(key)
    if (!bytes || missing(key)) return new Response(null, { status: 404 })
    return new Response(bytes as Uint8Array<ArrayBuffer>)
  }
  return { fetch, calls }
}

/** Mounts a component using the composable over the fixture journey, served by `records`. */
async function mountTerrain(records: ReturnType<typeof journeyFetch>) {
  vi.stubGlobal('fetch', records.fetch)
  let terrain: ReturnType<typeof useStopTerrain> | undefined
  await mountSuspended(
    defineComponent({
      setup() {
        terrain = useStopTerrain(stopKeys.manifestKey)
        return () => h('div')
      },
    }),
  )
  await vi.waitFor(() => expect(terrain!.terrain.value).toBeDefined())
  return terrain!
}

/** Requests for terrain: the pack or single chunks, not the manifest or the mask. */
const terrainCalls = (calls: string[]) =>
  calls.filter((url) => url.includes('/chunks/') || url.endsWith('.pack'))

describe('useStopTerrain', () => {
  it('loads every chunk of a stop from its pack in one request', async () => {
    const records = journeyFetch()
    const terrain = await mountTerrain(records)
    expect(terrainCalls(records.calls)).toEqual([`/journey/${stopManifest.packKey}`])
    expect(stopManifest.chunks).toHaveLength(16)
    expect(terrain.loaded.value).toBe(stopManifest.chunks.length)
    expect(terrain.revealed.value).toBeDefined()
    await vi.waitFor(() => expect(terrain.ground.value?.complete).toBe(true))
    expect(terrain.ground.value?.placed).toHaveLength(stopManifest.chunks.length)
    expect(terrain.ground.value?.heightRange).toEqual(stopManifest.heightRange)
  })

  it('reads the manifest by the key it is given, the mask and the pack by the keys it names', async () => {
    const records = journeyFetch()
    await mountTerrain(records)
    expect(records.calls[0]).toBe(`/journey/${stopKeys.manifestKey}`)
    expect(records.calls).toContain(`/journey/${stopManifest.revealedKey}`)
    expect(records.calls).toContain(`/journey/${stopManifest.packKey}`)
    expect(records.calls.every((url) => !/\/(stops|revealed)\/\d+\./.test(url))).toBe(true)
  })

  it('falls back to chunk requests when the stop has no pack', async () => {
    const records = journeyFetch((key) => key.endsWith('.pack'))
    const terrain = await mountTerrain(records)
    const calls = terrainCalls(records.calls)
    expect(calls[0]).toBe(`/journey/${stopManifest.packKey}`)
    expect(calls.slice(1).toSorted()).toEqual(
      stopManifest.chunks.map((c) => `/journey/${c.key}`).toSorted(),
    )
    expect(terrain.loaded.value).toBe(stopManifest.chunks.length)
    expect(terrain.error.value).toBeNull()
  })

  it('loads a version 2 stop chunk by chunk, never asking for a pack', async () => {
    const { packKey: _packKey, heightRange: _heightRange, ...rest } = stopManifest
    const v2 = new Map(files)
    v2.set(stopKeys.manifestKey, new TextEncoder().encode(JSON.stringify({ ...rest, version: 2 })))
    const records = journeyFetch(() => false, v2)
    const terrain = await mountTerrain(records)
    expect(terrainCalls(records.calls).toSorted()).toEqual(
      stopManifest.chunks.map((c) => `/journey/${c.key}`).toSorted(),
    )
    expect(terrain.loaded.value).toBe(stopManifest.chunks.length)
    // Its ground is shown whole, tinted over its own heights.
    await vi.waitFor(() => expect(terrain.ground.value?.complete).toBe(true))
    expect(terrain.ground.value?.heightRange).toBeUndefined()
  })
})
