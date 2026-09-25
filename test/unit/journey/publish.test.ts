import { describe, expect, it } from 'vitest'
import {
  computeStopDisk,
  createRevealedMask,
  decodeChunk,
  decodeRevealedMask,
  defineWorld,
  encodeRevealedMask,
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
import { createJourneyStore } from '#server/utils/journey/store'
import { publishSegment, publishStop } from '#server/utils/journey/publish'
import { MemoryBlobs } from './helpers'

const world = defineWorld({ seed: 'mars' })
const disk = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 150 })
const mask = revealDisk(createRevealedMask(world), disk)

describe('publishStop', () => {
  it('writes every chunk, the mask, then the manifest', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    const result = await publishStop(store, { world, disk, mask, stopIndex: 0 })
    const hash = worldHash(world)
    const manifestKey = stopManifestKey(hash, 0)
    expect(result.manifestKey).toBe(manifestKey)
    expect(blobs.writes).toHaveLength(disk.chunks.length + 2)
    expect(blobs.writes.at(-1)).toBe(manifestKey)
    const manifest = parseStopManifest(await store.getJson(manifestKey))
    expect(blobs.writes.slice(0, -1)).toEqual([
      ...manifest.chunks.map((c) => c.key),
      manifest.revealedKey,
    ])
    const first = decodeChunk((await store.getInflated(manifest.chunks[0]!.key))!)
    expect([first.cx, first.cy]).toEqual([manifest.chunks[0]!.cx, manifest.chunks[0]!.cy])
    const storedMask = (await store.getInflated(manifest.revealedKey))!
    expect(storedMask).toEqual(encodeRevealedMask(mask))
    expect(decodeRevealedMask(storedMask).chunks.size).toBe(mask.chunks.size)
    expect(result.written.map((w) => w.key)).toEqual(blobs.writes)
    expect(result.skipped).toEqual([])
  })

  it('skips chunks already stored on a later stop', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await publishStop(store, { world, disk, mask, stopIndex: 0 })
    blobs.writes.length = 0
    const result = await publishStop(store, { world, disk, mask, stopIndex: 1 })
    const hash = worldHash(world)
    expect(result.skipped).toHaveLength(disk.chunks.length)
    expect(blobs.writes).toEqual([
      parseStopManifest(await store.getJson(stopManifestKey(hash, 1))).revealedKey,
      stopManifestKey(hash, 1),
    ])
  })
})

describe('publishSegment', () => {
  const start = { x: 0, y: 0, headingRad: 0 }
  const goal = { x: 40, y: 30 }
  const { record } = driveSegment(world, { disk, revealed: mask, start, goal })
  const { slices } = sliceRecord(record)

  it('writes the slices before the manifest, which parses with its id and start time', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    const startedAt = 1_790_000_000_000
    const result = await publishSegment(store, { record, segmentId: 'seg-1', startedAt })
    expect(result.manifestKey).toBe(segmentManifestKey('seg-1'))
    expect(blobs.writes).toEqual([
      ...slices.map((s) => segmentSliceKey('seg-1', s.index)),
      segmentManifestKey('seg-1'),
    ])
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
  })

  it('refuses a bad segment id or start time before writing anything', async () => {
    const blobs = new MemoryBlobs()
    const store = createJourneyStore({ store: blobs })
    await expect(
      publishSegment(store, { record, segmentId: '../x', startedAt: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      publishSegment(store, { record, segmentId: 'ok', startedAt: Number.NaN }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(blobs.writes).toEqual([])
  })
})
