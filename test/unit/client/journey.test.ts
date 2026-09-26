import { describe, expect, it } from 'vitest'
import { segmentSliceKey } from '#shared/utils/drive'
import { ClientError, createJourneyClient } from '#shared/utils/client'
import { JOURNEY_FIXTURE, journeyFixture, readRecord, recordsFetch } from './helpers'

const { missionId, stopIndex, segmentId, startedAt } = JOURNEY_FIXTURE

async function clientErrorOf(promise: Promise<unknown>): Promise<ClientError | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ClientError) return error
  }
  return undefined
}

describe('recorded journey fixture', () => {
  it('matches the generator byte for byte', () => {
    const { files } = journeyFixture()
    expect(files.size).toBe(40)
    for (const [key, bytes] of files)
      expect({ key, bytes: readRecord(key) }).toEqual({ key, bytes })
  })
})

describe('createJourneyClient over the recorded journey', () => {
  const fixture = journeyFixture()

  it('decodes the stop manifest', async () => {
    const { fetch, calls } = recordsFetch()
    const client = createJourneyClient({ fetch })
    expect(await client.getStopManifest(missionId, stopIndex)).toEqual(fixture.stopManifest)
    expect(calls).toEqual([`/journey/missions/${missionId}/stops/0.json`])
  })

  it('decodes the revealed mask', async () => {
    const client = createJourneyClient({ fetch: recordsFetch().fetch })
    expect(await client.getRevealedMask(missionId, stopIndex)).toEqual(fixture.mask)
  })

  it('decodes every chunk the manifest lists', async () => {
    const client = createJourneyClient({ fetch: recordsFetch().fetch })
    const { worldHash, chunks } = fixture.stopManifest
    expect(chunks.length).toBe(4)
    for (const { cx, cy } of chunks) {
      const chunk = await client.getChunk(worldHash, cx, cy)
      expect(chunk.cx).toBe(cx)
      expect(chunk.cy).toBe(cy)
      const { heights, masks } = chunkOf(cx, cy)
      expect(chunk.heights).toEqual(heights)
      expect(chunk.masks).toEqual(masks)
    }
  })

  it('decodes the segment manifest and every slice once released', async () => {
    const client = createJourneyClient({ fetch: recordsFetch().fetch })
    expect(await client.getSegmentManifest(segmentId)).toEqual(fixture.segmentManifest)
    for (const slice of fixture.slices) {
      expect(await client.getSlice(segmentId, slice.index)).toEqual({ status: 'ready', slice })
    }
  })

  it('answers not-yet with the release time on a 404 carrying x-release-at', async () => {
    const { fetch } = recordsFetch({ now: () => startedAt + 45_000 })
    const client = createJourneyClient({ fetch })
    expect((await client.getSlice(segmentId, 0)).status).toBe('ready')
    expect(await client.getSlice(segmentId, 1)).toEqual({
      status: 'not-yet',
      releaseAt: startedAt + 60_000,
    })
  })

  it('answers missing on a plain 404', async () => {
    const client = createJourneyClient({ fetch: recordsFetch().fetch })
    expect(await client.getSlice(segmentId, fixture.slices.length)).toEqual({ status: 'missing' })
  })

  it('refuses a missing manifest, mask or chunk with NOT_FOUND', async () => {
    const client = createJourneyClient({ fetch: recordsFetch().fetch })
    const { worldHash } = fixture.stopManifest
    expect((await clientErrorOf(client.getStopManifest(missionId, 9)))?.code).toBe('NOT_FOUND')
    expect((await clientErrorOf(client.getRevealedMask(missionId, 9)))?.code).toBe('NOT_FOUND')
    expect((await clientErrorOf(client.getChunk(worldHash, 40, 40)))?.code).toBe('NOT_FOUND')
    expect((await clientErrorOf(client.getSegmentManifest('nope')))?.code).toBe('NOT_FOUND')
  })

  it('refuses garbage with DECODE, the decoder error as cause', async () => {
    const garbage = () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    const client = createJourneyClient({ fetch: recordsFetch({ override: garbage }).fetch })
    const { worldHash } = fixture.stopManifest
    for (const promise of [
      client.getStopManifest(missionId, stopIndex),
      client.getRevealedMask(missionId, stopIndex),
      client.getChunk(worldHash, 0, 0),
      client.getSegmentManifest(segmentId),
      client.getSlice(segmentId, 0),
    ]) {
      const error = await clientErrorOf(promise)
      expect(error?.code).toBe('DECODE')
      expect(error?.cause).toBeInstanceOf(Error)
    }
  })

  it('refuses a blob that decodes to other coordinates or another index with DECODE', async () => {
    const { worldHash } = fixture.stopManifest
    const client = createJourneyClient({
      fetch: recordsFetch({
        override: (key) => {
          if (key.endsWith('chunks/0_0.bin'))
            return new Response(readRecord(key.replace('0_0', '-1_0')) as Uint8Array<ArrayBuffer>)
          if (key === segmentSliceKey(segmentId, 1))
            return new Response(
              readRecord(segmentSliceKey(segmentId, 2)) as Uint8Array<ArrayBuffer>,
            )
          return undefined
        },
      }).fetch,
    })
    expect((await clientErrorOf(client.getChunk(worldHash, 0, 0)))?.code).toBe('DECODE')
    expect((await clientErrorOf(client.getSlice(segmentId, 1)))?.code).toBe('DECODE')
  })

  it('refuses a 404 whose x-release-at is not a date with DECODE', async () => {
    const client = createJourneyClient({
      fetch: recordsFetch({
        override: () => new Response(null, { status: 404, headers: { 'x-release-at': 'soon' } }),
      }).fetch,
    })
    expect((await clientErrorOf(client.getSlice(segmentId, 0)))?.code).toBe('DECODE')
  })

  it('reports a rejected fetch or a server error as NETWORK', async () => {
    const offline = createJourneyClient({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    })
    const error = await clientErrorOf(offline.getSegmentManifest(segmentId))
    expect(error?.code).toBe('NETWORK')
    expect(error?.cause).toBeInstanceOf(TypeError)
    const failing = createJourneyClient({
      fetch: async () => new Response('boom', { status: 502 }),
    })
    expect((await clientErrorOf(failing.getSlice(segmentId, 0)))?.code).toBe('NETWORK')
  })

  it('requests under another base URL', async () => {
    const calls: string[] = []
    const client = createJourneyClient({
      baseUrl: 'https://cdn.example/journey/',
      fetch: async (input) => {
        calls.push(input)
        return new Response(null, { status: 404 })
      },
    })
    await client.getSlice(segmentId, 3)
    expect(calls).toEqual([`https://cdn.example/journey/segments/${segmentId}/slices/3.bin`])
  })
})

function chunkOf(cx: number, cy: number) {
  const { disk } = journeyFixture()
  const cells = 64
  const vertexCount = cells + 1
  const { width } = disk.grid
  const heights = new Float32Array(vertexCount * vertexCount)
  const masks = new Uint8Array(vertexCount * vertexCount)
  const gi = cx * cells - disk.origin.i
  const gj = cy * cells - disk.origin.j
  for (let b = 0; b < vertexCount; b++) {
    for (let a = 0; a < vertexCount; a++) {
      const k = (gj + b) * width + gi + a
      heights[b * vertexCount + a] = disk.grid.heights[k]!
      masks[b * vertexCount + a] = disk.traversable[k]!
    }
  }
  return { heights, masks }
}
