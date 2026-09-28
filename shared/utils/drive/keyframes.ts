import { DriveError } from './errors'

/**
 * Fields of one keyframe, in storage order: sim time (s), body origin in world metres, the
 * world-from-body quaternion, ground speed (m/s), cumulative wheel rotation (rad, order FL, FR,
 * ML, MR, RL, RR), the rocker and bogie angles (rad) as `RoverPose` defines them, then the corner
 * steering angles (rad, order FL, FR, RL, RR) as `SteeringAngles` defines them.
 */
export const KEYFRAME_FIELDS = [
  't',
  'x',
  'y',
  'z',
  'qx',
  'qy',
  'qz',
  'qw',
  'speed',
  'spinFL',
  'spinFR',
  'spinML',
  'spinMR',
  'spinRL',
  'spinRR',
  'rockerL',
  'rockerR',
  'bogieL',
  'bogieR',
  'steerFL',
  'steerFR',
  'steerRL',
  'steerRR',
] as const

export const KEYFRAME_STRIDE = 23
/** Keyframe format version written by {@link encodeKeyframes}. */
export const KEYFRAME_FORMAT_VERSION = 2
/**
 * Values per frame by keyframe format version. Version 1 frames end at `bogieR`: they predate
 * steering, and read as straight wheels.
 */
export const KEYFRAME_STRIDES: Readonly<Record<number, number>> = Object.freeze({ 1: 19, 2: 23 })
/** Bytes before the frames: magic, version, flags, stride, count, hz. */
export const KEYFRAME_HEADER_BYTES = 16

const MAGIC = new TextEncoder().encode('JRKF')
const QX = 4
const QW = 7

/** Frames sampled every `1 / hz` seconds from t = 0; frame k is `data[23k … 23k + 22]`. */
export interface KeyframeBlock {
  hz: number
  stride: 23
  count: number
  data: Float32Array
}

/**
 * Keyframe format v2, little-endian: `"JRKF"`, u8 version, u8 flags (0), u16 stride (23),
 * u32 count, f32 hz, then f32 data[23 · count]. Version 1 is the same with stride 19.
 */
export function encodeKeyframes(keyframes: KeyframeBlock): Uint8Array {
  assertBlock(keyframes, 'encodeKeyframes', 0)
  const { hz, count, data } = keyframes
  if (Math.fround(hz) !== hz) {
    throw new DriveError(
      'INVALID_RECORD',
      `encodeKeyframes: hz is ${hz}; pass a rate exactly representable as float32.`,
    )
  }
  const bytes = new Uint8Array(KEYFRAME_HEADER_BYTES + data.length * 4)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  view.setUint8(4, KEYFRAME_FORMAT_VERSION)
  view.setUint8(5, 0)
  view.setUint16(6, KEYFRAME_STRIDE, true)
  view.setUint32(8, count, true)
  view.setFloat32(12, hz, true)
  for (let k = 0; k < data.length; k++)
    view.setFloat32(KEYFRAME_HEADER_BYTES + k * 4, data[k]!, true)
  return bytes
}

/**
 * Decodes format v2 or v1 into a fresh block of the current layout, a v1 frame's steering angles
 * zero; the input may be any view, aligned or not.
 */
export function decodeKeyframes(bytes: Uint8Array): KeyframeBlock {
  if (bytes.byteLength < MAGIC.length) {
    throw new DriveError(
      'TRUNCATED',
      `Keyframe buffer is ${bytes.byteLength} bytes, shorter than its ${KEYFRAME_HEADER_BYTES}-byte header; pass the complete block.`,
    )
  }
  for (let k = 0; k < MAGIC.length; k++) {
    if (bytes[k] !== MAGIC[k]) {
      const found = Array.from(bytes.subarray(0, MAGIC.length), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(' ')
      throw new DriveError(
        'INVALID_RECORD',
        `Keyframe buffer starts with bytes ${found}, not "JRKF"; pass bytes produced by encodeKeyframes.`,
      )
    }
  }
  if (bytes.byteLength < KEYFRAME_HEADER_BYTES) {
    throw new DriveError(
      'TRUNCATED',
      `Keyframe buffer is ${bytes.byteLength} bytes, shorter than its ${KEYFRAME_HEADER_BYTES}-byte header; pass the complete block.`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(4)
  const written = KEYFRAME_STRIDES[version]
  if (written === undefined) {
    throw new DriveError(
      'UNSUPPORTED_VERSION',
      `Keyframe format version is ${version}; this decoder reads versions ${Object.keys(KEYFRAME_STRIDES).join(' and ')}.`,
    )
  }
  const flags = view.getUint8(5)
  if (flags !== 0) {
    throw new DriveError(
      'UNSUPPORTED_VERSION',
      `Keyframe format v${version} flags are 0x${flags.toString(16)}; this decoder reads flags 0 only.`,
    )
  }
  const stride = view.getUint16(6, true)
  const count = view.getUint32(8, true)
  const hz = view.getFloat32(12, true)
  if (stride !== written || !(Number.isFinite(hz) && hz > 0)) {
    throw new DriveError(
      'INVALID_RECORD',
      `Keyframe header declares stride ${stride} and hz ${hz}; format v${version} has stride ${written} and a positive rate. Pass bytes produced by encodeKeyframes.`,
    )
  }
  const expected = KEYFRAME_HEADER_BYTES + count * written * 4
  if (bytes.byteLength < expected) {
    throw new DriveError(
      'TRUNCATED',
      `Keyframe buffer is ${bytes.byteLength} bytes; ${count} frames need ${expected}. Pass the complete block.`,
    )
  }
  if (bytes.byteLength > expected) {
    throw new DriveError(
      'TRAILING_DATA',
      `Keyframe buffer is ${bytes.byteLength} bytes; ${count} frames need exactly ${expected}. Pass one block per buffer.`,
    )
  }
  const data = readFrames(view, KEYFRAME_HEADER_BYTES, count, written)
  return { hz, stride: KEYFRAME_STRIDE, count, data }
}

/**
 * `count` little-endian float32 frames of `stride` values from `offset` of `view`, laid out in
 * the current {@link KEYFRAME_STRIDE}: fields a shorter, older frame lacks stay zero.
 */
export function readFrames(
  view: DataView,
  offset: number,
  count: number,
  stride: number,
): Float32Array {
  const data = new Float32Array(count * KEYFRAME_STRIDE)
  for (let f = 0; f < count; f++) {
    for (let k = 0; k < stride; k++) {
      data[f * KEYFRAME_STRIDE + k] = view.getFloat32(offset + (f * stride + k) * 4, true)
    }
  }
  return data
}

/**
 * The 23 keyframe values at time `t`, clamped to the first and last frames: linear between the
 * two frames around `t` for every field but the quaternion, which is slerped along the shorter
 * arc. Heights come out linear too, so a renderer that needs wheels on the ground re-solves the
 * pose from the interpolated x, y and heading rather than trusting z.
 */
export function interpolatePose(keyframes: KeyframeBlock, t: number): Float32Array {
  assertBlock(keyframes, 'interpolatePose', 1)
  if (!Number.isFinite(t)) {
    throw new DriveError('INVALID_INPUT', `interpolatePose: t is ${t}; pass finite seconds.`)
  }
  const { hz, count, data } = keyframes
  const S = KEYFRAME_STRIDE
  const first = data[0]!
  const last = data[(count - 1) * S]!
  if (t <= first) return data.slice(0, S)
  if (t >= last) return data.slice((count - 1) * S, count * S)

  let i = Math.min(count - 2, Math.max(0, Math.floor((t - first) * hz)))
  while (i < count - 2 && data[(i + 1) * S]! <= t) i++
  while (i > 0 && data[i * S]! > t) i--
  const a = i * S
  const b = a + S
  const u = (t - data[a]!) / (data[b]! - data[a]!)
  const out = new Float32Array(S)
  for (let k = 1; k < S; k++) out[k] = data[a + k]! + (data[b + k]! - data[a + k]!) * u
  out[0] = t

  let dot = 0
  for (let k = QX; k <= QW; k++) dot += data[a + k]! * data[b + k]!
  // q and −q are the same rotation; flipping one keeps the slerp on the shorter arc.
  const sign = dot < 0 ? -1 : 1
  dot *= sign
  let wa = 1 - u
  let wb = u * sign
  if (dot < 0.9995) {
    const theta = Math.acos(dot)
    const sin = Math.sin(theta)
    wa = Math.sin((1 - u) * theta) / sin
    wb = (Math.sin(u * theta) / sin) * sign
  }
  let norm = 0
  const q = [0, 0, 0, 0]
  for (let k = 0; k < 4; k++) {
    q[k] = wa * data[a + QX + k]! + wb * data[b + QX + k]!
    norm += q[k]! * q[k]!
  }
  norm = Math.sqrt(norm)
  for (let k = 0; k < 4; k++) out[QX + k] = q[k]! / norm
  return out
}

function assertBlock(keyframes: KeyframeBlock, context: string, minCount: number): void {
  const { hz, count, data } = keyframes
  // Typed as the literal 23; untyped callers can still hand over anything.
  const stride: number = keyframes.stride
  if (stride !== KEYFRAME_STRIDE) {
    throw new DriveError(
      'INVALID_RECORD',
      `${context}: stride is ${stride}; keyframes hold ${KEYFRAME_STRIDE} values per frame.`,
    )
  }
  if (!Number.isInteger(count) || count < minCount || count > 0xffffffff) {
    throw new DriveError(
      'INVALID_RECORD',
      `${context}: count is ${count}; pass an integer from ${minCount} to 4294967295.`,
    )
  }
  if (data.length !== count * KEYFRAME_STRIDE) {
    throw new DriveError(
      'INVALID_RECORD',
      `${context}: data holds ${data.length} values; ${count} frames need ${count * KEYFRAME_STRIDE}.`,
    )
  }
  if (!(Number.isFinite(hz) && hz > 0)) {
    throw new DriveError('INVALID_RECORD', `${context}: hz is ${hz}; pass a positive frame rate.`)
  }
}
