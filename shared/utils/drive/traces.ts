import { DriveError } from './errors'

/** Sim seconds between the path points a trace keeps: a few centimetres of ground at rover speed. */
export const TRACE_PATH_SECONDS = 5
/** Trace format version written by {@link encodeTrace}. */
export const TRACE_FORMAT_VERSION = 1
/** Bytes before the reveal times: magic, version, flags, sliceIndex, groupCount, vertexCount, pathCount. */
export const TRACE_HEADER_BYTES = 22

const MAGIC = new TextEncoder().encode('JRTR')
/** Values per path point: t, x, y, z. */
const POINT = 4

/**
 * What every viewer of a drive needs of slice `index` from t = 0, apart from its keyframes: the
 * reveal groups it holds and a light path of the rover through it. Released with its slice.
 */
export interface SliceTrace {
  index: number
  /** Newly seen vertices as disk-grid indices, time-ordered, as the record lists them. */
  reveals: { t: number; vertices: Uint32Array }[]
  /**
   * `t, x, y, z` of the slice's frames every {@link TRACE_PATH_SECONDS} of the drive, and of its
   * last frame; empty for a slice without frames.
   */
  path: Float32Array
}

/**
 * Trace format v1, little-endian: `"JRTR"`, u8 version, u8 flags (0), u32 sliceIndex,
 * u32 groupCount, u32 vertexCount, u32 pathCount, then f64 group times[groupCount],
 * u32 group sizes[groupCount], u32 vertices[vertexCount] (the groups back to back) and
 * f32 path[4 · pathCount].
 */
export function encodeTrace(trace: SliceTrace): Uint8Array {
  const { index, reveals, path } = trace
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new DriveError(
      'INVALID_RECORD',
      `encodeTrace: slice index is ${index}; pass an integer from 0 to 2³² − 1.`,
    )
  }
  if (path.length % POINT !== 0) {
    throw new DriveError(
      'INVALID_RECORD',
      `encodeTrace: trace ${index} path holds ${path.length} values, not a multiple of ${POINT}; pass whole points.`,
    )
  }
  if (!reveals.every(({ t }) => Number.isFinite(t))) {
    throw new DriveError(
      'INVALID_RECORD',
      `encodeTrace: trace ${index} has a reveal time that is not finite; pass reveals as driveSegment records them.`,
    )
  }
  const vertexCount = reveals.reduce((n, r) => n + r.vertices.length, 0)
  const groups = reveals.length
  const bytes = new Uint8Array(TRACE_HEADER_BYTES + groups * 12 + vertexCount * 4 + path.length * 4)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  view.setUint8(4, TRACE_FORMAT_VERSION)
  view.setUint8(5, 0)
  view.setUint32(6, index, true)
  view.setUint32(10, groups, true)
  view.setUint32(14, vertexCount, true)
  view.setUint32(18, path.length / POINT, true)
  let offset = TRACE_HEADER_BYTES
  for (const { t } of reveals) {
    view.setFloat64(offset, t, true)
    offset += 8
  }
  for (const { vertices } of reveals) {
    view.setUint32(offset, vertices.length, true)
    offset += 4
  }
  for (const { vertices } of reveals) {
    for (const vertex of vertices) {
      view.setUint32(offset, vertex, true)
      offset += 4
    }
  }
  for (const value of path) {
    view.setFloat32(offset, value, true)
    offset += 4
  }
  return bytes
}

/** Decodes format v1 into fresh arrays; the input may be any view, aligned or not. */
export function decodeTrace(bytes: Uint8Array): SliceTrace {
  if (bytes.byteLength < TRACE_HEADER_BYTES) {
    throw new DriveError(
      'TRUNCATED',
      `Trace buffer is ${bytes.byteLength} bytes, shorter than its ${TRACE_HEADER_BYTES}-byte header; pass the complete trace.`,
    )
  }
  for (let k = 0; k < MAGIC.length; k++) {
    if (bytes[k] !== MAGIC[k]) {
      const found = Array.from(bytes.subarray(0, MAGIC.length), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(' ')
      throw new DriveError(
        'INVALID_RECORD',
        `Trace buffer starts with bytes ${found}, not "JRTR"; pass bytes produced by encodeTrace.`,
      )
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(4)
  const flags = view.getUint8(5)
  if (version !== TRACE_FORMAT_VERSION || flags !== 0) {
    throw new DriveError(
      'UNSUPPORTED_VERSION',
      `Trace format version ${version}, flags 0x${flags.toString(16)}; this decoder reads version ${TRACE_FORMAT_VERSION} with flags 0.`,
    )
  }
  const index = view.getUint32(6, true)
  const groups = view.getUint32(10, true)
  const vertexCount = view.getUint32(14, true)
  const pathCount = view.getUint32(18, true)
  const expected = TRACE_HEADER_BYTES + groups * 12 + vertexCount * 4 + pathCount * POINT * 4
  if (bytes.byteLength !== expected) {
    throw new DriveError(
      bytes.byteLength < expected ? 'TRUNCATED' : 'TRAILING_DATA',
      `Trace buffer is ${bytes.byteLength} bytes; its header declares exactly ${expected}. Pass one complete trace.`,
    )
  }
  let offset = TRACE_HEADER_BYTES
  const times: number[] = []
  for (let g = 0; g < groups; g++, offset += 8) times.push(view.getFloat64(offset, true))
  const sizes: number[] = []
  for (let g = 0; g < groups; g++, offset += 4) sizes.push(view.getUint32(offset, true))
  const listed = sizes.reduce((n, size) => n + size, 0)
  if (listed !== vertexCount || !times.every(Number.isFinite)) {
    throw new DriveError(
      'INVALID_RECORD',
      `Trace ${index} groups list ${listed} vertices at times ${times.join(', ')}; its header declares ${vertexCount}, at finite times. Pass bytes produced by encodeTrace.`,
    )
  }
  const reveals = times.map((t, g) => {
    const vertices = new Uint32Array(sizes[g]!)
    for (let k = 0; k < vertices.length; k++, offset += 4)
      vertices[k] = view.getUint32(offset, true)
    return { t, vertices }
  })
  const path = new Float32Array(pathCount * POINT)
  for (let k = 0; k < path.length; k++, offset += 4) path[k] = view.getFloat32(offset, true)
  return { index, reveals, path }
}

/** Traces a block holds: slices `16b … 16b + 15` (see `segmentTraceBlockKey`). */
export const TRACE_BLOCK = 16
/** Trace block format version written by {@link encodeTraceBlock}. */
export const TRACE_BLOCK_FORMAT_VERSION = 1
/** Bytes before the first entry: magic, version, flags, count. */
export const TRACE_BLOCK_HEADER_BYTES = 10

const BLOCK_MAGIC = new TextEncoder().encode('JRTB')

/**
 * Trace block format v1, little-endian, the disk pack's layout: `"JRTB"`, u8 version, u8 flags
 * (0), u32 count, then per trace a u32 byteLength and its {@link encodeTrace} bytes, in slice
 * order. Built from stored traces as they are, so a block never differs from its traces.
 */
export function encodeTraceBlock(traces: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    traces.reduce((sum, trace) => sum + 4 + trace.byteLength, TRACE_BLOCK_HEADER_BYTES),
  )
  const view = new DataView(bytes.buffer)
  bytes.set(BLOCK_MAGIC, 0)
  view.setUint8(4, TRACE_BLOCK_FORMAT_VERSION)
  view.setUint8(5, 0)
  view.setUint32(6, traces.length, true)
  let offset = TRACE_BLOCK_HEADER_BYTES
  for (const trace of traces) {
    view.setUint32(offset, trace.byteLength, true)
    bytes.set(trace, offset + 4)
    offset += 4 + trace.byteLength
  }
  return bytes
}

/** Decodes a whole format v1 block into its traces, in block order. */
export function decodeTraceBlock(bytes: Uint8Array): SliceTrace[] {
  const invalid = (code: 'INVALID_RECORD' | 'UNSUPPORTED_VERSION' | 'TRUNCATED', why: string) =>
    new DriveError(code, `Trace block ${why}; pass bytes produced by encodeTraceBlock.`)
  if (bytes.byteLength < TRACE_BLOCK_HEADER_BYTES) {
    throw invalid('TRUNCATED', `is ${bytes.byteLength} bytes, shorter than its header`)
  }
  if (BLOCK_MAGIC.some((b, k) => bytes[k] !== b)) throw invalid('INVALID_RECORD', 'is not "JRTB"')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint8(4) !== TRACE_BLOCK_FORMAT_VERSION || view.getUint8(5) !== 0) {
    throw invalid(
      'UNSUPPORTED_VERSION',
      `has version ${view.getUint8(4)}, flags ${view.getUint8(5)}`,
    )
  }
  const count = view.getUint32(6, true)
  const traces: SliceTrace[] = []
  let offset = TRACE_BLOCK_HEADER_BYTES
  for (let n = 0; n < count; n++) {
    if (bytes.byteLength < offset + 4) throw invalid('TRUNCATED', `ends inside trace ${n + 1}`)
    const length = view.getUint32(offset, true)
    offset += 4
    if (bytes.byteLength < offset + length) throw invalid('TRUNCATED', `ends inside trace ${n + 1}`)
    traces.push(decodeTrace(bytes.subarray(offset, offset + length)))
    offset += length
  }
  if (offset !== bytes.byteLength) {
    throw new DriveError(
      'TRAILING_DATA',
      `Trace block continues ${bytes.byteLength - offset} bytes past its ${count} traces; pass one block per buffer.`,
    )
  }
  return traces
}
