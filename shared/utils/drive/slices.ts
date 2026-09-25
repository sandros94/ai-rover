import * as v from 'valibot'
import type { RouteFailureReason } from '../nav/theta-star'
import { DriveError } from './errors'
import { SEGMENT_ID } from './keys'
import { KEYFRAME_STRIDE } from './keyframes'
import type { DriveEvent, DriveEventType, DriveOutcome, SegmentRecord } from './segment'

/** Slice length used by {@link sliceRecord} unless told otherwise, seconds of sim time. */
export const DEFAULT_SLICE_SECONDS = 60
/** Manifest version written by {@link sliceRecord}. */
export const SEGMENT_MANIFEST_VERSION = 1
/** Slice format version written by {@link encodeSlice}. */
export const SLICE_FORMAT_VERSION = 1
/**
 * Bytes before the keyframes: magic, version, flags, sliceIndex, keyframeCount, eventBytes,
 * revealCount, hasOutcome.
 */
export const SLICE_HEADER_BYTES = 23

const MAGIC = new TextEncoder().encode('JRSL')

/**
 * Sim time `[index · sliceSeconds, (index + 1) · sliceSeconds)` of a segment record. Only the
 * last slice of a record carries its outcome.
 */
export interface SegmentSlice {
  index: number
  /** Whole frames in the keyframe layout, `KEYFRAME_STRIDE` floats each. */
  keyframes: Float32Array
  events: DriveEvent[]
  reveals: { t: number; vertices: Uint32Array }[]
  outcome?: DriveOutcome
}

const EVENT_TYPES: Record<DriveEventType, true> = {
  start: true,
  replan: true,
  blocked: true,
  hazard: true,
  stuck: true,
  slip: true,
  arrived: true,
  pause: true,
}
const FAILURE_REASONS: Record<RouteFailureReason, true> = {
  'goal-unreachable': true,
  'expansion-cap': true,
  'start-blocked': true,
  'goal-blocked': true,
}
const OUTCOME_KINDS: Record<DriveOutcome['kind'], true> = {
  'arrived': true,
  'stopped-short': true,
  'failed': true,
}

const finite = v.pipe(v.number(), v.finite())
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
const PointSchema = v.strictObject({ x: finite, y: finite })
const PlanarPoseSchema = v.strictObject({ x: finite, y: finite, headingRad: finite })

/** Segment facts public from its start: the opening plan, start and goal. Never the outcome. */
export const SegmentManifestSchema = v.strictObject({
  version: v.literal(SEGMENT_MANIFEST_VERSION),
  sliceSeconds: v.pipe(v.number(), v.finite(), v.gtValue(0)),
  keyframeHz: v.pipe(v.number(), v.finite(), v.gtValue(0)),
  stride: v.literal(KEYFRAME_STRIDE),
  plan: v.strictObject({
    polyline: v.array(PointSchema),
    metrics: v.strictObject({
      reached: v.boolean(),
      failureReason: v.optional(
        v.picklist(Object.keys(FAILURE_REASONS) as (keyof typeof FAILURE_REASONS)[]),
      ),
      pathLengthM: finite,
      straightLineM: finite,
      detourRatio: finite,
      maxSlopeDeg: finite,
      meanSlopeDeg: finite,
      unrevealedFraction: finite,
      turnCount: count,
      expansions: count,
      computeMs: finite,
    }),
  }),
  start: PlanarPoseSchema,
  goal: PointSchema,
})

export type SegmentManifest = v.InferOutput<typeof SegmentManifestSchema>

/** A manifest as published: the segment's id and its wall-clock start, epoch milliseconds. */
export const StoredSegmentManifestSchema = v.strictObject({
  ...SegmentManifestSchema.entries,
  segmentId: v.pipe(v.string(), v.regex(SEGMENT_ID)),
  startedAt: count,
})

export type StoredSegmentManifest = v.InferOutput<typeof StoredSegmentManifestSchema>

const DetailSchema = v.union([finite, v.string(), v.array(v.string()), v.array(PointSchema)])

/** The JSON part of a slice; reveal vertices travel as binary after it. */
const SlicePayloadSchema = v.strictObject({
  events: v.array(
    v.strictObject({
      t: finite,
      type: v.picklist(Object.keys(EVENT_TYPES) as DriveEventType[]),
      x: finite,
      y: finite,
      details: v.optional(v.record(v.string(), DetailSchema)),
    }),
  ),
  reveals: v.array(v.strictObject({ t: finite, count })),
  outcome: v.optional(
    v.strictObject({
      kind: v.picklist(Object.keys(OUTCOME_KINDS) as DriveOutcome['kind'][]),
      reasons: v.array(v.string()),
      distanceM: finite,
      durationS: finite,
      endPose: PlanarPoseSchema,
    }),
  ),
})

/**
 * Cuts a record into slices of `sliceSeconds` of sim time, from t = 0 to the slice holding its
 * last keyframe, event or reveal, plus the manifest that describes them. The outcome rides in the
 * last slice only; the manifest carries neither the outcome nor the duration or slice count, which
 * would give away how the segment ends.
 */
export function sliceRecord(
  record: SegmentRecord,
  options: {
    start: { x: number; y: number; headingRad: number }
    goal: { x: number; y: number }
    sliceSeconds?: number
  },
): { manifest: SegmentManifest; slices: SegmentSlice[] } {
  const { start, goal, sliceSeconds = DEFAULT_SLICE_SECONDS } = options
  assertSliceSeconds(sliceSeconds)
  if (![start.x, start.y, start.headingRad, goal.x, goal.y].every(Number.isFinite)) {
    throw new DriveError(
      'INVALID_INPUT',
      `sliceRecord: start (${start.x}, ${start.y}, ${start.headingRad}) and goal (${goal.x}, ${goal.y}) must be finite; pass the drive's own start and goal.`,
    )
  }
  const { keyframes, events, reveals, outcome } = record
  const { data, count: frameCount } = keyframes
  const at = (t: number) => Math.max(0, Math.floor(t / sliceSeconds))

  let last = at(outcome.durationS)
  if (frameCount > 0) last = Math.max(last, at(data[(frameCount - 1) * KEYFRAME_STRIDE]!))
  if (events.length > 0) last = Math.max(last, at(events.at(-1)!.t))
  if (reveals.length > 0) last = Math.max(last, at(reveals.at(-1)!.t))

  const slices: SegmentSlice[] = []
  let frame = 0
  let event = 0
  let reveal = 0
  for (let index = 0; index <= last; index++) {
    const end = (index + 1) * sliceSeconds
    const from = frame
    while (frame < frameCount && data[frame * KEYFRAME_STRIDE]! < end) frame++
    const slice: SegmentSlice = {
      index,
      keyframes: data.slice(from * KEYFRAME_STRIDE, frame * KEYFRAME_STRIDE),
      events: [],
      reveals: [],
    }
    while (event < events.length && events[event]!.t < end) slice.events.push(events[event++]!)
    while (reveal < reveals.length && reveals[reveal]!.t < end)
      slice.reveals.push(reveals[reveal++]!)
    if (index === last) slice.outcome = outcome
    slices.push(slice)
  }

  const manifest: SegmentManifest = {
    version: SEGMENT_MANIFEST_VERSION,
    sliceSeconds,
    keyframeHz: keyframes.hz,
    stride: KEYFRAME_STRIDE,
    plan: {
      polyline: record.plan.polyline.map(({ x, y }) => ({ x, y })),
      metrics: { ...record.plan.metrics, computeMs: 0 },
    },
    start: { x: start.x, y: start.y, headingRad: start.headingRad },
    goal: { x: goal.x, y: goal.y },
  }
  return { manifest, slices }
}

export function parseSegmentManifest(value: unknown): SegmentManifest {
  return parseManifest(SegmentManifestSchema, value, 'Segment manifest', 'sliceRecord')
}

export function parseStoredSegmentManifest(value: unknown): StoredSegmentManifest {
  return parseManifest(
    StoredSegmentManifestSchema,
    value,
    'Stored segment manifest',
    'publishSegment',
  )
}

/** Wall-clock epoch milliseconds from which slice `sliceIndex` may be served. */
export function sliceReleaseAt(
  startedAt: number,
  sliceIndex: number,
  sliceSeconds: number,
): number {
  if (!Number.isFinite(startedAt)) {
    throw new DriveError(
      'INVALID_INPUT',
      `sliceReleaseAt: startedAt is ${startedAt}; pass epoch milliseconds.`,
    )
  }
  if (!Number.isSafeInteger(sliceIndex) || sliceIndex < 0) {
    throw new DriveError(
      'INVALID_INPUT',
      `sliceReleaseAt: slice index is ${sliceIndex}; pass a non-negative integer.`,
    )
  }
  assertSliceSeconds(sliceSeconds)
  return startedAt + sliceIndex * sliceSeconds * 1000
}

/** Whether slice `sliceIndex` of a published segment may be served at epoch milliseconds `now`. */
export function sliceGate(
  manifest: Pick<StoredSegmentManifest, 'startedAt' | 'sliceSeconds'>,
  sliceIndex: number,
  now: number,
): { released: boolean; releaseAt: number } {
  const releaseAt = sliceReleaseAt(manifest.startedAt, sliceIndex, manifest.sliceSeconds)
  return { released: now >= releaseAt, releaseAt }
}

/**
 * Slice format v1, little-endian: `"JRSL"`, u8 version, u8 flags (0), u32 sliceIndex,
 * u32 keyframeCount, u32 eventBytes, u32 revealCount, u8 hasOutcome, then f32 keyframes
 * [19 · keyframeCount], eventBytes of UTF-8 JSON `{ events, reveals: [{ t, count }], outcome? }`,
 * and u32 reveal vertices[revealCount], the reveal groups' vertices back to back.
 */
export function encodeSlice(slice: SegmentSlice): Uint8Array {
  const { index, keyframes, events, reveals, outcome } = slice
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new DriveError(
      'INVALID_RECORD',
      `encodeSlice: slice index is ${index}; pass an integer from 0 to 2³² − 1.`,
    )
  }
  if (keyframes.length % KEYFRAME_STRIDE !== 0) {
    throw new DriveError(
      'INVALID_RECORD',
      `encodeSlice: slice ${index} holds ${keyframes.length} keyframe values, not a multiple of ${KEYFRAME_STRIDE}; pass whole frames.`,
    )
  }
  const payload = {
    events,
    reveals: reveals.map(({ t, vertices }) => ({ t, count: vertices.length })),
    ...(outcome ? { outcome } : {}),
  }
  const checked = v.safeParse(SlicePayloadSchema, payload)
  if (!checked.success) throw payloadError(checked.issues, `encodeSlice: slice ${index}`)
  const json = new TextEncoder().encode(JSON.stringify(payload))
  const revealCount = reveals.reduce((n, r) => n + r.vertices.length, 0)
  const frameBytes = keyframes.length * 4
  const bytes = new Uint8Array(SLICE_HEADER_BYTES + frameBytes + json.byteLength + revealCount * 4)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  view.setUint8(4, SLICE_FORMAT_VERSION)
  view.setUint8(5, 0)
  view.setUint32(6, index, true)
  view.setUint32(10, keyframes.length / KEYFRAME_STRIDE, true)
  view.setUint32(14, json.byteLength, true)
  view.setUint32(18, revealCount, true)
  view.setUint8(22, outcome ? 1 : 0)
  // Typed-array views use host byte order; the wire format is little-endian, so write through the view.
  for (let k = 0; k < keyframes.length; k++) {
    view.setFloat32(SLICE_HEADER_BYTES + k * 4, keyframes[k]!, true)
  }
  bytes.set(json, SLICE_HEADER_BYTES + frameBytes)
  let offset = SLICE_HEADER_BYTES + frameBytes + json.byteLength
  for (const { vertices } of reveals) {
    for (const vertex of vertices) {
      view.setUint32(offset, vertex, true)
      offset += 4
    }
  }
  return bytes
}

/** Decodes format v1 into fresh arrays; the input may be any view, aligned or not. */
export function decodeSlice(bytes: Uint8Array): SegmentSlice {
  if (bytes.byteLength < MAGIC.length) throw truncated(bytes.byteLength)
  for (let k = 0; k < MAGIC.length; k++) {
    if (bytes[k] !== MAGIC[k]) {
      const found = Array.from(bytes.subarray(0, MAGIC.length), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(' ')
      throw new DriveError(
        'INVALID_RECORD',
        `Slice buffer starts with bytes ${found}, not "JRSL"; pass bytes produced by encodeSlice.`,
      )
    }
  }
  if (bytes.byteLength < SLICE_HEADER_BYTES) throw truncated(bytes.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(4)
  if (version !== SLICE_FORMAT_VERSION) {
    throw new DriveError(
      'UNSUPPORTED_VERSION',
      `Slice format version is ${version}; this decoder reads version ${SLICE_FORMAT_VERSION} only.`,
    )
  }
  const flags = view.getUint8(5)
  if (flags !== 0) {
    throw new DriveError(
      'UNSUPPORTED_VERSION',
      `Slice format v1 flags are 0x${flags.toString(16)}; this decoder reads flags 0 only.`,
    )
  }
  const index = view.getUint32(6, true)
  const frameCount = view.getUint32(10, true)
  const eventBytes = view.getUint32(14, true)
  const revealCount = view.getUint32(18, true)
  const hasOutcome = view.getUint8(22)
  if (hasOutcome > 1) {
    throw new DriveError(
      'INVALID_RECORD',
      `Slice ${index} hasOutcome byte is ${hasOutcome}; format v1 writes 0 or 1.`,
    )
  }
  const frameValues = frameCount * KEYFRAME_STRIDE
  const jsonAt = SLICE_HEADER_BYTES + frameValues * 4
  const revealsAt = jsonAt + eventBytes
  const expected = revealsAt + revealCount * 4
  if (bytes.byteLength < expected) {
    throw new DriveError(
      'TRUNCATED',
      `Slice buffer is ${bytes.byteLength} bytes; ${frameCount} keyframes, ${eventBytes} bytes of events and ${revealCount} reveal vertices need ${expected}. Pass the complete slice.`,
    )
  }
  if (bytes.byteLength > expected) {
    throw new DriveError(
      'TRAILING_DATA',
      `Slice buffer is ${bytes.byteLength} bytes; its header declares exactly ${expected}. Pass one slice per buffer.`,
    )
  }

  const keyframes = new Float32Array(frameValues)
  for (let k = 0; k < frameValues; k++) {
    keyframes[k] = view.getFloat32(SLICE_HEADER_BYTES + k * 4, true)
  }
  let raw: unknown
  try {
    raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(jsonAt, revealsAt)),
    )
  } catch (error) {
    throw new DriveError(
      'INVALID_RECORD',
      `Slice ${index} events are not UTF-8 JSON; pass bytes produced by encodeSlice.`,
      { cause: error },
    )
  }
  const parsed = v.safeParse(SlicePayloadSchema, raw)
  if (!parsed.success) throw payloadError(parsed.issues, `Slice ${index}`)
  const payload = parsed.output
  if (Boolean(payload.outcome) !== (hasOutcome === 1)) {
    throw new DriveError(
      'INVALID_RECORD',
      `Slice ${index} hasOutcome byte is ${hasOutcome} but its events JSON ${payload.outcome ? 'holds' : 'lacks'} an outcome; pass bytes produced by encodeSlice.`,
    )
  }
  const listed = payload.reveals.reduce((n, r) => n + r.count, 0)
  if (listed !== revealCount) {
    throw new DriveError(
      'INVALID_RECORD',
      `Slice ${index} reveal groups list ${listed} vertices; its header declares ${revealCount}. Pass bytes produced by encodeSlice.`,
    )
  }
  let offset = revealsAt
  const reveals = payload.reveals.map(({ t, count: n }) => {
    const vertices = new Uint32Array(n)
    for (let k = 0; k < n; k++, offset += 4) vertices[k] = view.getUint32(offset, true)
    return { t, vertices }
  })
  const slice: SegmentSlice = { index, keyframes, events: payload.events, reveals }
  if (payload.outcome) slice.outcome = payload.outcome
  return slice
}

function parseManifest<T extends v.GenericSchema>(
  schema: T,
  value: unknown,
  name: string,
  producer: string,
): v.InferOutput<T> {
  const result = v.safeParse(schema, value)
  if (result.success) return result.output
  const [issue] = result.issues
  const path = v.getDotPath(issue) ?? '(root)'
  throw new DriveError(
    'INVALID_RECORD',
    `${name} field ${path} is invalid: ${issue.message}. Pass a version ${SEGMENT_MANIFEST_VERSION} manifest built by ${producer}.`,
    { cause: new v.ValiError(result.issues) },
  )
}

function payloadError(
  issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]],
  context: string,
): DriveError {
  const [issue] = issues
  const path = v.getDotPath(issue) ?? '(root)'
  return new DriveError(
    'INVALID_RECORD',
    `${context} field ${path} is invalid: ${issue.message}. Pass events, reveals and an outcome as driveSegment records them.`,
    { cause: new v.ValiError(issues) },
  )
}

function truncated(length: number): DriveError {
  return new DriveError(
    'TRUNCATED',
    `Slice buffer is ${length} bytes, shorter than its ${SLICE_HEADER_BYTES}-byte header; pass the complete slice.`,
  )
}

function assertSliceSeconds(sliceSeconds: number): void {
  if (!Number.isFinite(sliceSeconds) || sliceSeconds <= 0) {
    throw new DriveError(
      'INVALID_INPUT',
      `Slice length is ${sliceSeconds} s; pass a positive number of seconds.`,
    )
  }
}
