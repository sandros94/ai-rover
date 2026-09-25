import { describe, expect, it } from 'vitest'
import { defineWorld, encodeChunk, generateChunk } from '#shared/utils/terrain'
import { createJourneyStore } from '#server/utils/journey/store'
import { MemoryBlobs } from './helpers'

const chunk = encodeChunk(generateChunk(defineWorld({ seed: 'mars' }), { cx: 0, cy: 0 }))

describe('journey store', () => {
  it('stores deflated bytes with their metadata', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    const put = await store.putImmutable('terrain/x/chunks/0_0.bin', chunk, {
      contentType: 'application/octet-stream',
    })
    expect(put).toEqual({
      key: 'terrain/x/chunks/0_0.bin',
      rawLength: chunk.byteLength,
      storedLength: expect.any(Number),
    })
    expect(put.storedLength).toBeLessThan(chunk.byteLength)
    const stored = blobs.blobs.get('terrain/x/chunks/0_0.bin')!
    expect(stored.data.byteLength).toBe(put.storedLength)
    expect(stored.metadata).toEqual({
      contentType: 'application/octet-stream',
      encoding: 'deflate',
      rawLength: chunk.byteLength,
    })
    // zlib wrapper (RFC 1950), which is what HTTP `content-encoding: deflate` means.
    const head = new Uint8Array(stored.data, 0, 2)
    expect(head[0]! & 0x0f).toBe(8)
    expect((head[0]! * 256 + head[1]!) % 31).toBe(0)
  })

  it('reads the deflated bytes back and inflates them on request', async () => {
    const store = createJourneyStore({ store: new MemoryBlobs() })
    await store.putImmutable('k.bin', chunk, { contentType: 'application/octet-stream' })
    const got = await store.get('k.bin')
    expect(got?.metadata.rawLength).toBe(chunk.byteLength)
    expect(got!.bytes.byteLength).toBeLessThan(chunk.byteLength)
    expect(await store.getInflated('k.bin')).toEqual(chunk)
    expect(await store.has('k.bin')).toBe(true)
  })

  it('round-trips JSON', async () => {
    const store = createJourneyStore({ store: new MemoryBlobs() })
    const value = { version: 1, list: [1.25, -3, 'x'], nested: { ok: true } }
    await store.putJson('v.json', value)
    const got = await store.get('v.json')
    expect(got?.metadata).toEqual({
      contentType: 'application/json',
      encoding: 'deflate',
      rawLength: JSON.stringify(value).length,
    })
    expect(await store.getJson('v.json')).toEqual(value)
  })

  it('answers null for a missing key', async () => {
    const store = createJourneyStore({ store: new MemoryBlobs() })
    expect(await store.get('none')).toBeNull()
    expect(await store.getInflated('none')).toBeNull()
    expect(await store.getJson('none')).toBeNull()
    expect(await store.has('none')).toBe(false)
  })

  it('refuses a blob it did not write', async () => {
    const blobs = new MemoryBlobs()
    await blobs.set('raw', new ArrayBuffer(4), { metadata: {} })
    await expect(createJourneyStore({ store: blobs }).get('raw')).rejects.toThrow(/metadata/)
  })

  it('lists keys under a prefix and deletes one', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    for (const key of ['terrain/a/chunks/0_0.bin', 'terrain/a/stops/0.json', 'segments/s/0.bin']) {
      await store.putJson(key, {})
    }
    expect((await store.listKeys('terrain/')).toSorted()).toEqual([
      'terrain/a/chunks/0_0.bin',
      'terrain/a/stops/0.json',
    ])
    expect(await store.listKeys()).toHaveLength(3)

    await store.delete('terrain/a/stops/0.json')
    expect(await store.has('terrain/a/stops/0.json')).toBe(false)
    expect(await store.listKeys('terrain/')).toEqual(['terrain/a/chunks/0_0.bin'])
  })
})
