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
 * The 23 keyframe values at time `t`, clamped to the first and last frames, smooth across frames:
 * the velocity, heading rate and steering rates carry over each frame without a jump.
 *
 * - Position (x, y) follows a cubic Hermite whose tangent at each frame is the recorded ground
 *   speed along the recorded heading, so a speed ramp stays a ramp between frames.
 * - Heading and the corner steering angles follow a monotone cubic (Fritsch–Butland slopes from
 *   the neighbouring frames): no overshoot past either frame, and a standstill stays still.
 * - The attitude is slerped along the shorter arc, then turned about the vertical onto that
 *   heading, keeping its pitch and roll.
 * - The wheel spins, height, rocker and bogie advance with the distance covered along the
 *   interval (with the heading turned when the body does not translate), so the wheels roll as
 *   far as the rover moves; `speed` is the rate of that distance.
 *
 * Heights stay a blend of the two frames, so a renderer that needs wheels on the ground re-solves
 * the pose from the interpolated x, y and heading rather than trusting z.
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
  const dt = data[b]! - data[a]!
  const u = (t - data[a]!) / dt
  if (u === 0) return data.slice(a, b)
  const out = new Float32Array(S)
  out[0] = t

  const time = (k: number): number => data[k * S]!
  const yaw = (k: number): number => yawOf(data, k * S)
  const yawA = yaw(i)
  const turned = wrap(yaw(i + 1) - yawA)
  const turnDelta = (k0: number, k1: number): number => wrap(yaw(k1) - yaw(k0))
  const heading =
    yawA +
    hermite(
      u,
      0,
      dt * monotoneSlope(i, count, time, turnDelta),
      turned,
      dt * monotoneSlope(i + 1, count, time, turnDelta),
    )

  // Distance along the interval as a share of the chord, on the speeds the frames recorded.
  const dx = data[b + X]! - data[a + X]!
  const dy = data[b + Y]! - data[a + Y]!
  const chord = Math.hypot(dx, dy)
  let share: number
  if (chord > MOVED_M) {
    // Tangents longer than three chords would carry the curve past the next frame and back
    // (Fritsch–Carlson): frames around an emergency stop can record such speeds.
    const alpha = Math.min(3, (data[a + SPEED]! * dt) / chord)
    const beta = Math.min(3, (data[b + SPEED]! * dt) / chord)
    const yawB = yawA + turned
    const m0 = alpha * chord
    const m1 = beta * chord
    out[X] = hermite(u, data[a + X]!, m0 * Math.cos(yawA), data[b + X]!, m1 * Math.cos(yawB))
    out[Y] = hermite(u, data[a + Y]!, m0 * Math.sin(yawA), data[b + Y]!, m1 * Math.sin(yawB))
    share = hermite(u, 0, alpha, 1, beta)
    out[SPEED] = Math.max(0, (chord * hermiteRate(u, 0, alpha, 1, beta)) / dt)
  } else {
    out[X] = data[a + X]! + dx * u
    out[Y] = data[a + Y]! + dy * u
    share = Math.abs(turned) > TURNED_RAD ? (heading - yawA) / turned : u
    out[SPEED] = 0
  }
  for (const k of ALONG) out[k] = data[a + k]! + (data[b + k]! - data[a + k]!) * share
  for (let k = STEER; k < S; k++) {
    const delta = (k0: number, k1: number): number => data[k1 * S + k]! - data[k0 * S + k]!
    out[k] = hermite(
      u,
      data[a + k]!,
      dt * monotoneSlope(i, count, time, delta),
      data[b + k]!,
      dt * monotoneSlope(i + 1, count, time, delta),
    )
  }

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
  const [x, y, z, w] = q.map((v) => v / norm) as [number, number, number, number]
  // Rz(δ) · q turns the attitude about the world vertical, heading by δ, pitch and roll kept.
  const half = wrap(heading - Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))) / 2
  const c = Math.cos(half)
  const s = Math.sin(half)
  out[QX] = c * x - s * y
  out[QX + 1] = c * y + s * x
  out[QX + 2] = c * z + s * w
  out[QW] = c * w - s * z
  return out
}

const X = 1
const Y = 2
const SPEED = 8
const STEER = 19
/** Fields that advance with the distance covered: height, spins, rocker and bogie. */
const ALONG = [3, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const
/** Below these the body counts as not translating, or not turning, between two frames. */
const MOVED_M = 1e-6
const TURNED_RAD = 1e-9

/** Heading (yaw) of the world-from-body quaternion stored from `offset`. */
function yawOf(data: Float32Array, offset: number): number {
  const x = data[offset + QX]!
  const y = data[offset + QX + 1]!
  const z = data[offset + QX + 2]!
  const w = data[offset + QW]!
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

/** Cubic Hermite from `p0` to `p1` at `u` ∈ [0, 1], the tangents `m0`, `m1` per unit of `u`. */
function hermite(u: number, p0: number, m0: number, p1: number, m1: number): number {
  const u2 = u * u
  const u3 = u2 * u
  return (
    (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (3 * u2 - 2 * u3) * p1 + (u3 - u2) * m1
  )
}

/** The derivative of {@link hermite} with respect to `u`. */
function hermiteRate(u: number, p0: number, m0: number, p1: number, m1: number): number {
  const u2 = u * u
  return (6 * u2 - 6 * u) * (p0 - p1) + (3 * u2 - 4 * u + 1) * m0 + (3 * u2 - 2 * u) * m1
}

/**
 * Slope per second at frame `k` of a series whose change between frames `delta` gives
 * (Fritsch–Butland): zero where the series turns or holds on either side, else the weighted
 * harmonic mean of the two secants, which keeps each interval monotone; an end frame takes its
 * one secant.
 */
function monotoneSlope(
  k: number,
  count: number,
  time: (k: number) => number,
  delta: (k0: number, k1: number) => number,
): number {
  if (k === 0) return delta(0, 1) / (time(1) - time(0))
  if (k === count - 1) return delta(k - 1, k) / (time(k) - time(k - 1))
  const h0 = time(k) - time(k - 1)
  const h1 = time(k + 1) - time(k)
  const d0 = delta(k - 1, k) / h0
  const d1 = delta(k, k + 1) / h1
  if (d0 * d1 <= 0) return 0
  return (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1)
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
