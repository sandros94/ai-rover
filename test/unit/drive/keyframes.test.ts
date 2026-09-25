import { describe, expect, it } from 'vitest'
import type { SegmentRecord } from '#shared/utils/drive'
import {
  decodeKeyframes,
  encodeKeyframes,
  interpolatePose,
  KEYFRAME_FIELDS,
  KEYFRAME_HEADER_BYTES,
} from '#shared/utils/drive'
import { driveErrorOf, F } from './helpers'

/** Three frames 0.5 s apart; the quaternion turns 90° about z over the block. */
function sample(): SegmentRecord['keyframes'] {
  const count = 3
  const data = new Float32Array(19 * count)
  for (let k = 0; k < count; k++) {
    const f = data.subarray(19 * k, 19 * (k + 1))
    const half = (k * Math.PI) / 8
    f.set([k / 2, k, 2 * k, 0.1 * k, 0, 0, Math.sin(half), Math.cos(half), 0.04])
    for (let w = 0; w < 6; w++) f[9 + w] = k * (w + 1)
    f.set([0.01 * k, -0.01 * k, 0.02 * k, -0.02 * k], 15)
  }
  return { hz: 2, stride: 19, count, data }
}

describe('keyframe binary format v1', () => {
  it('lays out 19 fields', () => {
    expect(KEYFRAME_FIELDS).toHaveLength(19)
    expect(KEYFRAME_HEADER_BYTES).toBe(16)
  })

  it('writes the documented header', () => {
    const bytes = encodeKeyframes(sample())
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('JRKF')
    expect(view.getUint8(4)).toBe(1)
    expect(view.getUint8(5)).toBe(0)
    expect(view.getUint16(6, true)).toBe(19)
    expect(view.getUint32(8, true)).toBe(3)
    expect(view.getFloat32(12, true)).toBe(2)
    expect(view.getFloat32(16 + 4 * 19, true)).toBe(0.5)
    expect(bytes.byteLength).toBe(16 + 3 * 19 * 4)
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
      [4, 2, 'UNSUPPORTED_VERSION'],
      [5, 1, 'UNSUPPORTED_VERSION'],
      [6, 18, 'INVALID_RECORD'],
    ]
    for (const [offset, value, code] of cases) {
      const bytes = encodeKeyframes(sample())
      bytes[offset] = value
      expect(driveErrorOf(() => decodeKeyframes(bytes))?.code).toBe(code)
    }
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
    expect(interpolatePose(keyframes, 0.5)).toEqual(keyframes.data.subarray(19, 38))
  })

  it('interpolates linearly and slerps the quaternion', () => {
    const tuple = interpolatePose(keyframes, 0.25)
    expect(tuple[F.t]).toBe(0.25)
    expect(tuple[F.x]).toBeCloseTo(0.5, 6)
    expect(tuple[F.y]).toBeCloseTo(1, 6)
    expect(tuple[F.z]).toBeCloseTo(0.05, 6)
    expect(tuple[F.spinRR]).toBeCloseTo(3, 5)
    expect(tuple[F.bogieR]).toBeCloseTo(-0.01, 6)
    // Halfway through a 45° yaw: 22.5°, unit length.
    expect(tuple[F.qz]).toBeCloseTo(Math.sin(Math.PI / 16), 6)
    expect(tuple[F.qw]).toBeCloseTo(Math.cos(Math.PI / 16), 6)
  })

  it('takes the short way round when neighbouring quaternions have opposite signs', () => {
    const flipped = sample()
    const second = flipped.data.subarray(19, 38)
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
