import { describe, expect, it } from 'vitest'
import {
  computeStopDisk,
  createRevealedMask,
  decodeChunk,
  decodeDiskPack,
  decodeRevealedMask,
  defineWorld,
  encodeRevealedMask,
  generateChunk,
  parseStopManifest,
  revealDisk,
  stopManifestKey,
  worldHash,
} from '#shared/utils/terrain'
import {
  decodeSlice,
  driveSegment,
  parseStoredSegmentManifest,
  segmentManifestKey,
  segmentSliceKey,
  sliceRecord,
} from '#shared/utils/drive'
import { createJourneyStore, PUT_CONCURRENCY, putAll } from '#server/utils/journey/store'
import {
  contentSegmentId,
  encodeSegment,
  publishSegment,
  publishStop,
} from '#server/utils/journey/publish'
import { CountingBlobs, MemoryBlobs } from './helpers'

const world = defineWorld({ seed: 'mars' })
const disk = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 150 })
const mask = revealDisk(createRevealedMask(world), disk)
const missionId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

describe('putAll', () => {
  const bytes = () => new Uint8Array([1, 2, 3])
  const entries = (n: number) =>
    Array.from({ length: n }, (_, k) => ({ key: `k/${k}`, bytes, contentType: 'x/y' }))

  it(`never exceeds ${PUT_CONCURRENCY} writes in flight, overlaps them, and writes every entry`, async () => {
    const blobs = new CountingBlobs()
    const result = await putAll(createJourneyStore({ store: blobs }), entries(50))
    expect(blobs.maxInFlight).toBeLessThanOrEqual(PUT_CONCURRENCY)
    expect(blobs.maxInFlight).toBeGreaterThan(1)
    expect(result.written.map((w) => w.key)).toEqual(entries(50).map((e) => e.key))
    expect(new Set(blobs.writes).size).toBe(50)
  })

  it('skips keys already stored without encoding them', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await putAll(store, entries(3).slice(1))
    blobs.writes.length = 0
    let encoded = 0
    const counted = entries(3).map((e) => ({ ...e, bytes: () => (encoded++, bytes()) }))
    const result = await putAll(store, counted)
    expect(blobs.writes).toEqual(['k/0'])
    expect(encoded).toBe(1)
    expect(result.skipped).toEqual(['k/1', 'k/2'])
  })

  it('starts nothing more after a write fails, and rejects', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    const failing = {
      ...store,
      putImmutable: async (...args: Parameters<typeof store.putImmutable>) => {
        if (args[0] === 'k/3') throw new Error('killed')
        return store.putImmutable(...args)
      },
    }
    await expect(putAll(failing, entries(40), { concurrency: 2 })).rejects.toThrow('killed')
    expect(blobs.writes.length).toBeLessThan(6)
  })
})

describe('publishStop', () => {
  it('writes every chunk and the mask, then the pack, then the manifest', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    const result = await publishStop(store, { world, disk, mask, missionId, stopIndex: 0 })
    const manifestKey = stopManifestKey(missionId, 0)
    expect(result.manifestKey).toBe(manifestKey)
    expect(blobs.writes).toHaveLength(disk.chunks.length + 3)
    const manifest = parseStopManifest(await store.getJson(manifestKey))
    expect(manifest).toMatchObject({ missionId, worldHash: worldHash(world) })
    expect(blobs.writes.slice(-2)).toEqual([manifest.packKey, manifestKey])
    expect(new Set(blobs.writes.slice(0, -2))).toEqual(
      new Set([...manifest.chunks.map((c) => c.key), manifest.revealedKey]),
    )
    const first = decodeChunk((await store.getInflated(manifest.chunks[0]!.key))!)
    expect([first.cx, first.cy]).toEqual([manifest.chunks[0]!.cx, manifest.chunks[0]!.cy])
    const storedMask = (await store.getInflated(manifest.revealedKey))!
    expect(storedMask).toEqual(encodeRevealedMask(mask))
    expect(decodeRevealedMask(storedMask).chunks.size).toBe(mask.chunks.size)
    expect(new Set(result.written.map((w) => w.key))).toEqual(new Set(blobs.writes))
    expect(result.skipped).toEqual([])
  })

  it('packs exactly the listed chunks, in manifest order, as the chunk blobs hold them', async () => {
    const store = createJourneyStore({ store: new MemoryBlobs() })
    const result = await publishStop(store, { world, disk, mask, missionId, stopIndex: 0 })
    const manifest = parseStopManifest(await store.getJson(result.manifestKey))
    const packKey = manifest.packKey!
    const packed = decodeDiskPack((await store.getInflated(packKey))!)
    expect(packed.map(({ cx, cy }) => ({ cx, cy }))).toEqual(
      manifest.chunks.map(({ cx, cy }) => ({ cx, cy })),
    )
    expect(packed[3]).toEqual(generateChunk(world, manifest.chunks[3]!))
    // Deflate's 32 KB window reaches across no chunk, so the pack weighs what the chunks do.
    const stored = new Map(result.written.map((w) => [w.key, w.storedLength]))
    const chunkBytes = manifest.chunks.reduce((sum, c) => sum + stored.get(c.key)!, 0)
    expect(stored.get(packKey)! / chunkBytes).toBeCloseTo(1, 1)
  })

  it('skips chunks already stored on a later stop', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await publishStop(store, { world, disk, mask, missionId, stopIndex: 0 })
    blobs.writes.length = 0
    const result = await publishStop(store, { world, disk, mask, missionId, stopIndex: 1 })
    expect(result.skipped).toHaveLength(disk.chunks.length)
    const manifest = parseStopManifest(await store.getJson(stopManifestKey(missionId, 1)))
    // Each stop has its own pack, even when every chunk it holds is stored already.
    expect(blobs.writes).toEqual([
      manifest.revealedKey,
      manifest.packKey,
      stopManifestKey(missionId, 1),
    ])
  })

  it('run again after being cut short, writes only what is missing, then the manifest', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await publishStop(store, { world, disk, mask, missionId, stopIndex: 0 })
    const manifest = parseStopManifest(await store.getJson(stopManifestKey(missionId, 0)))
    const lost = [manifest.chunks[2]!.key, manifest.packKey!, stopManifestKey(missionId, 0)]
    for (const key of lost) blobs.blobs.delete(key)
    blobs.writes.length = 0
    const result = await publishStop(store, { world, disk, mask, missionId, stopIndex: 0 })
    expect(blobs.writes).toEqual(lost)
    expect(result.skipped).toHaveLength(disk.chunks.length)
    expect(result.skipped).toContain(manifest.revealedKey)
    // With the pack stored too, only the manifest is written again.
    blobs.writes.length = 0
    await publishStop(store, { world, disk, mask, missionId, stopIndex: 0 })
    expect(blobs.writes).toEqual([stopManifestKey(missionId, 0)])
  })
})

describe('publishSegment', () => {
  const start = { x: 0, y: 0, headingRad: 0 }
  const goal = { x: 40, y: 30 }
  const { record } = driveSegment(world, { disk, revealed: mask, start, goal })
  const { slices } = sliceRecord(record)
  const segment = encodeSegment(record)

  it('writes the slices before the manifest, which parses with its id and start time', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    const startedAt = 1_790_000_000_000
    const result = await publishSegment(store, { segment, segmentId: 'seg-1', startedAt })
    expect(result.manifestKey).toBe(segmentManifestKey('seg-1'))
    expect(blobs.writes.at(-1)).toBe(segmentManifestKey('seg-1'))
    expect(new Set(blobs.writes.slice(0, -1))).toEqual(
      new Set(slices.map((s) => segmentSliceKey('seg-1', s.index))),
    )
    const manifest = parseStoredSegmentManifest(await store.getJson(segmentManifestKey('seg-1')))
    expect(manifest.segmentId).toBe('seg-1')
    expect(manifest.startedAt).toBe(startedAt)
    expect(manifest.start).toEqual(start)
    expect(manifest.goal).toEqual(goal)
    const last = decodeSlice(
      (await store.getInflated(segmentSliceKey('seg-1', slices.length - 1)))!,
    )
    expect(last.outcome).toEqual(record.outcome)
    expect(result.written).toHaveLength(slices.length + 1)
    // The drive ends when its last slice is released.
    expect(result.endsAt).toBe(startedAt + slices.length * manifest.sliceSeconds * 1000)
  })

  it(`keeps at most ${PUT_CONCURRENCY} slices in flight`, async () => {
    expect(slices.length).toBeGreaterThan(PUT_CONCURRENCY)
    const blobs = new CountingBlobs()
    await publishSegment(createJourneyStore({ store: blobs }), {
      segment,
      segmentId: 'seg-1',
      startedAt: 0,
    })
    expect(blobs.maxInFlight).toBeLessThanOrEqual(PUT_CONCURRENCY)
    expect(blobs.maxInFlight).toBeGreaterThan(1)
  })

  it('run again after being cut short, writes only the missing slices, then the manifest', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await publishSegment(store, { segment, segmentId: 'seg-1', startedAt: 0 })
    const lost = [3, 7].map((index) => segmentSliceKey('seg-1', index))
    for (const key of [...lost, segmentManifestKey('seg-1')]) blobs.blobs.delete(key)
    blobs.writes.length = 0
    const result = await publishSegment(store, { segment, segmentId: 'seg-1', startedAt: 5000 })
    // Slices are written in parallel, in any order; the manifest comes after all of them.
    expect(blobs.writes.slice(0, -1).sort()).toEqual([...lost].sort())
    expect(blobs.writes.at(-1)).toBe(segmentManifestKey('seg-1'))
    expect(result.skipped).toHaveLength(slices.length - 2)
    // The manifest carries the start of the run that wrote it last.
    const manifest = parseStoredSegmentManifest(await store.getJson(segmentManifestKey('seg-1')))
    expect(manifest.startedAt).toBe(5000)
  })

  it('refuses a bad segment id or start time before writing anything', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await expect(
      publishSegment(store, { segment, segmentId: '../x', startedAt: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      publishSegment(store, { segment, segmentId: 'ok', startedAt: Number.NaN }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(blobs.writes).toEqual([])
  })
})

describe('a prepared drive', () => {
  const start = { x: 0, y: 0, headingRad: 0 }
  // 1 m: short, yet its record spans more than one slice, which a cut needs.
  const goal = { x: 0.8, y: 0.6 }
  const prepare = () =>
    encodeSegment(driveSegment(world, { disk, revealed: mask, start, goal }).record)

  it('encodes to the same bytes and id each time it is prepared, so a retry resumes it', async () => {
    const [first, again] = [prepare(), prepare()]
    expect(again.slices).toHaveLength(first.slices.length)
    for (const [n, bytes] of again.slices.entries()) expect(bytes).toEqual(first.slices[n])
    expect(again.manifest).toEqual(first.manifest)
    const id = await contentSegmentId(first, 'round-1')
    expect(await contentSegmentId(again, 'round-1')).toBe(id)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('is named apart in another scope or with other content', async () => {
    const segment = prepare()
    expect(segment.slices.length).toBeGreaterThan(1)
    const id = await contentSegmentId(segment, 'round-1')
    expect(await contentSegmentId(segment, 'round-2')).not.toBe(id)
    const cut = { ...segment, slices: segment.slices.slice(0, -1) }
    expect(await contentSegmentId(cut, 'round-1')).not.toBe(id)
  })
})
