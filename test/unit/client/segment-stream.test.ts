import { describe, expect, it } from 'vitest'
import type { StoredSegmentManifest } from '#shared/utils/drive'
import {
  interpolatePose,
  KEYFRAME_STRIDE,
  segmentSliceKey,
  segmentTraceBlockKey,
  sliceReleaseAt,
  TRACE_BLOCK,
} from '#shared/utils/drive'
import {
  createJourneyClient,
  createSegmentStream,
  DEFAULT_LIVE_MARGIN_SECONDS,
  ERROR_RETRY_MS,
} from '#shared/utils/client'
import { encodeLegacySlice } from '../drive/helpers'
import { JOURNEY_FIXTURE, journeyFixture, recordsFetch } from './helpers'

const { record, segmentManifest: manifest, slices, traces } = journeyFixture()
const { sliceSeconds, segmentId } = manifest
const { startedAt } = JOURNEY_FIXTURE
const releaseAt = (k: number) => sliceReleaseAt(startedAt, k, sliceSeconds)
const last = slices.length - 1
/** The live edge at `wall`, as the playback clock places it. */
const liveAt = (wall: number) =>
  Math.max(0, (wall - startedAt) / 1000 - sliceSeconds - DEFAULT_LIVE_MARGIN_SECONDS)

function setup(
  options: {
    override?: (key: string) => Response | undefined
    server?: (wall: number) => number
    endsAt?: number
    manifest?: StoredSegmentManifest
  } = {},
) {
  let wall = startedAt
  const { server = (w) => w } = options
  const records = recordsFetch({ now: () => server(wall), override: options.override })
  const client = createJourneyClient({ fetch: records.fetch })
  const stream = createSegmentStream({
    client,
    manifest: options.manifest ?? manifest,
    startedAt,
    endsAt: options.endsAt,
  })
  return {
    stream,
    calls: records.calls,
    /** Polls at `ms` for `sim`, the live edge by default. */
    poll: (ms: number, sim = liveAt(ms)) => {
      wall = ms
      return stream.poll(ms, sim)
    },
  }
}

const sliceUrl = (k: number) => `/journey/segments/${segmentId}/slices/${k}.bin`
const traceUrl = (k: number) => `/journey/segments/${segmentId}/traces/${k}.bin`
const blockUrl = (b: number) => `/journey/${segmentTraceBlockKey(segmentId, b)}`
/** Traces `0 … end − 1` as a first load asks for them: whole blocks, then the rest one by one. */
const tracesUpTo = (end: number) => {
  const blocks = Math.floor(end / TRACE_BLOCK)
  return [...range(0, blocks).map(blockUrl), ...range(blocks * TRACE_BLOCK, end).map(traceUrl)]
}
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k)
/** The values of slices `from … to − 1` back to back. */
const framesOf = (from: number, to: number) =>
  slices.slice(from, to).flatMap((s) => Array.from(s.keyframes))
const sorted = (urls: string[]) => [...urls].sort()

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
    expect(stream.window).toBeUndefined()
    expect(stream.totals).toBeUndefined()
    expect(stream.frameAt(0)).toBeUndefined()
    expect(stream.eventsUntil(1e9)).toEqual([])
  })

  it('opens at live: the slice playback shows, and the traces up to it in whole blocks first', async () => {
    const { stream, calls, poll } = setup()
    const wall = releaseAt(20) + 6000
    const sim = liveAt(wall)
    expect(Math.floor(sim / sliceSeconds)).toBe(20)
    await poll(wall)
    expect(sorted(calls)).toEqual(sorted([sliceUrl(20), ...tracesUpTo(21)]))
    expect(calls).toHaveLength(7)
    expect(stream.window).toEqual({ start: 20, end: 21 })
    expect(stream.loadedFrom).toBe(20 * sliceSeconds)
    expect(stream.totals).toEqual(slices[20]!.totals)
    expect(stream.frameAt(sim)).toEqual(interpolatePose(record.keyframes, sim))
    expect(Array.from(stream.keyframesUntil(Infinity).data)).toEqual(framesOf(20, 21))
    expect(stream.eventsUntil(Infinity)).toEqual(slices[20]!.events)
    expect(stream.revealsUntil(Infinity)).toEqual(traces.slice(0, 21).flatMap((t) => t.reveals))
    expect(Array.from(stream.pathBefore)).toEqual(
      traces.slice(0, 20).flatMap((t) => Array.from(t.path)),
    )
  })

  it('gives no frame from a live slice in before its traces: frames come with every reveal up to them', async () => {
    const wall = releaseAt(20) + 6000
    const records = recordsFetch({ now: () => wall })
    const traced = Promise.withResolvers<void>()
    const slice = Promise.withResolvers<void>()
    const client = createJourneyClient({
      fetch: async (input: string) => {
        if (input.includes('/traces/')) await traced.promise
        const response = await records.fetch(input)
        if (input.includes('/slices/')) slice.resolve()
        return response
      },
    })
    const stream = createSegmentStream({ client, manifest, startedAt })
    const sim = liveAt(wall)
    const polled = stream.poll(wall, sim)
    await slice.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stream.frameAt(sim)).toBeUndefined()
    expect(stream.revealsUntil(Infinity)).toEqual([])
    traced.resolve()
    await polled
    expect(stream.frameAt(sim)).toEqual(interpolatePose(record.keyframes, sim))
    expect(stream.revealsUntil(sim)).toEqual(record.reveals.filter((group) => group.t <= sim))
  })

  it('opens a settled drive at its last slice alone, the outcome with it', async () => {
    const { stream, calls, poll } = setup({ endsAt: releaseAt(last) })
    await poll(releaseAt(last) + 3_600_000)
    expect(sorted(calls)).toEqual(sorted([sliceUrl(last), ...tracesUpTo(last + 1)]))
    expect(calls).toHaveLength(9)
    expect(stream.window).toEqual({ start: last, end: last + 1 })
    expect(stream.done).toBe(true)
    expect(stream.outcomeAt(Infinity)).toEqual(record.outcome)
    expect(stream.revealsUntil(Infinity)).toEqual(record.reveals)
    const end = record.outcome.durationS
    expect(stream.frameAt(end + 100)).toEqual(interpolatePose(record.keyframes, end))
  })

  it('follows each release forward, asking for every slice and trace once', async () => {
    const { stream, calls, poll } = setup()
    await poll(releaseAt(9))
    expect(stream.window).toEqual({ start: 8, end: 10 })
    const opened = calls.length
    await poll(releaseAt(9) + 10_000)
    expect(calls.length).toBe(opened)
    await poll(releaseAt(12))
    expect(sorted(calls.slice(opened))).toEqual(
      sorted(range(10, 13).flatMap((k) => [sliceUrl(k), traceUrl(k)])),
    )
    expect(stream.window).toEqual({ start: 8, end: 13 })
    expect(stream.loadedUntil).toBe(13 * sliceSeconds)
    expect(stream.nextFetchAt).toBe(releaseAt(13))
    expect(new Set(calls).size).toBe(calls.length)
  })

  it('scrubs back by loading the missing range once, keeping the window contiguous', async () => {
    const { stream, calls, poll } = setup()
    const wall = releaseAt(15) + 6000
    await poll(wall)
    expect(stream.window).toEqual({ start: 15, end: 16 })
    const before = stream.keyframesUntil(Infinity)
    const opened = calls.length
    await poll(wall + 16, 125)
    await poll(wall + 32, 125)
    expect(sorted(calls.slice(opened))).toEqual(sorted(range(4, 15).map(sliceUrl)))
    expect(stream.window).toEqual({ start: 4, end: 16 })
    expect(stream.totals).toEqual(slices[4]!.totals)
    expect(stream.pathBefore).toHaveLength(
      traces.slice(0, 4).reduce((n, t) => n + t.path.length, 0),
    )
    const frames = stream.keyframesUntil(Infinity)
    expect(frames).not.toBe(before)
    expect(Array.from(frames.data)).toEqual(framesOf(4, 16))
    expect(stream.eventsUntil(Infinity)).toEqual(slices.slice(4, 16).flatMap((s) => s.events))
    // Away from the window's first frame, whose tangents lack the frame before it.
    for (let t = 4 * sliceSeconds + 1; t < 16 * sliceSeconds - 1; t += 3.7) {
      expect(stream.frameAt(t), `t = ${t}`).toEqual(interpolatePose(record.keyframes, t))
    }
  })

  it('never asks for a slice or trace before its release, nor twice', async () => {
    const { calls, poll } = setup()
    const asked: [string, number][] = []
    for (let wall = startedAt; wall <= releaseAt(last) + 60_000; wall += 7_000) {
      const from = calls.length
      // Live at first, then a scrub back to the start.
      await poll(wall, wall > releaseAt(20) ? 10 : liveAt(wall))
      for (const url of calls.slice(from)) asked.push([url, wall])
    }
    expect(asked.length).toBe(2 * slices.length)
    for (const [url, wall] of asked) {
      const k = Number(/\/(\d+)\.bin$/.exec(url)![1])
      expect(releaseAt(k), `${url}`).toBeLessThanOrEqual(wall)
    }
    expect(new Set(asked.map(([url]) => url)).size).toBe(asked.length)
  })

  it('shares one pass between overlapping polls', async () => {
    const { calls, poll } = setup()
    await Promise.all([poll(releaseAt(2), 0), poll(releaseAt(2), 0), poll(releaseAt(2), 0)])
    expect(sorted(calls)).toEqual(sorted(range(0, 3).flatMap((k) => [sliceUrl(k), traceUrl(k)])))
  })

  it('interpolates across slice boundaries exactly as the whole record does', async () => {
    const { stream, poll } = setup()
    await poll(releaseAt(last), 0)
    const times = [0, 0.25, 29.5, 29.75, 30, 30.1, 59.99, 60, 61.3]
    for (let t = 0; t < record.outcome.durationS + 5; t += 0.731) times.push(t)
    for (const t of times)
      expect(stream.frameAt(t), `t = ${t}`).toEqual(interpolatePose(record.keyframes, t))
  })

  it('returns the same block while the window and the frames reached stay the same', async () => {
    const { stream, poll } = setup()
    await poll(releaseAt(1), 0)
    const block = stream.keyframesUntil(20)
    expect(stream.keyframesUntil(20.1)).toBe(block)
    await poll(releaseAt(2), 0)
    expect(stream.keyframesUntil(20.2)).toBe(block)
    expect(stream.keyframesUntil(40)).not.toBe(block)
    expect(stream.keyframesUntil(40).count).toBeGreaterThan(block.count)
  })

  it('reads events from the window and reveals from the first slice, as the record lists them', async () => {
    const { stream, poll } = setup()
    await poll(releaseAt(10), 160)
    expect(stream.window).toEqual({ start: 5, end: 11 })
    for (let t = 150; t <= 11 * sliceSeconds; t += 1.7) {
      expect(stream.eventsUntil(t)).toEqual(record.events.filter((e) => e.t >= 150 && e.t <= t))
      expect(stream.revealsUntil(t)).toEqual(record.reveals.filter((r) => r.t <= t))
    }
  })

  it('asks for no slice past the outcome of a drive whose end is known, however late it polls', async () => {
    const { stream, calls, poll } = setup({ endsAt: releaseAt(last) })
    await poll(releaseAt(last) + 60 * 60_000, 0)
    expect(sorted(calls.filter((url) => url.includes('/slices/')))).toEqual(
      sorted(range(0, last + 1).map(sliceUrl)),
    )
    expect(stream.outcome).toEqual(record.outcome)
    expect(stream.done).toBe(true)
    expect(stream.nextFetchAt).toBeUndefined()
    const before = calls.length
    await poll(releaseAt(last + 50), 0)
    expect(calls.length).toBe(before)
  })

  it('rejects with NOT_FOUND when no slice up to the known end holds the outcome', async () => {
    const { stream, calls, poll } = setup({ endsAt: releaseAt(last - 1) })
    await expect(poll(releaseAt(last) + 60_000)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(stream.window?.end).toBe(last)
    expect(calls).not.toContain(sliceUrl(last))
  })

  it('gates the outcome on sim time: undefined before the record ends, defined from its end', async () => {
    const { stream, poll } = setup()
    const end = record.outcome.durationS
    await poll(releaseAt(last - 1))
    expect(stream.outcomeAt(end)).toBeUndefined()
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
    expect(sorted(calls)).toEqual(sorted([sliceUrl(0), traceUrl(0)]))
    expect(stream.nextFetchAt).toBe(releaseAt(0) + 5000)
    await poll(releaseAt(0) + 4999)
    expect(calls).toHaveLength(2)
    refuse = false
    await poll(releaseAt(0) + 5000)
    expect(calls.slice(2)).toEqual([sliceUrl(0)])
    expect(stream.window).toEqual({ start: 0, end: 1 })
  })

  it('waits at least a second when a server behind the client names a time already past', async () => {
    const { stream, calls, poll } = setup({ server: (wall) => wall - 10_000 })
    await poll(releaseAt(0))
    expect(calls).toHaveLength(2)
    expect(stream.nextFetchAt).toBe(releaseAt(0) + 1000)
    await poll(releaseAt(0) + 999)
    expect(calls).toHaveLength(2)
    await poll(releaseAt(0) + 1000)
    expect(calls).toHaveLength(4)
    await poll(releaseAt(0) + 10_000)
    expect(stream.window).toEqual({ start: 0, end: 1 })
  })

  it('rejects with NOT_FOUND when a released slice or trace is missing', async () => {
    for (const missing of ['/slices/2.bin', '/traces/2.bin']) {
      const { stream, poll } = setup({
        override: (key) =>
          key.endsWith(missing) ? new Response(null, { status: 404 }) : undefined,
      })
      await expect(poll(releaseAt(4), 0)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(stream.window).toEqual({ start: 0, end: 2 })
    }
  })

  it('waits before asking again after a failed request', async () => {
    let fail = true
    const { stream, calls, poll } = setup({
      override: (key) =>
        fail && key.endsWith('/slices/1.bin') ? new Response(null, { status: 503 }) : undefined,
    })
    const wall = releaseAt(1)
    await expect(poll(wall, 0)).rejects.toMatchObject({ code: 'NETWORK' })
    expect(stream.window).toEqual({ start: 0, end: 1 })
    expect(stream.nextFetchAt).toBe(wall + ERROR_RETRY_MS)
    const failed = calls.length
    await poll(wall + 16, 0)
    expect(calls).toHaveLength(failed)
    fail = false
    await poll(wall + ERROR_RETRY_MS, 0)
    expect(calls.slice(failed)).toEqual([sliceUrl(1)])
    expect(stream.window).toEqual({ start: 0, end: 2 })
  })

  it('refuses a playback time that is not a number', () => {
    const { poll } = setup()
    expect(() => poll(releaseAt(1), Number.NaN)).toThrow(/not a number/)
  })
})

describe('createSegmentStream over a segment published before totals', () => {
  // The same drive as manifest version 2 published it: reveals inside the slices, no traces.
  const legacy: StoredSegmentManifest = { ...manifest, version: 2 }
  const override = (key: string) => {
    const k = slices.findIndex((s) => segmentSliceKey(segmentId, s.index) === key)
    if (k < 0) return undefined
    const bytes = encodeLegacySlice(slices[k]!, traces[k]!.reveals, 2)
    return new Response(bytes as Uint8Array<ArrayBuffer>)
  }

  it('opens at the first slice whatever playback shows, asking for no trace', async () => {
    const { stream, calls, poll } = setup({ manifest: legacy, override })
    await poll(releaseAt(12))
    expect(sorted(calls)).toEqual(sorted(range(0, 13).map(sliceUrl)))
    expect(stream.window).toEqual({ start: 0, end: 13 })
    expect(stream.totals).toEqual({ groundM: 0, wheelRad: 0, slipTrail: [], status: null })
    expect(stream.pathBefore).toHaveLength(0)
    expect(stream.revealsUntil(Infinity)).toEqual(
      record.reveals.filter((r) => r.t < 13 * sliceSeconds),
    )
    const sim = liveAt(releaseAt(12))
    expect(stream.frameAt(sim)).toEqual(interpolatePose(record.keyframes, sim))
    expect(stream.keyframesUntil(Infinity).count * KEYFRAME_STRIDE).toBe(framesOf(0, 13).length)
  })
})

describe('createSegmentStream over a stored manifest stamped with a later start', () => {
  // A manifest rewritten by a run that prepared the drive after the one that started it: its own
  // start 96.8 s after the segment row's, the start the server releases slices from.
  const skewed = startedAt + 96_800
  const override = (key: string) =>
    key === `segments/${segmentId}/manifest.json`
      ? Response.json({ ...manifest, startedAt: skewed })
      : undefined

  it("plays from the state's start and loads every slice up to `endsAt`, the outcome included", async () => {
    let wall = startedAt
    const records = recordsFetch({ now: () => wall, override })
    const client = createJourneyClient({ fetch: records.fetch })
    const loaded = await client.getSegmentManifest(segmentId)
    expect(loaded).not.toHaveProperty('startedAt')
    expect(loaded).toEqual(manifest)
    const endsAt = releaseAt(last)
    const stream = createSegmentStream({ client, manifest: loaded, startedAt, endsAt })
    for (wall = startedAt; wall <= endsAt + 10_000; wall += 5_000) {
      await stream.poll(wall, liveAt(wall))
    }
    expect(stream.window).toEqual({ start: expect.any(Number), end: slices.length })
    expect(stream.done).toBe(true)
    expect(stream.outcome).toEqual(record.outcome)
    expect(stream.outcome?.kind).toBe('arrived')
    expect(stream.eventsUntil(Infinity).at(-1)?.type).toBe('arrived')
    expect(records.calls).toContain(sliceUrl(last))
  })
})
