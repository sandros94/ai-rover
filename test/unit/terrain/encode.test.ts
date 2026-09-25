import { describe, expect, it } from 'vitest'
import {
  decodeChunk,
  defineWorld,
  encodeChunk,
  generateChunk,
  TerrainError,
} from '#shared/utils/terrain'

const chunk = generateChunk(defineWorld({ seed: 'mars' }), { cx: -2, cy: 5 })

/** The TerrainError thrown by `fn`, or undefined when it throws nothing or something else. */
function terrainErrorOf(fn: () => unknown): TerrainError | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof TerrainError) return error
  }
  return undefined
}

describe('chunk binary format v1', () => {
  it('writes the documented header', () => {
    const bytes = encodeChunk(chunk)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('JRTC')
    expect(view.getUint8(4)).toBe(1)
    expect(view.getUint8(5)).toBe(0)
    expect(view.getUint16(6, true)).toBe(65)
    expect(view.getInt32(8, true)).toBe(-2)
    expect(view.getInt32(12, true)).toBe(5)
    expect(view.getFloat32(16, true)).toBe(1)
    expect(view.getFloat32(20, true)).toBe(chunk.heights[0])
    expect(bytes.byteLength).toBe(20 + 65 * 65 * 5)
  })

  it('round-trips byte-identically', () => {
    const bytes = encodeChunk(chunk)
    const decoded = decodeChunk(bytes)
    expect(decoded).toEqual(chunk)
    expect(encodeChunk(decoded)).toEqual(bytes)
  })

  it('decodes from an unaligned view', () => {
    const bytes = encodeChunk(chunk)
    const padded = new Uint8Array(bytes.byteLength + 1)
    padded.set(bytes, 1)
    expect(decodeChunk(padded.subarray(1))).toEqual(chunk)
  })

  it('refuses a wrong magic', () => {
    const bytes = encodeChunk(chunk)
    bytes[0] = 0x58
    expect(terrainErrorOf(() => decodeChunk(bytes))?.code).toBe('INVALID_MAGIC')
  })

  it('refuses an unknown version', () => {
    const bytes = encodeChunk(chunk)
    bytes[4] = 2
    expect(terrainErrorOf(() => decodeChunk(bytes))?.code).toBe('UNSUPPORTED_VERSION')
  })

  it('refuses truncated buffers', () => {
    const bytes = encodeChunk(chunk)
    expect(terrainErrorOf(() => decodeChunk(bytes.subarray(0, 3)))?.code).toBe('TRUNCATED')
    expect(terrainErrorOf(() => decodeChunk(bytes.subarray(0, 12)))?.code).toBe('TRUNCATED')
    expect(terrainErrorOf(() => decodeChunk(bytes.subarray(0, bytes.byteLength - 1)))?.code).toBe(
      'TRUNCATED',
    )
  })

  it('refuses trailing bytes', () => {
    const bytes = encodeChunk(chunk)
    const longer = new Uint8Array(bytes.byteLength + 4)
    longer.set(bytes)
    expect(terrainErrorOf(() => decodeChunk(longer))?.code).toBe('TRAILING_DATA')
  })
})
