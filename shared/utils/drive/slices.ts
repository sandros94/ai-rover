import * as v from 'valibot'
import type { RouteFailureReason } from '../nav/theta-star'
import { DriveError } from './errors'
import { SEGMENT_ID } from './keys'
import { KEYFRAME_STRIDE, KEYFRAME_STRIDES, readFrames } from './keyframes'
import type { Odometry } from './odometry'
import { frameOdometry, SLIP_WINDOW_M } from './odometry'
import type { DriveEvent, DriveEventType, DriveOutcome, SegmentRecord } from './segment'
import type { DriveStatus, StatusRun } from './status'
import { statusInForce } from './status'
import type { SliceTrace } from './traces'
import { TRACE_PATH_SECONDS } from './traces'

/** Slice length used by {@link sliceRecord} unless told otherwise, seconds of sim time. */
export const DEFAULT_SLICE_SECONDS = 30
/**
 * Manifest version written by {@link sliceRecord}. The version states how the segment was
 * published: version 1 with stride 19 (keyframe format v1, no steering) and version 2 with
 * stride 23 (keyframe format v2), their reveals inside the slices; version 3 with stride 23, each
 * slice carrying the drive's totals at its start and its reveals in its own trace.
 */
export const SEGMENT_MANIFEST_VERSION = 3
/**
 * Slice format version written by {@link encodeSlice}. Versions 1 (19-value frames) and 2
 * (23-value frames) carry their reveals inline; version 3 (23-value frames) carries the totals
 * instead, its reveals travelling in the slice's trace.
 */
export const SLICE_FORMAT_VERSION = 3
/**
 * Wheel rotation a slip trail may be off by where it leaves out frames, radians: 0.03 mm of
 * commanded travel, below what the slip gauge shows and above the float32 noise of the spins.
 */
const TRAIL_TOLERANCE_RAD = 1e-4
/** Keyframe stride each manifest version states. */
const MANIFEST_STRIDES: Readonly<Record<number, number>> = Object.freeze({ 1: 19, 2: 23, 3: 23 })
/** Keyframe stride of each slice format version. */
const SLICE_STRIDES: Readonly<Record<number, number>> = Object.freeze({
  1: KEYFRAME_STRIDES[1]!,
  2: KEYFRAME_STRIDES[2]!,
  3: KEYFRAME_STRIDE,
})
/** Bytes before the keyframes: magic, version, flags, sliceIndex, keyframeCount, payloadBytes, hasOutcome. */
export const SLICE_HEADER_BYTES = 19
/** Formats 1 and 2 also declare their reveal vertices, a u32 before hasOutcome. */
const LEGACY_HEADER_BYTES = 23

const MAGIC = new TextEncoder().encode('JRSL')

/**
 * What a viewer would otherwise integrate from t = 0, as of a slice's reference frame: its first
 * keyframe, or for a slice holding none the drive's last keyframe before it. With these a client
 * reads the drive from any slice without the slices before it.
 */
export interface SliceTotals {
  /** Ground distance covered by the reference frame, metres (see `frameOdometry`). */
  groundM: number
  /** Middle-wheel rotation by the reference frame, radians: the commanded distance over the wheel radius. */
  wheelRad: number
  /**
   * The frames over the {@link SLIP_WINDOW_M} of ground before the reference frame, oldest first,
   * each as `[groundM, wheelRad]` back from it, rounded to micrometres and microradians: a
   * standstill's first and last frames and the corners of the wheel rotation over ground, which
   * reproduce every frame left out within a tenth of a milliradian. Slip over the last metre reads them
   * until the ground covered since the reference frame reaches the window.
   */
  slipTrail: [number, number][]
  /** The status run in force at the slice's start; null before the drive's `start` event. */
  status: StatusRun | null
  /** The route of the latest replan before the slice's start; absent while the opening plan holds. */
  route?: { x: number; y: number }[]
}

/**
 * Sim time `[index · sliceSeconds, (index + 1) · sliceSeconds)` of a segment record. Only the
 * last slice of a record carries its outcome.
 */
export interface SegmentSlice {
  index: number
  /** Whole frames in the keyframe layout, `KEYFRAME_STRIDE` floats each. */
  keyframes: Float32Array
  events: DriveEvent[]
  /** Written by format 3; slices of formats 1 and 2 were recorded before totals existed. */
  totals?: SliceTotals
  /** Read from formats 1 and 2 only, which carried the reveals inline; format 3 has traces. */
  reveals?: SliceTrace['reveals']
  outcome?: DriveOutcome
}

/** A slice as {@link encodeSlice} writes it. */
export type WrittenSlice = Omit<SegmentSlice, 'totals' | 'reveals'> & { totals: SliceTotals }

const EVENT_TYPES: Record<DriveEventType, true> = {
  start: true,
  steering: true,
  turning: true,
  assessing: true,
  replan: true,
  imaging: true,
  slip: true,
  blocked: true,
  hazard: true,
  stuck: true,
  arrived: true,
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

const ManifestEntries = {
  // Blobs are immutable: segments published with an earlier version stay readable forever.
  version: v.picklist([1, 2, SEGMENT_MANIFEST_VERSION]),
  sliceSeconds: v.pipe(v.number(), v.finite(), v.gtValue(0)),
  keyframeHz: v.pipe(v.number(), v.finite(), v.gtValue(0)),
  stride: v.picklist([KEYFRAME_STRIDES[1]!, KEYFRAME_STRIDE]),
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
      // Absent from segments published before plans carried them: blobs are immutable, so
      // those segments stay readable forever and these stay optional.
      goalInFog: v.optional(v.boolean()),
      estimatedDriveS: v.optional(finite),
      turnCount: count,
      expansions: count,
      computeMs: finite,
    }),
  }),
  start: PlanarPoseSchema,
  goal: PointSchema,
}

const strideOfVersion = (manifest: { version: number; stride: number }): boolean =>
  MANIFEST_STRIDES[manifest.version] === manifest.stride
const STRIDE_MISMATCH =
  'the stride is not the one its version states (19 for version 1, 23 for versions 2 and 3)'

/** Segment facts public from its start: the opening plan, start and goal. Never the outcome. */
const ManifestObject = v.strictObject(ManifestEntries)
export const SegmentManifestSchema = v.pipe(
  ManifestObject,
  v.check<v.InferOutput<typeof ManifestObject>, string>(strideOfVersion, STRIDE_MISMATCH),
)

export type SegmentManifest = v.InferOutput<typeof SegmentManifestSchema>

/** A published segment's opening plan metrics: `NavMetrics`, older segments lacking some. */
export type PublishedPlanMetrics = SegmentManifest['plan']['metrics']

/**
 * A manifest as published: the segment's content and its id, the same for every run that
 * publishes it. When the segment started is the segment row's alone: slices are released and
 * played from the row's start.
 */
const StoredManifestObject = v.strictObject({
  ...ManifestEntries,
  segmentId: v.pipe(v.string(), v.regex(SEGMENT_ID)),
  // Blobs are immutable, and older manifests carry a `startedAt`: the clock of whichever run
  // wrote them last, which can be later than the row's start. It is read and dropped.
  startedAt: v.optional(count),
})
export const StoredSegmentManifestSchema = v.pipe(
  StoredManifestObject,
  v.check<v.InferOutput<typeof StoredManifestObject>, string>(strideOfVersion, STRIDE_MISMATCH),
  v.transform(({ startedAt: _dropped, ...manifest }) => manifest),
)

export type StoredSegmentManifest = v.InferOutput<typeof StoredSegmentManifestSchema>

const DetailSchema = v.union([finite, v.string(), v.array(v.string()), v.array(PointSchema)])

const STATUSES: Record<DriveStatus, true> = {
  driving: true,
  steering: true,
  turning: true,
  assessing: true,
  imaging: true,
  stopped: true,
}

const TotalsSchema = v.strictObject({
  groundM: finite,
  wheelRad: finite,
  slipTrail: v.array(v.tuple([finite, finite])),
  status: v.nullable(
    v.strictObject({
      t: finite,
      status: v.picklist(Object.keys(STATUSES) as DriveStatus[]),
      endsAt: v.optional(finite),
      angleDeg: v.optional(finite),
    }),
  ),
  route: v.optional(v.array(PointSchema)),
})

const PayloadEntries = {
  events: v.array(
    v.strictObject({
      t: finite,
      type: v.picklist(Object.keys(EVENT_TYPES) as DriveEventType[]),
      x: finite,
      y: finite,
      details: v.optional(v.record(v.string(), DetailSchema)),
    }),
  ),
  outcome: v.optional(
    v.strictObject({
      kind: v.picklist(Object.keys(OUTCOME_KINDS) as DriveOutcome['kind'][]),
      reasons: v.array(v.string()),
      distanceM: finite,
      durationS: finite,
      endPose: PlanarPoseSchema,
    }),
  ),
}

/** The JSON part of a format 3 slice. */
const SlicePayloadSchema = v.strictObject({ ...PayloadEntries, totals: TotalsSchema })

/** The JSON part of a format 1 or 2 slice; reveal vertices travel as binary after it. */
const LegacyPayloadSchema = v.strictObject({
  ...PayloadEntries,
  reveals: v.array(v.strictObject({ t: finite, count })),
})

/**
 * Cuts a record into slices of `sliceSeconds` of sim time, from t = 0 to the slice holding its
 * last keyframe, event or reveal, each with its trace and the totals at its start, plus the
 * manifest that describes them, start and goal taken from the record. The outcome rides in the
 * last slice only; the manifest carries neither the outcome nor the duration or slice count,
 * which would give away how the segment ends.
 */
export function sliceRecord(
  record: SegmentRecord,
  options: { sliceSeconds?: number } = {},
): { manifest: SegmentManifest; slices: WrittenSlice[]; traces: SliceTrace[] } {
  const { sliceSeconds = DEFAULT_SLICE_SECONDS } = options
  assertSliceSeconds(sliceSeconds)
  const { start, goal, keyframes, events, reveals, outcome } = record
  if (![start.x, start.y, start.headingRad, goal.x, goal.y].every(Number.isFinite)) {
    throw new DriveError(
      'INVALID_INPUT',
      `sliceRecord: record start (${start.x}, ${start.y}, ${start.headingRad}) and goal (${goal.x}, ${goal.y}) must be finite; pass a record produced by driveSegment.`,
    )
  }
  const { data, count: frameCount } = keyframes
  const at = (t: number) => Math.max(0, Math.floor(t / sliceSeconds))

  let last = at(outcome.durationS)
  if (frameCount > 0) last = Math.max(last, at(data[(frameCount - 1) * KEYFRAME_STRIDE]!))
  if (events.length > 0) last = Math.max(last, at(events.at(-1)!.t))
  if (reveals.length > 0) last = Math.max(last, at(reveals.at(-1)!.t))

  const odometry = frameOdometry(keyframes)
  const pathEvery = Math.max(1, Math.round(TRACE_PATH_SECONDS * keyframes.hz))
  const slices: WrittenSlice[] = []
  const traces: SliceTrace[] = []
  let frame = 0
  let event = 0
  let reveal = 0
  for (let index = 0; index <= last; index++) {
    const begin = index * sliceSeconds
    const end = begin + sliceSeconds
    const from = frame
    while (frame < frameCount && data[frame * KEYFRAME_STRIDE]! < end) frame++
    // A slice without frames reads from the drive's last frame before it.
    const before = events.slice(0, event)
    const totals = sliceTotals(odometry, frame > from ? from : from - 1, {
      status: statusInForce(before, begin),
      route: latestRoute(before),
    })
    const slice: WrittenSlice = {
      index,
      keyframes: data.slice(from * KEYFRAME_STRIDE, frame * KEYFRAME_STRIDE),
      events: [],
      totals,
    }
    while (event < events.length && events[event]!.t < end) slice.events.push(events[event++]!)
    const trace: SliceTrace = { index, reveals: [], path: tracePath(data, from, frame, pathEvery) }
    while (reveal < reveals.length && reveals[reveal]!.t < end)
      trace.reveals.push(reveals[reveal++]!)
    if (index === last) slice.outcome = outcome
    slices.push(slice)
    traces.push(trace)
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
  return { manifest, slices, traces }
}

/**
 * The totals of a slice whose reference frame is frame `ref` of the drive (-1 when the drive has
 * none), `odometry` being the drive's from its first frame; the status and route as the events
 * before the slice leave them.
 */
export function sliceTotals(
  odometry: Odometry,
  ref: number,
  state: { status: StatusRun | null; route?: { x: number; y: number }[] },
): SliceTotals {
  const { groundM: g, wheelRad: w } = odometry
  const totals: SliceTotals = {
    groundM: ref >= 0 ? g[ref]! : 0,
    wheelRad: ref >= 0 ? w[ref]! : 0,
    slipTrail: [],
    status: state.status,
  }
  if (state.route) totals.route = state.route
  if (ref <= 0) return totals
  // Frames from the one before the ground first reached a window back from `ref`.
  const floor = g[ref]! - SLIP_WINDOW_M
  let first = ref
  while (first > 0 && g[first - 1]! >= floor) first--
  first = Math.max(0, first - 1)
  // Slip looks a distance up by the first frame reaching it and interpolates from the frame
  // before, so a standstill needs only its first and last frames, and frames on a straight line
  // between kept ones (steady slip) add nothing the tolerance would show.
  const still = (k: number) => g[k] === g[k - 1] && g[k] === g[k + 1]
  const edge = (k: number) => k === first || g[k] === g[k - 1] || g[k] === g[k + 1]
  const straight = (a: number, b: number) => {
    for (let j = a + 1; j < b; j++) {
      const u = (g[j]! - g[a]!) / (g[b]! - g[a]!)
      if (Math.abs(w[a]! + (w[b]! - w[a]!) * u - w[j]!) > TRAIL_TOLERANCE_RAD) return false
    }
    return true
  }
  // JSON writes −0 as 0: adding 0 keeps a slice equal to its decoded copy.
  const micro = (value: number) => Math.round(value * 1e6) / 1e6 + 0
  let anchor = first
  for (let k = first; k < ref; k++) {
    if (k > first && still(k)) continue
    if (!edge(k) && straight(anchor, k + 1)) continue
    anchor = k
    totals.slipTrail.push([micro(g[ref]! - g[k]!), micro(w[ref]! - w[k]!)])
  }
  return totals
}

/** The route of the latest replan among `events`; undefined while none replanned. */
export function latestRoute(events: readonly DriveEvent[]): { x: number; y: number }[] | undefined {
  const replan = events.findLast((e) => e.type === 'replan' && Array.isArray(e.details?.polyline))
  return (replan?.details!.polyline as { x: number; y: number }[] | undefined)?.map(({ x, y }) => ({
    x,
    y,
  }))
}

/** `t, x, y, z` of frames `from … to − 1` whose drive index is a multiple of `every`, and the last. */
function tracePath(data: Float32Array, from: number, to: number, every: number): Float32Array {
  const points: number[] = []
  for (let k = from; k < to; k++) {
    if (k % every !== 0 && k !== to - 1) continue
    const o = k * KEYFRAME_STRIDE
    points.push(data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!)
  }
  return Float32Array.from(points)
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

/**
 * Wall-clock epoch milliseconds from which slice `sliceIndex` may be served: the end of its
 * window, `startedAt + (sliceIndex + 1) · sliceSeconds · 1000`. Nothing in the future is ever
 * served; the live view trails the simulation by at most one slice.
 */
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
  return startedAt + (sliceIndex + 1) * sliceSeconds * 1000
}

/**
 * Whether slice `sliceIndex` of a segment started at `release.startedAt` (epoch milliseconds, the
 * segment row's) may be served at epoch milliseconds `now`, that is whether its whole window lies
 * in the past (see {@link sliceReleaseAt}).
 */
export function sliceGate(
  release: { startedAt: number; sliceSeconds: number },
  sliceIndex: number,
  now: number,
): { released: boolean; releaseAt: number } {
  const releaseAt = sliceReleaseAt(release.startedAt, sliceIndex, release.sliceSeconds)
  return { released: now >= releaseAt, releaseAt }
}

/**
 * Slice format v3, little-endian: `"JRSL"`, u8 version, u8 flags (0), u32 sliceIndex,
 * u32 keyframeCount, u32 payloadBytes, u8 hasOutcome, then f32 keyframes [23 · keyframeCount] and
 * payloadBytes of UTF-8 JSON `{ events, totals, outcome? }`.
 *
 * Formats 1 and 2 (read only) have a u32 revealCount before hasOutcome, 19- and 23-value frames,
 * JSON `{ events, reveals: [{ t, count }], outcome? }`, then u32 reveal vertices[revealCount], the
 * reveal groups' vertices back to back.
 */
export function encodeSlice(slice: WrittenSlice): Uint8Array {
  const { index, keyframes, events, totals, outcome } = slice
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
  const payload = { events, totals, ...(outcome ? { outcome } : {}) }
  const checked = v.safeParse(SlicePayloadSchema, payload)
  if (!checked.success) throw payloadError(checked.issues, `encodeSlice: slice ${index}`)
  const json = new TextEncoder().encode(JSON.stringify(payload))
  const frameBytes = keyframes.length * 4
  const bytes = new Uint8Array(SLICE_HEADER_BYTES + frameBytes + json.byteLength)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  view.setUint8(4, SLICE_FORMAT_VERSION)
  view.setUint8(5, 0)
  view.setUint32(6, index, true)
  view.setUint32(10, keyframes.length / KEYFRAME_STRIDE, true)
  view.setUint32(14, json.byteLength, true)
  view.setUint8(18, outcome ? 1 : 0)
  // Typed-array views use host byte order; the wire format is little-endian, so write through the view.
  for (let k = 0; k < keyframes.length; k++) {
    view.setFloat32(SLICE_HEADER_BYTES + k * 4, keyframes[k]!, true)
  }
  bytes.set(json, SLICE_HEADER_BYTES + frameBytes)
  return bytes
}

/**
 * Decodes format v3, v2 or v1 into fresh arrays, the keyframes in the current layout (a v1
 * frame's steering angles zero); a v3 slice comes with its totals, an older one with its reveals.
 * The input may be any view, aligned or not.
 */
export function decodeSlice(bytes: Uint8Array): SegmentSlice {
  if (bytes.byteLength < MAGIC.length) throw truncated(bytes.byteLength, SLICE_HEADER_BYTES)
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
  if (bytes.byteLength < 5) throw truncated(bytes.byteLength, SLICE_HEADER_BYTES)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(4)
  const stride = SLICE_STRIDES[version]
  if (stride === undefined) {
    throw new DriveError(
      'UNSUPPORTED_VERSION',
      `Slice format version is ${version}; this decoder reads versions ${Object.keys(SLICE_STRIDES).join(', ')}.`,
    )
  }
  const legacy = version < 3
  const headerBytes = legacy ? LEGACY_HEADER_BYTES : SLICE_HEADER_BYTES
  if (bytes.byteLength < headerBytes) throw truncated(bytes.byteLength, headerBytes)
  const flags = view.getUint8(5)
  if (flags !== 0) {
    throw new DriveError(
      'UNSUPPORTED_VERSION',
      `Slice format v${version} flags are 0x${flags.toString(16)}; this decoder reads flags 0 only.`,
    )
  }
  const index = view.getUint32(6, true)
  const frameCount = view.getUint32(10, true)
  const payloadBytes = view.getUint32(14, true)
  const revealCount = legacy ? view.getUint32(18, true) : 0
  const hasOutcome = view.getUint8(headerBytes - 1)
  if (hasOutcome > 1) {
    throw new DriveError(
      'INVALID_RECORD',
      `Slice ${index} hasOutcome byte is ${hasOutcome}; format v${version} writes 0 or 1.`,
    )
  }
  const jsonAt = headerBytes + frameCount * stride * 4
  const revealsAt = jsonAt + payloadBytes
  const expected = revealsAt + revealCount * 4
  if (bytes.byteLength < expected) {
    throw new DriveError(
      'TRUNCATED',
      `Slice buffer is ${bytes.byteLength} bytes; ${frameCount} keyframes, ${payloadBytes} bytes of JSON and ${revealCount} reveal vertices need ${expected}. Pass the complete slice.`,
    )
  }
  if (bytes.byteLength > expected) {
    throw new DriveError(
      'TRAILING_DATA',
      `Slice buffer is ${bytes.byteLength} bytes; its header declares exactly ${expected}. Pass one slice per buffer.`,
    )
  }

  const keyframes = readFrames(view, headerBytes, frameCount, stride)
  let raw: unknown
  try {
    raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(jsonAt, revealsAt)),
    )
  } catch (error) {
    throw new DriveError(
      'INVALID_RECORD',
      `Slice ${index} JSON is not UTF-8 JSON; pass bytes produced by encodeSlice.`,
      { cause: error },
    )
  }
  const parsed = legacy
    ? v.safeParse(LegacyPayloadSchema, raw)
    : v.safeParse(SlicePayloadSchema, raw)
  if (!parsed.success) throw payloadError(parsed.issues, `Slice ${index}`)
  const payload = parsed.output
  if (Boolean(payload.outcome) !== (hasOutcome === 1)) {
    throw new DriveError(
      'INVALID_RECORD',
      `Slice ${index} hasOutcome byte is ${hasOutcome} but its JSON ${payload.outcome ? 'holds' : 'lacks'} an outcome; pass bytes produced by encodeSlice.`,
    )
  }
  const slice: SegmentSlice = { index, keyframes, events: payload.events }
  if ('totals' in payload) slice.totals = payload.totals
  if ('reveals' in payload) {
    const listed = payload.reveals.reduce((n, r) => n + r.count, 0)
    if (listed !== revealCount) {
      throw new DriveError(
        'INVALID_RECORD',
        `Slice ${index} reveal groups list ${listed} vertices; its header declares ${revealCount}. Pass bytes produced by encodeSlice.`,
      )
    }
    let offset = revealsAt
    slice.reveals = payload.reveals.map(({ t, count: n }) => {
      const vertices = new Uint32Array(n)
      for (let k = 0; k < n; k++, offset += 4) vertices[k] = view.getUint32(offset, true)
      return { t, vertices }
    })
  }
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
    `${context} field ${path} is invalid: ${issue.message}. Pass events, totals and an outcome as sliceRecord cuts them.`,
    { cause: new v.ValiError(issues) },
  )
}

function truncated(length: number, headerBytes: number): DriveError {
  return new DriveError(
    'TRUNCATED',
    `Slice buffer is ${length} bytes, shorter than its ${headerBytes}-byte header; pass the complete slice.`,
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
