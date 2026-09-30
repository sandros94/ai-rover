import { describe, expect, it } from 'vitest'
import { computeStopDisk, createRevealedMask, defineWorld, revealDisk } from '#shared/utils/terrain'
import {
  decodeTraceBlock,
  driveSegment,
  encodeTraceBlock,
  segmentManifestKey,
  segmentSliceKey,
  segmentTraceBlockKey,
  segmentTraceKey,
  sliceReleaseAt,
  sliceRecord,
  TRACE_BLOCK,
} from '#shared/utils/drive'
import { encodeSegment, publishSegment } from '#server/utils/journey/publish'
import { serveJourney } from '#server/utils/journey/serve'
import { createJourneyStore } from '#server/utils/journey/store'
import { MemoryBlobs } from './helpers'

const world = defineWorld({ seed: 'mars' })
const disk = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 150 })
const mask = revealDisk(createRevealedMask(world), disk)
// About 30 m: more slices than two trace blocks.
const { record } = driveSegment(world, {
  disk,
  revealed: mask,
  start: { x: 0, y: 0, headingRad: 0 },
  goal: { x: 25, y: 15 },
})
const { traces } = sliceRecord(record)
const startedAt = 1_790_000_000_000
const releaseAt = (k: number) => sliceReleaseAt(startedAt, k, 30)

/** Segment `seg-1` published, its row starting at `startedAt`; no other segment has a row. */
async function published() {
  const store = createJourneyStore({ store: new MemoryBlobs() })
  await publishSegment(store, { segment: encodeSegment(record), segmentId: 'seg-1' })
  const startOf = async (segmentId: string) => (segmentId === 'seg-1' ? startedAt : null)
  const serve = (key: string, now: number, acceptEncoding: string | null = null) =>
    serveJourney(store, key, { now, acceptEncoding, startOf })
  return { store, serve }
}

const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer())

describe('serveJourney', () => {
  it('spans more than two trace blocks', () => {
    expect(traces.length).toBeGreaterThan(2 * TRACE_BLOCK)
  })

  it('refuses a trace block, uncached, until its last trace is released', async () => {
    const { serve } = await published()
    const key = segmentTraceBlockKey('seg-1', 1)
    const early = await serve(key, releaseAt(2 * TRACE_BLOCK - 1) - 1)
    expect(early.status).toBe(404)
    expect(early.headers.get('cache-control')).toBe('no-store')
    expect(early.headers.get('x-release-at')).toBe(
      new Date(releaseAt(2 * TRACE_BLOCK - 1)).toISOString(),
    )
    // Its first traces are out singly all the while.
    expect(
      (await serve(segmentTraceKey('seg-1', TRACE_BLOCK), releaseAt(TRACE_BLOCK))).status,
    ).toBe(200)
  })

  it('serves a released block as the concatenation of its stored traces, cached for good', async () => {
    const { store, serve } = await published()
    const now = releaseAt(2 * TRACE_BLOCK - 1)
    const response = await serve(segmentTraceBlockKey('seg-1', 1), now)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('netlify-cdn-cache-control')).toContain('durable')
    expect(response.headers.get('content-encoding')).toBeNull()
    const singles = await Promise.all(
      Array.from({ length: TRACE_BLOCK }, async (_, k) =>
        bytesOf(await serve(segmentTraceKey('seg-1', TRACE_BLOCK + k), now)),
      ),
    )
    const body = await bytesOf(response)
    expect(body).toEqual(encodeTraceBlock(singles))
    expect(decodeTraceBlock(body)).toEqual(traces.slice(TRACE_BLOCK, 2 * TRACE_BLOCK))
    // Nothing new was written for it.
    expect(await store.listKeys('segments/seg-1/traces/')).not.toContain(
      segmentTraceBlockKey('seg-1', 1),
    )
  })

  it('serves the block deflated to a client that takes deflate', async () => {
    const { serve } = await published()
    const now = releaseAt(TRACE_BLOCK - 1)
    const response = await serve(segmentTraceBlockKey('seg-1', 0), now, 'gzip, deflate')
    expect(response.headers.get('content-encoding')).toBe('deflate')
    const inflated = await bytesOf(
      new Response(response.body!.pipeThrough(new DecompressionStream('deflate'))),
    )
    expect(decodeTraceBlock(inflated)).toEqual(traces.slice(0, TRACE_BLOCK))
  })

  it('answers a plain 404 for a block past the drive or a range other than a whole block', async () => {
    const { serve } = await published()
    const late = releaseAt(10 * TRACE_BLOCK)
    const past = Math.ceil(traces.length / TRACE_BLOCK)
    const beyond = await serve(segmentTraceBlockKey('seg-1', past), late)
    expect(beyond.status).toBe(404)
    expect(beyond.headers.get('x-release-at')).toBeNull()
    for (const key of ['segments/seg-1/traces/1-16.bin', 'segments/seg-1/traces/0-31.bin']) {
      expect((await serve(key, late)).status).toBe(404)
    }
  })

  it('gates slices and single traces as before', async () => {
    const { serve } = await published()
    expect((await serve(segmentSliceKey('seg-1', 3), releaseAt(3) - 1)).status).toBe(404)
    expect((await serve(segmentSliceKey('seg-1', 3), releaseAt(3))).status).toBe(200)
    expect((await serve(segmentTraceKey('seg-1', 3), releaseAt(3) - 1)).status).toBe(404)
  })

  it("releases from the row's start whatever start a stored manifest carries", async () => {
    const { store, serve } = await published()
    const key = segmentManifestKey('seg-1')
    const stored = (await store.getJson(key)) as Record<string, unknown>
    await store.putJson(key, { ...stored, startedAt: startedAt + 96_800 })
    const last = traces.length - 1
    for (const k of [0, last]) {
      expect((await serve(segmentSliceKey('seg-1', k), releaseAt(k))).status).toBe(200)
      expect((await serve(segmentTraceKey('seg-1', k), releaseAt(k))).status).toBe(200)
    }
    expect((await serve(segmentTraceBlockKey('seg-1', 0), releaseAt(TRACE_BLOCK - 1))).status).toBe(
      200,
    )
    const early = await serve(segmentSliceKey('seg-1', last), releaseAt(last) - 1)
    expect(early.headers.get('x-release-at')).toBe(new Date(releaseAt(last)).toISOString())
  })

  it('serves a segment without a row its manifest and none of its slices, traces or blocks', async () => {
    const { store, serve } = await published()
    await publishSegment(store, { segment: encodeSegment(record), segmentId: 'orphan' })
    const late = releaseAt(10 * TRACE_BLOCK)
    for (const key of [
      segmentSliceKey('orphan', 0),
      segmentTraceKey('orphan', 0),
      segmentTraceBlockKey('orphan', 0),
    ]) {
      const response = await serve(key, late)
      expect(response.status).toBe(404)
      expect(response.headers.get('x-release-at')).toBeNull()
    }
    expect((await serve(segmentManifestKey('orphan'), late)).status).toBe(200)
  })
})
