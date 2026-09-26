import { describe, expect, it } from 'vitest'
import { computeStopDisk, defineWorld } from '#shared/utils/terrain'
import type { DriveEvent, SegmentSlice, StoredSegmentManifest } from '#shared/utils/drive'
import {
  DEFAULT_SLICE_SECONDS,
  decodeSlice,
  driveSegment,
  encodeSlice,
  KEYFRAME_STRIDE,
  MAX_SLICE_INDEX,
  parseJourneyKey,
  parseSegmentManifest,
  parseStoredSegmentManifest,
  segmentManifestKey,
  segmentSliceKey,
  SLICE_HEADER_BYTES,
  sliceGate,
  sliceRecord,
  sliceReleaseAt,
} from '#shared/utils/drive'
import { driveErrorOf, revealedAfterStop } from './helpers'

const world = defineWorld({ seed: 'mars' })
const disk = computeStopDisk(world, { center: { x: 0, y: 0 }, radius: 500 })
const start = { x: 0, y: 0, headingRad: 0 }
const goal = { x: 120, y: 90 }
const { record } = driveSegment(world, {
  disk,
  revealed: revealedAfterStop(world, disk),
  start,
  goal,
  revealRadiusM: 50,
})
const { manifest, slices } = sliceRecord(record)

function concat(parts: SegmentSlice[]) {
  const keyframes = new Float32Array(parts.reduce((n, s) => n + s.keyframes.length, 0))
  let offset = 0
  for (const s of parts) {
    keyframes.set(s.keyframes, offset)
    offset += s.keyframes.length
  }
  return {
    keyframes,
    events: parts.flatMap((s) => s.events),
    reveals: parts.flatMap((s) => s.reveals),
    outcomes: parts.flatMap((s) => (s.outcome ? [s.outcome] : [])),
  }
}

describe('sliceRecord on seed mars, 150 m', () => {
  it('spans the record in 30 s slices', () => {
    expect(DEFAULT_SLICE_SECONDS).toBe(30)
    expect(manifest.sliceSeconds).toBe(30)
    expect(manifest.keyframeHz).toBe(record.keyframes.hz)
    expect(manifest.stride).toBe(KEYFRAME_STRIDE)
    expect(slices.length).toBe(Math.floor(record.outcome.durationS / 30) + 1)
    expect(slices.length).toBeGreaterThan(2)
    slices.forEach((s, k) => expect(s.index).toBe(k))
  })

  it('reproduces keyframes, events, reveals and outcome when concatenated', () => {
    const joined = concat(slices)
    expect(joined.keyframes).toEqual(record.keyframes.data)
    expect(joined.events).toEqual(record.events)
    expect(joined.reveals).toEqual(record.reveals)
    expect(joined.outcomes).toEqual([record.outcome])
  })

  it('reproduces the record through the binary format too', () => {
    const joined = concat(slices.map((s) => decodeSlice(encodeSlice(s))))
    expect(joined.keyframes).toEqual(record.keyframes.data)
    expect(joined.events).toEqual(record.events)
    expect(joined.reveals).toEqual(record.reveals)
    expect(joined.outcomes).toEqual([record.outcome])
  })

  it('keeps every item inside its slice window, t = 0 in the first', () => {
    const S = manifest.sliceSeconds
    for (const s of slices) {
      const lo = s.index * S
      const hi = lo + S
      for (let k = 0; k < s.keyframes.length; k += KEYFRAME_STRIDE) {
        const t = s.keyframes[k]!
        expect(t).toBeGreaterThanOrEqual(lo)
        expect(t).toBeLessThan(hi)
      }
      for (const { t } of [...s.events, ...s.reveals]) {
        expect(t).toBeGreaterThanOrEqual(lo)
        expect(t).toBeLessThan(hi)
      }
    }
    expect(slices[0]!.keyframes[0]).toBe(0)
    expect(slices[1]!.keyframes[0]).toBe(30)
  })

  it('keeps the outcome out of the manifest and out of every slice but the last', () => {
    const json = JSON.stringify(manifest)
    expect(json).not.toContain('outcome')
    expect(json).not.toContain(record.outcome.kind)
    expect(manifest).not.toHaveProperty('durationS')
    expect(manifest).not.toHaveProperty('sliceCount')
    for (const s of slices.slice(0, -1)) expect(s.outcome).toBeUndefined()
    expect(slices.at(-1)!.outcome).toEqual(record.outcome)
  })

  it('carries the plan, start and goal, and parses', () => {
    expect(record.start).toEqual(start)
    expect(record.goal).toEqual(goal)
    expect(record.start).not.toBe(start)
    expect(manifest.plan.polyline).toEqual(record.plan.polyline)
    expect(manifest.plan.metrics).toEqual(record.plan.metrics)
    expect(manifest.start).toEqual(start)
    expect(manifest.goal).toEqual(goal)
    expect(parseSegmentManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
  })

  it('takes another slice length', () => {
    const { slices: coarse } = sliceRecord(record, { sliceSeconds: 60 })
    expect(coarse.length).toBe(Math.floor(record.outcome.durationS / 60) + 1)
    expect(concat(coarse).keyframes).toEqual(record.keyframes.data)
  })

  it('refuses a record whose start or goal is not finite', () => {
    const broken = { ...record, goal: { x: Number.NaN, y: 0 } }
    expect(driveErrorOf(() => sliceRecord(broken))?.code).toBe('INVALID_INPUT')
  })

  it('refuses a non-positive slice length', () => {
    for (const sliceSeconds of [0, -1, Number.NaN, Infinity]) {
      expect(driveErrorOf(() => sliceRecord(record, { sliceSeconds }))?.code).toBe('INVALID_INPUT')
    }
  })
})

describe('segment manifest schema', () => {
  it('refuses an outcome field or a wrong version', () => {
    const plain = JSON.parse(JSON.stringify(manifest))
    expect(driveErrorOf(() => parseSegmentManifest({ ...plain, version: 2 }))?.code).toBe(
      'INVALID_RECORD',
    )
    expect(
      driveErrorOf(() => parseSegmentManifest({ ...plain, outcome: record.outcome }))?.code,
    ).toBe('INVALID_RECORD')
  })

  it('stores the segment id and start time alongside', () => {
    const stored = { ...manifest, segmentId: 'seg-1', startedAt: 1_700_000_000_000 }
    expect(parseStoredSegmentManifest(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
    expect(driveErrorOf(() => parseStoredSegmentManifest(manifest))?.code).toBe('INVALID_RECORD')
    expect(
      driveErrorOf(() => parseStoredSegmentManifest({ ...stored, segmentId: '../x' }))?.code,
    ).toBe('INVALID_RECORD')
  })
})

describe('slice binary format v1', () => {
  const last = slices.at(-1)!

  it('writes the documented header', () => {
    const s = slices[1]!
    const bytes = encodeSlice(s)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(SLICE_HEADER_BYTES).toBe(23)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('JRSL')
    expect(view.getUint8(4)).toBe(1)
    expect(view.getUint8(5)).toBe(0)
    expect(view.getUint32(6, true)).toBe(1)
    expect(view.getUint32(10, true)).toBe(s.keyframes.length / KEYFRAME_STRIDE)
    const eventBytes = view.getUint32(14, true)
    const revealCount = view.getUint32(18, true)
    expect(revealCount).toBe(s.reveals.reduce((n, r) => n + r.vertices.length, 0))
    expect(view.getUint8(22)).toBe(0)
    expect(view.getFloat32(23, true)).toBe(s.keyframes[0])
    expect(bytes.byteLength).toBe(23 + s.keyframes.length * 4 + eventBytes + revealCount * 4)
    const lastView = new DataView(encodeSlice(last).buffer)
    expect(lastView.getUint8(22)).toBe(1)
  })

  it('round-trips byte-identically, also from an unaligned view', () => {
    const bytes = encodeSlice(last)
    expect(decodeSlice(bytes)).toEqual(last)
    expect(encodeSlice(decodeSlice(bytes))).toEqual(bytes)
    const padded = new Uint8Array(bytes.byteLength + 1)
    padded.set(bytes, 1)
    expect(decodeSlice(padded.subarray(1))).toEqual(last)
  })

  it('reports each malformed buffer with its code', () => {
    const bytes = encodeSlice(last)
    const code = (b: Uint8Array) => driveErrorOf(() => decodeSlice(b))?.code
    expect(code(bytes.subarray(0, 2))).toBe('TRUNCATED')
    expect(code(bytes.subarray(0, 10))).toBe('TRUNCATED')
    expect(code(bytes.subarray(0, bytes.byteLength - 1))).toBe('TRUNCATED')
    const extra = new Uint8Array(bytes.byteLength + 1)
    extra.set(bytes)
    expect(code(extra)).toBe('TRAILING_DATA')
    const magic = bytes.slice()
    magic[0] = 0x58
    expect(code(magic)).toBe('INVALID_RECORD')
    const version = bytes.slice()
    version[4] = 2
    expect(code(version)).toBe('UNSUPPORTED_VERSION')
    const flags = bytes.slice()
    flags[5] = 1
    expect(code(flags)).toBe('UNSUPPORTED_VERSION')
    const outcomeFlag = bytes.slice()
    outcomeFlag[22] = 0
    expect(code(outcomeFlag)).toBe('INVALID_RECORD')
    const json = bytes.slice()
    json[SLICE_HEADER_BYTES + last.keyframes.length * 4] = 0x7b + 1
    expect(code(json)).toBe('INVALID_RECORD')
  })

  it('carries the stop events and refuses an event type outside the set', () => {
    const events: DriveEvent[] = [
      { t: 0, type: 'turning', x: 0, y: 0, details: { angleDeg: 35, durationS: 11.5 } },
      { t: 20, type: 'imaging', x: 1, y: 0, details: { durationS: 30 } },
      { t: 60, type: 'assessing', x: 2, y: 0, details: { durationS: 20, cause: 'revealed' } },
    ]
    const stops = { ...last, events }
    expect(decodeSlice(encodeSlice(stops)).events).toEqual(stops.events)
    const paused = {
      ...last,
      events: [{ t: 0, type: 'pause', x: 0, y: 0 }],
    } as unknown as SegmentSlice
    expect(driveErrorOf(() => encodeSlice(paused))?.code).toBe('INVALID_RECORD')
  })

  it('refuses to encode a slice whose keyframes are not whole frames', () => {
    const broken = { ...last, keyframes: last.keyframes.subarray(1) }
    expect(driveErrorOf(() => encodeSlice(broken))?.code).toBe('INVALID_RECORD')
  })
})

describe('release gate', () => {
  const startedAt = Date.UTC(2026, 8, 25, 12)
  const stored: StoredSegmentManifest = { ...manifest, segmentId: 'seg-1', startedAt }

  it('releases slice k at the end of its window, startedAt + (k + 1) · sliceSeconds', () => {
    expect(sliceReleaseAt(startedAt, 0, 30)).toBe(startedAt + 30_000)
    expect(sliceReleaseAt(startedAt, 3, 30)).toBe(startedAt + 120_000)
    expect(sliceReleaseAt(startedAt, 2, 60)).toBe(startedAt + 180_000)
  })

  it('refuses a slice before its release and serves it from then on', () => {
    const at = startedAt + 90_000
    expect(sliceGate(stored, 2, at - 1)).toEqual({ released: false, releaseAt: at })
    expect(sliceGate(stored, 2, at)).toEqual({ released: true, releaseAt: at })
    expect(sliceGate(stored, 0, startedAt)).toEqual({
      released: false,
      releaseAt: startedAt + 30_000,
    })
  })

  it('serves only slices whose window has fully passed', () => {
    // 35 s after the start: slice 0 [0, 30) is over, slice 1 [30, 60) is still running.
    const now = startedAt + 35_000
    expect(sliceGate(stored, 0, now).released).toBe(true)
    expect(sliceGate(stored, 1, now).released).toBe(false)
  })

  it('refuses a bad index or time', () => {
    expect(driveErrorOf(() => sliceReleaseAt(startedAt, -1, 60))?.code).toBe('INVALID_INPUT')
    expect(driveErrorOf(() => sliceReleaseAt(startedAt, 1.5, 60))?.code).toBe('INVALID_INPUT')
    expect(driveErrorOf(() => sliceReleaseAt(Number.NaN, 1, 60))?.code).toBe('INVALID_INPUT')
    expect(driveErrorOf(() => sliceReleaseAt(startedAt, 1, 0))?.code).toBe('INVALID_INPUT')
  })
})

describe('journey keys', () => {
  it('builds segment keys from a validated id', () => {
    expect(segmentManifestKey('smoke-1')).toBe('segments/smoke-1/manifest.json')
    expect(segmentSliceKey('smoke-1', 4)).toBe('segments/smoke-1/slices/4.bin')
    for (const id of ['', 'a/b', '..', 'x'.repeat(65), 'a b']) {
      expect(driveErrorOf(() => segmentManifestKey(id))?.code).toBe('INVALID_INPUT')
    }
    expect(driveErrorOf(() => segmentSliceKey('a', -1))?.code).toBe('INVALID_INPUT')
    // At most seven digits: 30 s slices over nine years.
    expect(segmentSliceKey('a', MAX_SLICE_INDEX)).toBe('segments/a/slices/9999999.bin')
    expect(driveErrorOf(() => segmentSliceKey('a', MAX_SLICE_INDEX + 1))?.code).toBe(
      'INVALID_INPUT',
    )
  })

  it('parses only the served key shapes', () => {
    const hash = '0123456789abcdef'
    expect(parseJourneyKey(`terrain/${hash}/chunks/-3_4.bin`)).toEqual({ kind: 'terrain' })
    const mission = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
    expect(parseJourneyKey(`missions/${mission}/revealed/0.bin`)).toEqual({ kind: 'stop' })
    expect(parseJourneyKey(`missions/${mission}/stops/12.json`)).toEqual({ kind: 'stop' })
    expect(parseJourneyKey('segments/smoke-1/manifest.json')).toEqual({
      kind: 'segment-manifest',
      segmentId: 'smoke-1',
    })
    expect(parseJourneyKey('segments/smoke-1/slices/9999999.bin')).toMatchObject({
      index: 9_999_999,
    })
    expect(parseJourneyKey('segments/smoke-1/slices/7.bin')).toEqual({
      kind: 'segment-slice',
      segmentId: 'smoke-1',
      index: 7,
    })
    for (const key of [
      '',
      'other/x',
      `terrain/${hash}/../x.bin`,
      `terrain/${hash}/chunks/1_2.json`,
      'segments/../manifest.json',
      'segments/a/slices/01.bin',
      'segments/a/slices/-1.bin',
      'segments/a/other.json',
      'segments/a/slices/10000000.bin',
      'segments/a/slices/123456789012345.bin',
      `/terrain/${hash}/stops/0.json`,
      // Stops and masks were once keyed by world; those keys are no longer served.
      `terrain/${hash}/stops/0.json`,
      `terrain/${hash}/revealed/0.bin`,
      'missions/not-a-uuid/stops/0.json',
      'missions/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/stops/01.json',
      'missions/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/chunks/0_0.bin',
    ]) {
      expect(parseJourneyKey(key)).toBeNull()
    }
  })
})
