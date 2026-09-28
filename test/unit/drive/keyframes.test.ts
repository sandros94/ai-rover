import { describe, expect, it } from 'vitest'
import type { SegmentRecord } from '#shared/utils/drive'
import {
  decodeKeyframes,
  encodeKeyframes,
  interpolatePose,
  KEYFRAME_FIELDS,
  KEYFRAME_FORMAT_VERSION,
  KEYFRAME_HEADER_BYTES,
  KEYFRAME_STRIDE,
} from '#shared/utils/drive'
import { driveErrorOf, F } from './helpers'

/** Three frames 0.5 s apart; the quaternion turns 90° about z over the block. */
function sample(): SegmentRecord['keyframes'] {
  const count = 3
  const data = new Float32Array(23 * count)
  for (let k = 0; k < count; k++) {
    const f = data.subarray(23 * k, 23 * (k + 1))
    const half = (k * Math.PI) / 8
    f.set([k / 2, k, 2 * k, 0.1 * k, 0, 0, Math.sin(half), Math.cos(half), 0.04])
    for (let w = 0; w < 6; w++) f[9 + w] = k * (w + 1)
    f.set([0.01 * k, -0.01 * k, 0.02 * k, -0.02 * k], 15)
    f.set([-0.4 * k, 0.4 * k, 0.35 * k, -0.35 * k], 19)
  }
  return { hz: 2, stride: 23, count, data }
}

/** `keyframes` as format v1 wrote them: 19-value frames, no steering. */
function encodeV1(keyframes: SegmentRecord['keyframes']): Uint8Array {
  const { count, hz, data } = keyframes
  const bytes = new Uint8Array(16 + count * 19 * 4)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('JRKF'), 0)
  view.setUint8(4, 1)
  view.setUint16(6, 19, true)
  view.setUint32(8, count, true)
  view.setFloat32(12, hz, true)
  for (let f = 0; f < count; f++) {
    for (let k = 0; k < 19; k++) view.setFloat32(16 + (f * 19 + k) * 4, data[f * 23 + k]!, true)
  }
  return bytes
}

describe('keyframe binary format v2', () => {
  it('lays out 23 fields, the four steering angles last', () => {
    expect(KEYFRAME_FIELDS).toHaveLength(23)
    expect(KEYFRAME_STRIDE).toBe(23)
    expect(KEYFRAME_FORMAT_VERSION).toBe(2)
    expect(KEYFRAME_FIELDS.slice(19)).toEqual(['steerFL', 'steerFR', 'steerRL', 'steerRR'])
    expect(KEYFRAME_HEADER_BYTES).toBe(16)
  })

  it('writes the documented header', () => {
    const bytes = encodeKeyframes(sample())
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('JRKF')
    expect(view.getUint8(4)).toBe(2)
    expect(view.getUint8(5)).toBe(0)
    expect(view.getUint16(6, true)).toBe(23)
    expect(view.getUint32(8, true)).toBe(3)
    expect(view.getFloat32(12, true)).toBe(2)
    expect(view.getFloat32(16 + 4 * 23, true)).toBe(0.5)
    expect(bytes.byteLength).toBe(16 + 3 * 23 * 4)
  })

  it('reads format v1 frames as straight wheels', () => {
    const keyframes = sample()
    const decoded = decodeKeyframes(encodeV1(keyframes))
    expect(decoded.stride).toBe(23)
    expect(decoded.count).toBe(3)
    for (let f = 0; f < 3; f++) {
      const frame = decoded.data.subarray(f * 23, (f + 1) * 23)
      expect(frame.subarray(0, 19)).toEqual(keyframes.data.subarray(f * 23, f * 23 + 19))
      expect(Array.from(frame.subarray(19))).toEqual([0, 0, 0, 0])
    }
    // Re-encoding writes the current version.
    expect(encodeKeyframes(decoded)[4]).toBe(2)
  })

  it('round-trips byte-identically, also from an unaligned view', () => {
    const keyframes = sample()
    const bytes = encodeKeyframes(keyframes)
    expect(decodeKeyframes(bytes)).toEqual(keyframes)
    expect(encodeKeyframes(decodeKeyframes(bytes))).toEqual(bytes)
    const padded = new Uint8Array(bytes.byteLength + 1)
    padded.set(bytes, 1)
    expect(decodeKeyframes(padded.subarray(1))).toEqual(keyframes)
  })

  it('refuses a wrong magic, version, flags or stride', () => {
    const cases: [number, number, string][] = [
      [0, 0x58, 'INVALID_RECORD'],
      [4, 3, 'UNSUPPORTED_VERSION'],
      [5, 1, 'UNSUPPORTED_VERSION'],
      [6, 19, 'INVALID_RECORD'],
    ]
    for (const [offset, value, code] of cases) {
      const bytes = encodeKeyframes(sample())
      bytes[offset] = value
      expect(driveErrorOf(() => decodeKeyframes(bytes))?.code).toBe(code)
    }
    // A v1 header must declare the v1 stride.
    const v1 = encodeV1(sample())
    v1[6] = 23
    expect(driveErrorOf(() => decodeKeyframes(v1))?.code).toBe('INVALID_RECORD')
  })

  it('refuses truncated buffers and trailing bytes', () => {
    const bytes = encodeKeyframes(sample())
    for (const length of [3, 12, bytes.byteLength - 1]) {
      expect(driveErrorOf(() => decodeKeyframes(bytes.subarray(0, length)))?.code).toBe('TRUNCATED')
    }
    const longer = new Uint8Array(bytes.byteLength + 4)
    longer.set(bytes)
    expect(driveErrorOf(() => decodeKeyframes(longer))?.code).toBe('TRAILING_DATA')
  })

  it('refuses to encode a block whose sizes disagree', () => {
    const keyframes = sample()
    expect(driveErrorOf(() => encodeKeyframes({ ...keyframes, count: 4 }))?.code).toBe(
      'INVALID_RECORD',
    )
    expect(driveErrorOf(() => encodeKeyframes({ ...keyframes, hz: 0 }))?.code).toBe(
      'INVALID_RECORD',
    )
  })
})

describe('interpolatePose', () => {
  const keyframes = sample()

  it('returns frames exactly at their times', () => {
    expect(interpolatePose(keyframes, 0.5)).toEqual(keyframes.data.subarray(23, 46))
  })

  it('interpolates linearly and slerps the quaternion', () => {
    const tuple = interpolatePose(keyframes, 0.25)
    expect(tuple[F.t]).toBe(0.25)
    expect(tuple[F.x]).toBeCloseTo(0.5, 6)
    expect(tuple[F.y]).toBeCloseTo(1, 6)
    expect(tuple[F.z]).toBeCloseTo(0.05, 6)
    expect(tuple[F.spinRR]).toBeCloseTo(3, 5)
    expect(tuple[F.bogieR]).toBeCloseTo(-0.01, 6)
    expect(tuple[F.steerFL]).toBeCloseTo(-0.2, 6)
    expect(tuple[F.steerRL]).toBeCloseTo(0.175, 6)
    // Halfway through a 45° yaw: 22.5°, unit length.
    expect(tuple[F.qz]).toBeCloseTo(Math.sin(Math.PI / 16), 6)
    expect(tuple[F.qw]).toBeCloseTo(Math.cos(Math.PI / 16), 6)
  })

  it('takes the short way round when neighbouring quaternions have opposite signs', () => {
    const flipped = sample()
    const second = flipped.data.subarray(23, 46)
    for (const k of [F.qx, F.qy, F.qz, F.qw]) second[k] = -second[k]!
    const tuple = interpolatePose(flipped, 0.25)
    const angle = 2 * Math.atan2(Math.abs(tuple[F.qz]!), Math.abs(tuple[F.qw]!))
    expect(angle).toBeCloseTo(Math.PI / 8, 5)
  })

  it('refuses a non-finite time and a malformed block', () => {
    expect(driveErrorOf(() => interpolatePose(keyframes, Number.NaN))?.code).toBe('INVALID_INPUT')
    expect(driveErrorOf(() => interpolatePose({ ...keyframes, count: 0 }, 0))?.code).toBe(
      'INVALID_RECORD',
    )
  })
})
