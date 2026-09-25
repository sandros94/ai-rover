import type { Chunk } from './chunk'
import { assertChunkCoord } from './chunk'
import { TerrainError } from './errors'

/** Chunk format version written by {@link encodeChunk}. */
export const CHUNK_FORMAT_VERSION = 1
/** Bytes before the height array: magic, version, flags, vertexCount, cx, cy, cellSize. */
export const CHUNK_HEADER_BYTES = 20

const MAGIC = new TextEncoder().encode('JRTC')

/**
 * Chunk format v1, little-endian: `"JRTC"`, u8 version, u8 flags (0), u16 vertexCount, i32 cx,
 * i32 cy, f32 cellSize, f32 heights[vertexCount²], u8 masks[vertexCount²].
 */
export function encodeChunk(chunk: Chunk): Uint8Array {
  const { cx, cy, vertexCount, cellSize, heights, masks } = chunk
  assertChunkCoord('cx', cx)
  assertChunkCoord('cy', cy)
  if (!Number.isInteger(vertexCount) || vertexCount < 2 || vertexCount > 0xffff) {
    throw new TerrainError(
      'INVALID_GRID',
      `Chunk vertexCount is ${vertexCount}; pass an integer from 2 to 65535.`,
    )
  }
  if (!Number.isFinite(cellSize) || cellSize <= 0 || Math.fround(cellSize) !== cellSize) {
    throw new TerrainError(
      'INVALID_GRID',
      `Chunk cellSize is ${cellSize}; pass a positive value exactly representable as float32.`,
    )
  }
  const count = vertexCount * vertexCount
  if (heights.length !== count || masks.length !== count) {
    throw new TerrainError(
      'INVALID_GRID',
      `Chunk arrays hold ${heights.length} heights and ${masks.length} masks; vertexCount ${vertexCount} needs ${count} of each.`,
    )
  }
  const bytes = new Uint8Array(CHUNK_HEADER_BYTES + count * 5)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  view.setUint8(4, CHUNK_FORMAT_VERSION)
  view.setUint8(5, 0)
  view.setUint16(6, vertexCount, true)
  view.setInt32(8, cx, true)
  view.setInt32(12, cy, true)
  view.setFloat32(16, cellSize, true)
  for (let k = 0; k < count; k++) view.setFloat32(CHUNK_HEADER_BYTES + k * 4, heights[k]!, true)
  bytes.set(masks, CHUNK_HEADER_BYTES + count * 4)
  return bytes
}

/** Decodes format v1 into fresh arrays; the input may be any view, aligned or not. */
export function decodeChunk(bytes: Uint8Array): Chunk {
  if (bytes.byteLength < MAGIC.length) {
    throw new TerrainError(
      'TRUNCATED',
      `Chunk buffer is ${bytes.byteLength} bytes, shorter than its ${CHUNK_HEADER_BYTES}-byte header; pass the complete chunk.`,
    )
  }
  for (let k = 0; k < MAGIC.length; k++) {
    if (bytes[k] !== MAGIC[k]) {
      const found = Array.from(bytes.subarray(0, MAGIC.length), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(' ')
      throw new TerrainError(
        'INVALID_MAGIC',
        `Chunk buffer starts with bytes ${found}, not "JRTC"; pass bytes produced by encodeChunk.`,
      )
    }
  }
  if (bytes.byteLength < CHUNK_HEADER_BYTES) {
    throw new TerrainError(
      'TRUNCATED',
      `Chunk buffer is ${bytes.byteLength} bytes, shorter than its ${CHUNK_HEADER_BYTES}-byte header; pass the complete chunk.`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(4)
  if (version !== CHUNK_FORMAT_VERSION) {
    throw new TerrainError(
      'UNSUPPORTED_VERSION',
      `Chunk format version is ${version}; this decoder reads version ${CHUNK_FORMAT_VERSION} only.`,
    )
  }
  const flags = view.getUint8(5)
  if (flags !== 0) {
    throw new TerrainError(
      'UNSUPPORTED_VERSION',
      `Chunk format v1 flags are 0x${flags.toString(16)}; this decoder reads flags 0 only.`,
    )
  }
  const vertexCount = view.getUint16(6, true)
  const cx = view.getInt32(8, true)
  const cy = view.getInt32(12, true)
  const cellSize = view.getFloat32(16, true)
  const count = vertexCount * vertexCount
  const expected = CHUNK_HEADER_BYTES + count * 5
  if (bytes.byteLength < expected) {
    throw new TerrainError(
      'TRUNCATED',
      `Chunk buffer is ${bytes.byteLength} bytes; vertexCount ${vertexCount} needs ${expected}. Pass the complete chunk.`,
    )
  }
  if (bytes.byteLength > expected) {
    throw new TerrainError(
      'TRAILING_DATA',
      `Chunk buffer is ${bytes.byteLength} bytes; vertexCount ${vertexCount} needs exactly ${expected}. Pass one chunk per buffer.`,
    )
  }
  const heights = new Float32Array(count)
  for (let k = 0; k < count; k++) heights[k] = view.getFloat32(CHUNK_HEADER_BYTES + k * 4, true)
  const masks = bytes.slice(CHUNK_HEADER_BYTES + count * 4, expected)
  return { cx, cy, vertexCount, cellSize, heights, masks }
}
