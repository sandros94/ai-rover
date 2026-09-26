import { describe, expect, it } from 'vitest'
import type { ChunkCoords } from '#shared/utils/terrain'
import { chunkKey, chunksCoveringDisk, defineWorld, encodeChunk } from '#shared/utils/terrain'
import { ClientError, createChunkCache, createJourneyClient, loadOrder } from '#shared/utils/client'
import { journeyFixture, recordsFetch } from './helpers'

const SIZE = 64

describe('loadOrder', () => {
  const world = defineWorld({ seed: 'mars' })
  const manifest = {
    chunks: chunksCoveringDisk(world, { center: { x: 0, y: 0 }, radius: 500 }).map((c) => ({
      ...c,
      key: `k${c.cx}_${c.cy}`,
    })),
  }
  const center = { x: 100, y: 20 }
  const ring = { minM: 50, maxM: 250 }
  const viewport = { x: -300, y: 60, halfSizeM: 40 }

  /** Brute force over the square's 1 m lattice, edges included. */
  function anyPoint(c: ChunkCoords, test: (x: number, y: number) => boolean): boolean {
    for (let j = 0; j <= SIZE; j++) {
      for (let i = 0; i <= SIZE; i++) if (test(c.cx * SIZE + i, c.cy * SIZE + j)) return true
    }
    return false
  }
  const inRing = (c: ChunkCoords) =>
    anyPoint(c, (x, y) => {
      const d = Math.hypot(x - center.x, y - center.y)
      return d >= ring.minM && d <= ring.maxM
    })
  const inViewport = (c: ChunkCoords) =>
    anyPoint(
      c,
      (x, y) =>
        Math.abs(x - viewport.x) <= viewport.halfSizeM &&
        Math.abs(y - viewport.y) <= viewport.halfSizeM,
    )
  const distance = (c: ChunkCoords, p: { x: number; y: number }) =>
    Math.hypot((c.cx + 0.5) * SIZE - p.x, (c.cy + 0.5) * SIZE - p.y)
  const key = (c: ChunkCoords) => `${c.cx},${c.cy}`

  it('puts the viewport first, then the pick ring, then the rest by distance', () => {
    const order = loadOrder(manifest, { chunkSize: SIZE, center, ring, viewport })
    expect(order.map(key).toSorted()).toEqual(manifest.chunks.map(key).toSorted())
    const views = manifest.chunks.filter(inViewport)
    const rings = manifest.chunks.filter((c) => !inViewport(c) && inRing(c))
    expect(views.length).toBeGreaterThan(0)
    expect(rings.length).toBeGreaterThan(views.length)
    const first = order.slice(0, views.length)
    const second = order.slice(views.length, views.length + rings.length)
    const rest = order.slice(views.length + rings.length)
    expect(first.map(key).toSorted()).toEqual(views.map(key).toSorted())
    expect(second.map(key).toSorted()).toEqual(rings.map(key).toSorted())
    const sortedBy = (list: ChunkCoords[], p: { x: number; y: number }) =>
      list.every((c, k) => k === 0 || distance(list[k - 1]!, p) <= distance(c, p))
    expect(sortedBy(first, viewport)).toBe(true)
    expect(sortedBy(second, center)).toBe(true)
    expect(sortedBy(rest, center)).toBe(true)
  })

  it('puts the ring first without a viewport, and leaves the manifest untouched', () => {
    const before = JSON.stringify(manifest)
    const order = loadOrder(manifest, { chunkSize: SIZE, center, ring })
    const rings = manifest.chunks.filter(inRing)
    expect(order.slice(0, rings.length).map(key).toSorted()).toEqual(rings.map(key).toSorted())
    expect(JSON.stringify(manifest)).toBe(before)
    expect(order.every((c) => Object.keys(c).toSorted().join() === 'cx,cy')).toBe(true)
    expect(loadOrder(manifest, { chunkSize: SIZE, center, ring })).toEqual(order)
  })

  it('refuses a non-positive chunk size or an inverted ring', () => {
    for (const options of [
      { chunkSize: 0, center, ring },
      { chunkSize: SIZE, center, ring: { minM: 300, maxM: 250 } },
      { chunkSize: SIZE, center: { x: Number.NaN, y: 0 }, ring },
    ]) {
      expect(() => loadOrder(manifest, options)).toThrow(ClientError)
    }
  })
})

describe('createChunkCache', () => {
  const { worldHash } = journeyFixture().stopManifest

  function setup(options: { max?: number; override?: (key: string) => Response | undefined } = {}) {
    const records = recordsFetch({ override: options.override })
    const client = createJourneyClient({ fetch: records.fetch })
    const cache = createChunkCache({ client, worldHash, max: options.max })
    return { cache, calls: records.calls }
  }
  const url = (cx: number, cy: number) => `/journey/${chunkKey(worldHash, { cx, cy })}`

  it('dedupes concurrent gets into one request', async () => {
    const { cache, calls } = setup()
    const [a, b] = await Promise.all([cache.get(0, 0), cache.get(0, 0)])
    expect(a).toBe(b)
    expect(await cache.get(0, 0)).toBe(a)
    expect(calls).toEqual([url(0, 0)])
    expect(cache.peek(0, 0)).toBe(a)
    expect(cache.peek(-1, 0)).toBeUndefined()
    expect(cache.geometry).toEqual({ vertexCount: 65, cellSize: 1 })
  })

  it('evicts the least recently used chunk past its capacity', async () => {
    const { cache, calls } = setup({ max: 2 })
    await cache.get(0, 0)
    await cache.get(-1, 0)
    await cache.get(0, 0)
    await cache.get(0, -1)
    expect(cache.size).toBe(2)
    expect(cache.peek(-1, 0)).toBeUndefined()
    await cache.get(0, 0)
    await cache.get(-1, 0)
    expect(calls).toEqual([url(0, 0), url(-1, 0), url(0, -1), url(-1, 0)])
  })

  it('keeps no failure: the next get asks again', async () => {
    let fail = true
    const { cache, calls } = setup({
      override: () => (fail ? new Response(null, { status: 503 }) : undefined),
    })
    await expect(cache.get(0, 0)).rejects.toMatchObject({ code: 'NETWORK' })
    fail = false
    expect((await cache.get(0, 0)).cx).toBe(0)
    expect(calls.length).toBe(2)
  })

  it('prefetches in the given order and reports each chunk', async () => {
    const { cache, calls } = setup()
    const order = [
      { cx: 0, cy: 0 },
      { cx: -1, cy: -1 },
      { cx: 0, cy: -1 },
      { cx: -1, cy: 0 },
    ]
    const seen: string[] = []
    await cache.prefetch(order, { concurrency: 1, onChunk: (c) => seen.push(`${c.cx},${c.cy}`) })
    expect(calls).toEqual(order.map((c) => url(c.cx, c.cy)))
    expect(seen).toEqual(['0,0', '-1,-1', '0,-1', '-1,0'])
    await cache.prefetch(order)
    expect(calls.length).toBe(4)
  })

  it('prefetches everything it can, then rejects with the first failure', async () => {
    const { cache } = setup()
    const order = [
      { cx: 0, cy: 0 },
      { cx: 40, cy: 40 },
      { cx: -1, cy: 0 },
    ]
    await expect(cache.prefetch(order)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(cache.peek(0, 0)).toBeDefined()
    expect(cache.peek(-1, 0)).toBeDefined()
  })

  it('refuses a chunk whose grid differs from the chunks already loaded with DECODE', async () => {
    const odd = encodeChunk({
      cx: -1,
      cy: 0,
      vertexCount: 3,
      cellSize: 1,
      heights: new Float32Array(9),
      masks: new Uint8Array(9),
    })
    const { cache } = setup({
      override: (key) =>
        key.endsWith('-1_0.bin') ? new Response(odd as Uint8Array<ArrayBuffer>) : undefined,
    })
    await cache.get(0, 0)
    await expect(cache.get(-1, 0)).rejects.toMatchObject({ code: 'DECODE' })
  })
})
