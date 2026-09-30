import { describe, expect, it } from 'vitest'
import { computeStopDisk, defineWorld } from '#shared/utils/terrain'
import type {
  DriveEvent,
  SegmentSlice,
  SliceTrace,
  StoredSegmentManifest,
  WrittenSlice,
} from '#shared/utils/drive'
import {
  DEFAULT_SLICE_SECONDS,
  decodeSlice,
  decodeTrace,
  decodeTraceBlock,
  driveSegment,
  encodeSlice,
  encodeTrace,
  encodeTraceBlock,
  frameOdometry,
  KEYFRAME_STRIDE,
  MAX_SLICE_INDEX,
  parseJourneyKey,
  parseSegmentManifest,
  parseStoredSegmentManifest,
  segmentManifestKey,
  segmentSliceKey,
  segmentTraceBlockKey,
  segmentTraceKey,
  SLICE_HEADER_BYTES,
  sliceGate,
  sliceRecord,
  sliceReleaseAt,
  TRACE_BLOCK,
  TRACE_BLOCK_HEADER_BYTES,
  TRACE_HEADER_BYTES,
  TRACE_PATH_SECONDS,
} from '#shared/utils/drive'
import { driveErrorOf, encodeLegacySlice, revealedAfterStop } from './helpers'

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
const { manifest, slices, traces } = sliceRecord(record)

function concat(parts: SegmentSlice[], traced: SliceTrace[] = []) {
  const keyframes = new Float32Array(parts.reduce((n, s) => n + s.keyframes.length, 0))
  let offset = 0
  for (const s of parts) {
    keyframes.set(s.keyframes, offset)
    offset += s.keyframes.length
  }
  return {
    keyframes,
    events: parts.flatMap((s) => s.events),
    reveals: traced.flatMap((t) => t.reveals),
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

  it('reproduces keyframes, events and outcome from the slices, the reveals from the traces', () => {
    expect(traces.filter((t) => t.reveals.length > 0).length).toBeGreaterThan(traces.length / 2)
    expect(traces.map((t) => t.index)).toEqual(slices.map((s) => s.index))
    const joined = concat(slices, traces)
    expect(joined.keyframes).toEqual(record.keyframes.data)
    expect(joined.events).toEqual(record.events)
    expect(joined.reveals).toEqual(record.reveals)
    expect(joined.outcomes).toEqual([record.outcome])
    for (const slice of slices) expect(slice).not.toHaveProperty('reveals')
  })

  it('reproduces the record through the binary formats too', () => {
    const joined = concat(
      slices.map((s) => decodeSlice(encodeSlice(s))),
      traces.map((t) => decodeTrace(encodeTrace(t))),
    )
    expect(joined.keyframes).toEqual(record.keyframes.data)
    expect(joined.events).toEqual(record.events)
    expect(joined.reveals).toEqual(record.reveals)
    expect(joined.outcomes).toEqual([record.outcome])
  })

  it('keeps in each trace a path point every few seconds and the last frame of its slice', () => {
    const every = TRACE_PATH_SECONDS * record.keyframes.hz
    for (const [k, slice] of slices.entries()) {
      const frames = slice.keyframes.length / KEYFRAME_STRIDE
      const expected: number[] = []
      for (let f = 0; f < frames; f++) {
        const at = f * KEYFRAME_STRIDE
        if (
          Math.round(slice.keyframes[at]! * record.keyframes.hz) % every !== 0 &&
          f !== frames - 1
        )
          continue
        expected.push(...slice.keyframes.subarray(at, at + 4))
      }
      expect(Array.from(traces[k]!.path), `slice ${k}`).toEqual(expected)
    }
  })

  it('opens each slice with the running totals of the frames and events before it', () => {
    const odometry = frameOdometry(record.keyframes)
    let frames = 0
    for (const slice of slices) {
      const start = slice.index * manifest.sliceSeconds
      const { totals } = slice
      expect(totals.groundM).toBe(odometry.groundM[frames])
      expect(totals.wheelRad).toBe(odometry.wheelRad[frames])
      const before = record.events.filter((e) => e.t < start)
      expect(totals.status === null).toBe(before.length === 0)
      expect(totals.status?.t ?? -1).toBeLessThan(start)
      const replans = before.filter((e) => e.type === 'replan')
      expect(totals.route).toEqual(replans.at(-1)?.details?.polyline)
      // The trail reaches a whole window back once the drive has covered one.
      const [ground] = totals.slipTrail[0] ?? [0]
      expect(ground >= 1 || totals.groundM <= 1.05).toBe(true)
      frames += slice.keyframes.length / KEYFRAME_STRIDE
    }
    expect(slices[0]!.totals).toEqual({ groundM: 0, wheelRad: 0, slipTrail: [], status: null })
  })

  it('carries the route of the latest replan from the slice after it on', () => {
    const route = [
      { x: 1, y: 2 },
      { x: 40, y: 50 },
    ]
    const replan: DriveEvent = { t: 75, type: 'replan', x: 1, y: 2, details: { polyline: route } }
    const events = [
      ...record.events.filter((e) => e.t < 75),
      replan,
      ...record.events.filter((e) => e.t >= 75),
    ]
    const { slices: replanned } = sliceRecord({ ...record, events })
    expect(replanned[2]!.totals.route).toBeUndefined()
    expect(replanned[2]!.events).toContainEqual(replan)
    const next = events.find((e) => e.type === 'replan' && e.t > 75)?.t ?? Infinity
    const held = replanned.filter((slice) => slice.index >= 3 && slice.index * 30 <= next)
    expect(held.length).toBeGreaterThan(0)
    for (const slice of held) expect(slice.totals.route).toEqual(route)
  })

  it('keeps every item inside its slice window, t = 0 in the first', () => {
    const S = manifest.sliceSeconds
    for (const [n, s] of slices.entries()) {
      const lo = s.index * S
      const hi = lo + S
      for (let k = 0; k < s.keyframes.length; k += KEYFRAME_STRIDE) {
        const t = s.keyframes[k]!
        expect(t).toBeGreaterThanOrEqual(lo)
        expect(t).toBeLessThan(hi)
      }
      const path = traces[n]!.path.filter((_, k) => k % 4 === 0)
      for (const { t } of [
        ...s.events,
        ...traces[n]!.reveals,
        ...Array.from(path, (t) => ({ t })),
      ]) {
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
  it('states the layout: version 3 with stride 23, totals and traces', () => {
    expect(manifest.version).toBe(3)
    expect(manifest.stride).toBe(23)
  })

  it('reads version 1 and 2 manifests and refuses a stride a version does not state', () => {
    const plain = JSON.parse(JSON.stringify(manifest))
    expect(parseSegmentManifest({ ...plain, version: 1, stride: 19 })).toMatchObject({
      version: 1,
      stride: 19,
    })
    expect(parseSegmentManifest({ ...plain, version: 2 })).toMatchObject({ version: 2, stride: 23 })
    for (const [version, stride] of [
      [1, 23],
      [2, 19],
      [3, 19],
    ]) {
      expect(driveErrorOf(() => parseSegmentManifest({ ...plain, version, stride }))?.code).toBe(
        'INVALID_RECORD',
      )
    }
    const stored = { ...plain, version: 1, stride: 19, segmentId: 'seg-1' }
    expect(parseStoredSegmentManifest(stored).stride).toBe(19)
    expect(driveErrorOf(() => parseStoredSegmentManifest({ ...stored, stride: 23 }))?.code).toBe(
      'INVALID_RECORD',
    )
  })

  it('refuses an outcome field or a wrong version', () => {
    const plain = JSON.parse(JSON.stringify(manifest))
    expect(driveErrorOf(() => parseSegmentManifest({ ...plain, version: 4 }))?.code).toBe(
      'INVALID_RECORD',
    )
    expect(
      driveErrorOf(() => parseSegmentManifest({ ...plain, outcome: record.outcome }))?.code,
    ).toBe('INVALID_RECORD')
  })

  it('reads a stored manifest from before plans carried the fog goal and the drive estimate', () => {
    const stored = JSON.parse(JSON.stringify({ ...manifest, segmentId: 'seg-1' }))
    delete stored.plan.metrics.goalInFog
    delete stored.plan.metrics.estimatedDriveS
    const parsed = parseStoredSegmentManifest(stored)
    expect(parsed.plan.metrics).not.toHaveProperty('goalInFog')
    expect(parsed.plan.metrics).not.toHaveProperty('estimatedDriveS')
    expect(parsed.plan.metrics.pathLengthM).toBe(manifest.plan.metrics.pathLengthM)
  })

  it('stores the segment id alongside, and no start time', () => {
    const stored: StoredSegmentManifest = { ...manifest, segmentId: 'seg-1' }
    expect(parseStoredSegmentManifest(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
    expect(driveErrorOf(() => parseStoredSegmentManifest(manifest))?.code).toBe('INVALID_RECORD')
    expect(
      driveErrorOf(() => parseStoredSegmentManifest({ ...stored, segmentId: '../x' }))?.code,
    ).toBe('INVALID_RECORD')
  })

  it('reads an older stored manifest carrying a start time, and drops it', () => {
    const stored: StoredSegmentManifest = { ...manifest, segmentId: 'seg-1' }
    const older = JSON.parse(JSON.stringify({ ...stored, startedAt: 1_790_000_096_800 }))
    const parsed = parseStoredSegmentManifest(older)
    expect(parsed).toEqual(stored)
    expect(parsed).not.toHaveProperty('startedAt')
    expect(driveErrorOf(() => parseStoredSegmentManifest({ ...older, startedAt: -1 }))?.code).toBe(
      'INVALID_RECORD',
    )
  })
})

describe('slice binary format v3', () => {
  const last = slices.at(-1)!

  it('writes the documented header', () => {
    const s = slices[1]!
    const bytes = encodeSlice(s)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(SLICE_HEADER_BYTES).toBe(19)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('JRSL')
    expect(view.getUint8(4)).toBe(3)
    expect(view.getUint8(5)).toBe(0)
    expect(view.getUint32(6, true)).toBe(1)
    expect(view.getUint32(10, true)).toBe(s.keyframes.length / KEYFRAME_STRIDE)
    const payloadBytes = view.getUint32(14, true)
    expect(view.getUint8(18)).toBe(0)
    expect(view.getFloat32(19, true)).toBe(s.keyframes[0])
    expect(bytes.byteLength).toBe(19 + s.keyframes.length * 4 + payloadBytes)
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(19 + s.keyframes.length * 4)))
    expect(Object.keys(json)).toEqual(['events', 'totals'])
    expect(new DataView(encodeSlice(last).buffer).getUint8(18)).toBe(1)
  })

  it('round-trips byte-identically, also from an unaligned view', () => {
    for (const slice of [slices[3]!, last]) {
      const bytes = encodeSlice(slice)
      expect(decodeSlice(bytes)).toEqual(slice)
      expect(encodeSlice(decodeSlice(bytes) as WrittenSlice)).toEqual(bytes)
      const padded = new Uint8Array(bytes.byteLength + 1)
      padded.set(bytes, 1)
      expect(decodeSlice(padded.subarray(1))).toEqual(slice)
    }
  })

  it('reads format v2 and v1 slices with their reveals and no totals, v1 frames widened', () => {
    const k = slices.findIndex(
      (slice, n) =>
        traces[n]!.reveals.length > 0 &&
        slice.keyframes.some((value, f) => f % KEYFRAME_STRIDE >= 19 && value !== 0),
    )
    expect(k).toBeGreaterThanOrEqual(0)
    const s = slices[k]!
    const { reveals } = traces[k]!
    const v2 = decodeSlice(encodeLegacySlice(s, reveals, 2))
    expect(v2).toEqual({ index: s.index, keyframes: s.keyframes, events: s.events, reveals })
    const v1 = decodeSlice(encodeLegacySlice(s, reveals, 1))
    expect(v1.keyframes).toHaveLength(s.keyframes.length)
    for (let f = 0; f < s.keyframes.length; f++) {
      const field = f % KEYFRAME_STRIDE
      expect(v1.keyframes[f]).toBe(field < 19 ? s.keyframes[f] : 0)
    }
    expect(v1).toMatchObject({ events: s.events, reveals })
    expect(v1).not.toHaveProperty('totals')
    const ending = decodeSlice(encodeLegacySlice(last, traces.at(-1)!.reveals, 2))
    expect(ending.outcome).toEqual(record.outcome)
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
    version[4] = 4
    expect(code(version)).toBe('UNSUPPORTED_VERSION')
    const flags = bytes.slice()
    flags[5] = 1
    expect(code(flags)).toBe('UNSUPPORTED_VERSION')
    const outcomeFlag = bytes.slice()
    outcomeFlag[18] = 0
    expect(code(outcomeFlag)).toBe('INVALID_RECORD')
    const json = bytes.slice()
    json[SLICE_HEADER_BYTES + last.keyframes.length * 4] = 0x7b + 1
    expect(code(json)).toBe('INVALID_RECORD')
    const legacy = encodeLegacySlice(last, traces.at(-1)!.reveals, 2)
    expect(code(legacy.subarray(0, 21))).toBe('TRUNCATED')
  })

  it('refuses a format v3 slice without totals', () => {
    const bytes = encodeSlice(slices[2]!)
    const at = SLICE_HEADER_BYTES + slices[2]!.keyframes.length * 4
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(at)))
    delete json.totals
    const body = new TextEncoder().encode(JSON.stringify(json))
    const broken = new Uint8Array(at + body.byteLength)
    broken.set(bytes.subarray(0, at))
    broken.set(body, at)
    new DataView(broken.buffer).setUint32(14, body.byteLength, true)
    expect(driveErrorOf(() => decodeSlice(broken))?.code).toBe('INVALID_RECORD')
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
    } as unknown as WrittenSlice
    expect(driveErrorOf(() => encodeSlice(paused))?.code).toBe('INVALID_RECORD')
  })

  it('refuses to encode a slice whose keyframes are not whole frames', () => {
    const broken = { ...last, keyframes: last.keyframes.subarray(1) }
    expect(driveErrorOf(() => encodeSlice(broken))?.code).toBe('INVALID_RECORD')
  })
})

describe('trace binary format v1', () => {
  // Several groups, as a slice spanning more than one metre of driving holds.
  const trace: SliceTrace = { ...traces[5]!, reveals: record.reveals.slice(0, 3) }

  it('writes the documented header', () => {
    const bytes = encodeTrace(trace)
    const view = new DataView(bytes.buffer)
    const vertices = trace.reveals.reduce((n, r) => n + r.vertices.length, 0)
    expect(TRACE_HEADER_BYTES).toBe(22)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('JRTR')
    expect(view.getUint8(4)).toBe(1)
    expect(view.getUint32(6, true)).toBe(trace.index)
    expect(view.getUint32(10, true)).toBe(trace.reveals.length)
    expect(view.getUint32(14, true)).toBe(vertices)
    expect(view.getUint32(18, true)).toBe(trace.path.length / 4)
    expect(view.getFloat64(22, true)).toBe(trace.reveals[0]!.t)
    expect(bytes.byteLength).toBe(
      22 + trace.reveals.length * 12 + vertices * 4 + trace.path.length * 4,
    )
  })

  it('round-trips byte-identically, also from an unaligned view', () => {
    const bytes = encodeTrace(trace)
    expect(decodeTrace(bytes)).toEqual(trace)
    expect(encodeTrace(decodeTrace(bytes))).toEqual(bytes)
    const padded = new Uint8Array(bytes.byteLength + 3)
    padded.set(bytes, 3)
    expect(decodeTrace(padded.subarray(3))).toEqual(trace)
    const empty = { index: 4, reveals: [], path: new Float32Array(0) }
    expect(decodeTrace(encodeTrace(empty))).toEqual(empty)
  })

  it('reports each malformed buffer with its code', () => {
    const bytes = encodeTrace(trace)
    const code = (b: Uint8Array) => driveErrorOf(() => decodeTrace(b))?.code
    expect(code(bytes.subarray(0, 10))).toBe('TRUNCATED')
    expect(code(bytes.subarray(0, bytes.byteLength - 1))).toBe('TRUNCATED')
    const extra = new Uint8Array(bytes.byteLength + 4)
    extra.set(bytes)
    expect(code(extra)).toBe('TRAILING_DATA')
    const magic = bytes.slice()
    magic[3] = 0x58
    expect(code(magic)).toBe('INVALID_RECORD')
    const version = bytes.slice()
    version[4] = 2
    expect(code(version)).toBe('UNSUPPORTED_VERSION')
    const sizes = bytes.slice()
    const view = new DataView(sizes.buffer)
    const at = TRACE_HEADER_BYTES + trace.reveals.length * 8
    view.setUint32(at, view.getUint32(at, true) + 1, true)
    view.setUint32(at + 4, view.getUint32(at + 4, true) - 1, true)
    expect(decodeTrace(sizes).reveals[0]!.vertices.length).toBe(
      trace.reveals[0]!.vertices.length + 1,
    )
    view.setUint32(at, view.getUint32(at, true) + 1, true)
    expect(code(sizes)).toBe('INVALID_RECORD')
  })

  it('refuses to encode a path of partial points or a reveal at no time', () => {
    const code = (t: SliceTrace) => driveErrorOf(() => encodeTrace(t))?.code
    expect(code({ ...trace, path: trace.path.subarray(1) })).toBe('INVALID_RECORD')
    expect(code({ ...trace, reveals: [{ t: Number.NaN, vertices: new Uint32Array(1) }] })).toBe(
      'INVALID_RECORD',
    )
  })
})

describe('trace block format v1', () => {
  const block = traces.slice(TRACE_BLOCK, 2 * TRACE_BLOCK)

  it('is the stored traces back to back, each after its length, behind a count', () => {
    const entries = block.map(encodeTrace)
    const bytes = encodeTraceBlock(entries)
    const view = new DataView(bytes.buffer)
    expect(TRACE_BLOCK).toBe(16)
    expect(TRACE_BLOCK_HEADER_BYTES).toBe(10)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('JRTB')
    expect(view.getUint8(4)).toBe(1)
    expect(view.getUint32(6, true)).toBe(TRACE_BLOCK)
    expect(view.getUint32(10, true)).toBe(entries[0]!.byteLength)
    expect(bytes.subarray(14, 14 + entries[0]!.byteLength)).toEqual(entries[0])
    expect(decodeTraceBlock(bytes)).toEqual(block)
    const padded = new Uint8Array(bytes.byteLength + 1)
    padded.set(bytes, 1)
    expect(decodeTraceBlock(padded.subarray(1))).toEqual(block)
  })

  it('reports each malformed block with its code', () => {
    const bytes = encodeTraceBlock(block.map(encodeTrace))
    const code = (b: Uint8Array) => driveErrorOf(() => decodeTraceBlock(b))?.code
    expect(code(bytes.subarray(0, 6))).toBe('TRUNCATED')
    expect(code(bytes.subarray(0, bytes.byteLength - 1))).toBe('TRUNCATED')
    const extra = new Uint8Array(bytes.byteLength + 1)
    extra.set(bytes)
    expect(code(extra)).toBe('TRAILING_DATA')
    const magic = bytes.slice()
    magic[3] = 0x58
    expect(code(magic)).toBe('INVALID_RECORD')
    const version = bytes.slice()
    version[4] = 2
    expect(code(version)).toBe('UNSUPPORTED_VERSION')
  })
})

describe('release gate', () => {
  const startedAt = Date.UTC(2026, 8, 25, 12)
  const stored = { startedAt, sliceSeconds: manifest.sliceSeconds }

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
    expect(segmentTraceKey('smoke-1', 4)).toBe('segments/smoke-1/traces/4.bin')
    expect(segmentTraceBlockKey('smoke-1', 0)).toBe('segments/smoke-1/traces/0-15.bin')
    expect(segmentTraceBlockKey('smoke-1', 3)).toBe('segments/smoke-1/traces/48-63.bin')
    expect(driveErrorOf(() => segmentTraceBlockKey('a', -1))?.code).toBe('INVALID_INPUT')
    expect(driveErrorOf(() => segmentTraceBlockKey('a', 625_000))?.code).toBe('INVALID_INPUT')
    expect(driveErrorOf(() => segmentTraceKey('a', MAX_SLICE_INDEX + 1))?.code).toBe(
      'INVALID_INPUT',
    )
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
    expect(parseJourneyKey(`missions/${mission}/stops/12.pack`)).toEqual({ kind: 'stop' })
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
    expect(parseJourneyKey('segments/smoke-1/traces/7.bin')).toEqual({
      kind: 'segment-trace',
      segmentId: 'smoke-1',
      index: 7,
    })
    expect(parseJourneyKey('segments/smoke-1/traces/16-31.bin')).toEqual({
      kind: 'segment-trace-block',
      segmentId: 'smoke-1',
      from: 16,
      to: 31,
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
      'segments/a/traces/01.bin',
      'segments/a/traces/1-16.bin',
      'segments/a/traces/0-31.bin',
      'segments/a/traces/16-16.bin',
      'segments/a/slices/0-15.bin',
      'segments/a/reveals/1.bin',
      'segments/a/slices/123456789012345.bin',
      `/terrain/${hash}/stops/0.json`,
      // Stops and masks were once keyed by world; those keys are no longer served.
      `terrain/${hash}/stops/0.json`,
      `terrain/${hash}/revealed/0.bin`,
      'missions/not-a-uuid/stops/0.json',
      'missions/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/stops/01.json',
      'missions/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/stops/01.pack',
      'missions/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/revealed/0.pack',
      'missions/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/chunks/0_0.bin',
    ]) {
      expect(parseJourneyKey(key)).toBeNull()
    }
  })
})
