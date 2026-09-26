import { describe, expect, it } from 'vitest'
import { interpolatePose, KEYFRAME_STRIDE, sliceReleaseAt } from '#shared/utils/drive'
import { createJourneyClient, createSegmentStream, ERROR_RETRY_MS } from '#shared/utils/client'
import { journeyFixture, recordsFetch } from './helpers'

const { record, segmentManifest: manifest, slices } = journeyFixture()
const { startedAt, sliceSeconds } = manifest
const releaseAt = (k: number) => sliceReleaseAt(startedAt, k, sliceSeconds)
const last = slices.length - 1

function setup(
  options: {
    override?: (key: string) => Response | undefined
    server?: (wall: number) => number
  } = {},
) {
  let wall = startedAt
  const { server = (w) => w } = options
  const records = recordsFetch({ now: () => server(wall), override: options.override })
  const client = createJourneyClient({ fetch: records.fetch })
  const stream = createSegmentStream({ client, manifest })
  return {
    stream,
    calls: records.calls,
    poll: (ms: number) => {
      wall = ms
      return stream.poll(ms)
    },
  }
}

const sliceUrl = (k: number) => `/journey/segments/${manifest.segmentId}/slices/${k}.bin`

describe('createSegmentStream over the recorded drive', () => {
  it('spans many slices', () => {
    expect(slices.length).toBeGreaterThan(20)
  })

  it('fetches nothing before the first slice is released', async () => {
    const { stream, calls, poll } = setup()
    await poll(startedAt - 60_000)
    await poll(releaseAt(0) - 1)
    expect(calls).toEqual([])
    expect(stream.nextFetchAt).toBe(releaseAt(0))
    expect(stream.frameAt(0)).toBeUndefined()
    expect(stream.eventsUntil(1e9)).toEqual([])
    expect(stream.loadedSlices).toBe(0)
  })

  it('fetches each slice once, when it is released, in order', async () => {
    const { stream, calls, poll } = setup()
    await poll(releaseAt(0))
    await poll(releaseAt(0) + 10_000)
    expect(calls).toEqual([sliceUrl(0)])
    await poll(releaseAt(9))
    expect(calls).toEqual(Array.from({ length: 10 }, (_, k) => sliceUrl(k)))
    expect(stream.loadedSlices).toBe(10)
    expect(stream.loadedUntil).toBe(10 * sliceSeconds)
    expect(stream.nextFetchAt).toBe(releaseAt(10))
  })

  it('shares one request between overlapping polls', async () => {
    const { calls, poll } = setup()
    await Promise.all([poll(releaseAt(2)), poll(releaseAt(2)), poll(releaseAt(2))])
    expect(calls).toEqual([sliceUrl(0), sliceUrl(1), sliceUrl(2)])
  })

  it('interpolates across slice boundaries exactly as the whole record does', async () => {
    const { stream, poll } = setup()
    await poll(releaseAt(last))
    const times = [0, 0.25, 29.5, 29.75, 30, 30.1, 59.99, 60, 61.3]
    for (let t = 0; t < record.outcome.durationS + 5; t += 0.731) times.push(t)
    for (const t of times)
      expect(stream.frameAt(t), `t = ${t}`).toEqual(interpolatePose(record.keyframes, t))
  })

  it('holds the last loaded frame until the next slice arrives', async () => {
    const { stream, poll } = setup()
    await poll(releaseAt(2))
    const data = record.keyframes.data
    const frames = slices.slice(0, 3).reduce((n, s) => n + s.keyframes.length / KEYFRAME_STRIDE, 0)
    const lastT = data[(frames - 1) * KEYFRAME_STRIDE]!
    for (const t of [10, 45.3, lastT - 0.2, lastT]) {
      expect(stream.frameAt(t)).toEqual(interpolatePose(record.keyframes, t))
    }
    const held = data.slice((frames - 1) * KEYFRAME_STRIDE, frames * KEYFRAME_STRIDE)
    expect(stream.frameAt(lastT + 0.3)).toEqual(held)
    expect(stream.frameAt(500)).toEqual(held)
  })

  it('accumulates events and reveals monotonically, as the record lists them', async () => {
    const { stream, poll } = setup()
    let events = 0
    let reveals = 0
    for (let k = 0; k <= last; k++) {
      await poll(releaseAt(k))
      for (let t = k * sliceSeconds; t <= (k + 1) * sliceSeconds; t += 1.7) {
        const e = stream.eventsUntil(t)
        const r = stream.revealsUntil(t)
        expect(e).toEqual(record.events.filter((x) => x.t <= t))
        expect(r).toEqual(record.reveals.filter((x) => x.t <= t))
        expect(e.length).toBeGreaterThanOrEqual(events)
        expect(r.length).toBeGreaterThanOrEqual(reveals)
        events = e.length
        reveals = r.length
      }
    }
    expect(stream.eventsUntil(Infinity)).toEqual(record.events)
    expect(stream.revealsUntil(Infinity)).toEqual(record.reveals)
  })

  it('loads the outcome only with the last slice, then fetches nothing more', async () => {
    const { stream, calls, poll } = setup()
    await poll(releaseAt(last - 1))
    expect(stream.outcome).toBeUndefined()
    expect(stream.done).toBe(false)
    await poll(releaseAt(last))
    expect(stream.outcome).toEqual(record.outcome)
    expect(stream.done).toBe(true)
    expect(stream.nextFetchAt).toBeUndefined()
    const before = calls.length
    await poll(releaseAt(last + 50))
    expect(calls.length).toBe(before)
  })

  it('gates the outcome on sim time: undefined before the record ends, defined from its end', async () => {
    const { stream, poll } = setup()
    const end = record.outcome.durationS
    await poll(releaseAt(last - 1))
    expect(stream.outcomeAt(end)).toBeUndefined()
    expect(stream.outcomeAt(Infinity)).toBeUndefined()
    await poll(releaseAt(last))
    expect(stream.outcome).toEqual(record.outcome)
    for (const t of [0, end / 2, end - 0.5, end - 1e-9]) {
      expect(stream.outcomeAt(t), `t = ${t}`).toBeUndefined()
    }
    for (const t of [end, end + 1e-9, end + 30, Infinity]) {
      expect(stream.outcomeAt(t), `t = ${t}`).toEqual(record.outcome)
    }
  })

  it('retries a not-yet at the release time the server names, not before, never caching it', async () => {
    let refuse = true
    const { stream, calls, poll } = setup({
      override: (key) => {
        if (!refuse || !key.endsWith('/slices/0.bin')) return undefined
        return new Response(null, {
          status: 404,
          headers: { 'x-release-at': new Date(releaseAt(0) + 5000).toISOString() },
        })
      },
    })
    await poll(releaseAt(0))
    expect(calls).toEqual([sliceUrl(0)])
    expect(stream.nextFetchAt).toBe(releaseAt(0) + 5000)
    await poll(releaseAt(0) + 4999)
    expect(calls.length).toBe(1)
    refuse = false
    await poll(releaseAt(0) + 5000)
    expect(calls).toEqual([sliceUrl(0), sliceUrl(0)])
    expect(stream.loadedSlices).toBe(1)
  })

  it('waits at least a second when a server behind the client names a time already past', async () => {
    const { stream, calls, poll } = setup({ server: (wall) => wall - 10_000 })
    await poll(releaseAt(0))
    expect(calls.length).toBe(1)
    expect(stream.nextFetchAt).toBe(releaseAt(0) + 1000)
    await poll(releaseAt(0) + 999)
    expect(calls.length).toBe(1)
    await poll(releaseAt(0) + 1000)
    expect(calls.length).toBe(2)
    await poll(releaseAt(0) + 10_000)
    expect(stream.loadedSlices).toBe(1)
  })

  it('rejects with NOT_FOUND when a released slice is missing before the outcome', async () => {
    const { stream, poll } = setup({
      override: (key) =>
        key.endsWith('/slices/2.bin') ? new Response(null, { status: 404 }) : undefined,
    })
    await expect(poll(releaseAt(4))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(stream.loadedSlices).toBe(2)
  })

  it('waits before asking again after a failed request', async () => {
    let fail = true
    const { stream, calls, poll } = setup({
      override: (key) =>
        fail && key.endsWith('/slices/1.bin') ? new Response(null, { status: 503 }) : undefined,
    })
    const wall = releaseAt(1)
    await expect(poll(wall)).rejects.toMatchObject({ code: 'NETWORK' })
    expect(stream.loadedSlices).toBe(1)
    expect(stream.nextFetchAt).toBe(wall + ERROR_RETRY_MS)
    await poll(wall + 16)
    expect(calls).toEqual([sliceUrl(0), sliceUrl(1)])
    fail = false
    await poll(wall + ERROR_RETRY_MS)
    expect(calls).toEqual([sliceUrl(0), sliceUrl(1), sliceUrl(1)])
    expect(stream.loadedSlices).toBe(2)
  })
})
