import { assertChunkCoord } from './chunk'
import type { StopDisk } from './disk'
import { worldToVertex } from './disk'
import { TerrainError } from './errors'
import type { World } from './world'

/** Revealed-mask format version written by {@link encodeRevealedMask}. */
export const REVEALED_FORMAT_VERSION = 1
/** Bytes before the first chunk record: magic, version, flags, vertexCount, cellSize, chunkCount. */
export const REVEALED_HEADER_BYTES = 16

const MAGIC = new TextEncoder().encode('JRRV')

/**
 * What the rover has seen over the whole journey, stored sparsely per chunk in the chunk vertex
 * layout (shared edge vertices appear in every chunk that holds them). Chunk arrays may be shared
 * between successive masks, so treat them as read-only.
 */
export interface RevealedMask {
  version: 1
  cellSize: number
  vertexCount: number
  /** Key `"cx,cy"` → 1 byte per vertex, 0 or 1. Chunks with nothing seen are absent. */
  chunks: Map<string, Uint8Array>
}

export function createRevealedMask(world: World): RevealedMask {
  const { chunkSize, cellSize } = world.config
  return { version: 1, cellSize, vertexCount: chunkSize / cellSize + 1, chunks: new Map() }
}

/** A new mask with the disk's visible vertices OR-ed in; `mask` is left untouched. */
export function revealDisk(mask: RevealedMask, disk: StopDisk): RevealedMask {
  assertDiskAligned(mask, disk, 'revealDisk')
  const { vertexCount } = mask
  const cells = vertexCount - 1
  const { width } = disk.grid
  const chunks = new Map(mask.chunks)
  for (const { cx, cy } of disk.chunks) {
    const key = `${cx},${cy}`
    const gi = cx * cells - disk.origin.i
    const gj = cy * cells - disk.origin.j
    const current = mask.chunks.get(key)
    let target: Uint8Array | undefined
    for (let b = 0; b < vertexCount; b++) {
      const row = (gj + b) * width + gi
      for (let a = 0; a < vertexCount; a++) {
        const k = b * vertexCount + a
        if (!disk.visible[row + a] || current?.[k]) continue
        target ??= current ? current.slice() : new Uint8Array(vertexCount * vertexCount)
        target[k] = 1
      }
    }
    if (target) chunks.set(key, target)
  }
  return { version: 1, cellSize: mask.cellSize, vertexCount, chunks }
}

/**
 * A new mask with the given disk-grid vertices (`j · width + i`, as a segment record's reveals
 * list them) OR-ed in; `mask` is left untouched. A vertex on a chunk edge is set in every chunk
 * that stores it, as {@link revealDisk} does.
 */
export function revealVertices(
  mask: RevealedMask,
  disk: StopDisk,
  vertices: ArrayLike<number>,
): RevealedMask {
  assertDiskAligned(mask, disk, 'revealVertices')
  const { vertexCount } = mask
  const cells = vertexCount - 1
  const { width, height } = disk.grid
  const chunks = new Map(mask.chunks)
  const copied = new Set<string>()
  for (let n = 0; n < vertices.length; n++) {
    const k = vertices[n]!
    if (!Number.isSafeInteger(k) || k < 0 || k >= width * height) {
      throw new TerrainError(
        'OUT_OF_BOUNDS',
        `revealVertices: vertex ${k} is outside the ${width}×${height} disk grid; pass indices from a record driven over this disk.`,
      )
    }
    const gi = k % width
    const i = disk.origin.i + gi
    const j = disk.origin.j + (k - gi) / width
    const cx = Math.floor(i / cells)
    const cy = Math.floor(j / cells)
    const a = i - cx * cells
    const b = j - cy * cells
    for (const [ox, oy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      if ((ox && a !== 0) || (oy && b !== 0)) continue
      const key = `${cx - ox},${cy - oy}`
      const at = (b + oy * cells) * vertexCount + a + ox * cells
      let bits = chunks.get(key)
      if (bits?.[at]) continue
      if (!copied.has(key)) {
        bits = bits ? bits.slice() : new Uint8Array(vertexCount * vertexCount)
        chunks.set(key, bits)
        copied.add(key)
      }
      bits![at] = 1
    }
  }
  return { version: 1, cellSize: mask.cellSize, vertexCount, chunks }
}

/**
 * Per disk-grid vertex: 1 where the mask holds it as seen. Covers the whole grid, including
 * vertices outside the disk radius and in chunks the disk does not list.
 */
export function revealedOverDisk(mask: RevealedMask, disk: StopDisk): Uint8Array {
  assertDiskAligned(mask, disk, 'revealedOverDisk')
  const { vertexCount } = mask
  const cells = vertexCount - 1
  const { width, height } = disk.grid
  const out = new Uint8Array(width * height)
  const cx0 = disk.origin.i / cells
  const cy0 = disk.origin.j / cells
  // Shared edge vertices are OR-ed from every chunk that stores them.
  for (let by = 0; by < (height - 1) / cells; by++) {
    for (let bx = 0; bx < (width - 1) / cells; bx++) {
      const bits = mask.chunks.get(`${cx0 + bx},${cy0 + by}`)
      if (!bits) continue
      for (let b = 0; b < vertexCount; b++) {
        const row = (by * cells + b) * width + bx * cells
        for (let a = 0; a < vertexCount; a++) out[row + a]! |= bits[b * vertexCount + a]!
      }
    }
  }
  return out
}

/** Whether the vertex nearest `point` has been seen. */
export function isRevealed(
  mask: RevealedMask,
  world: World,
  point: { x: number; y: number },
): boolean {
  const { chunkSize, cellSize } = world.config
  const cells = mask.vertexCount - 1
  if (cellSize !== mask.cellSize || chunkSize / cellSize !== cells) {
    throw new TerrainError(
      'INVALID_GRID',
      `isRevealed: world chunks (${chunkSize} m at ${cellSize} m) differ from the mask's ${mask.vertexCount}-vertex chunks at ${mask.cellSize} m; pass the mask's own world.`,
    )
  }
  const { i, j } = worldToVertex(world, point)
  const cx = Math.floor(i / cells)
  const cy = Math.floor(j / cells)
  const a = i - cx * cells
  const b = j - cy * cells
  // A vertex on a chunk edge belongs to up to four chunks, and only some of them may be stored.
  for (const [ox, oy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    if ((ox && a !== 0) || (oy && b !== 0)) continue
    const bits = mask.chunks.get(`${cx - ox},${cy - oy}`)
    if (bits?.[(b + oy * cells) * mask.vertexCount + a + ox * cells]) return true
  }
  return false
}

/**
 * Revealed-mask format v1, little-endian: `"JRRV"`, u8 version, u8 flags (0), u16 vertexCount,
 * f32 cellSize, u32 chunkCount, then per chunk sorted by (cy, cx): i32 cx, i32 cy and
 * ⌈vertexCount² / 8⌉ bytes of bits, vertex k at bit `k & 7` (LSB first) of byte `k >> 3`.
 */
export function encodeRevealedMask(mask: RevealedMask): Uint8Array {
  const { vertexCount, cellSize } = mask
  if (!Number.isInteger(vertexCount) || vertexCount < 2 || vertexCount > 0xffff) {
    throw new TerrainError(
      'INVALID_GRID',
      `Revealed mask vertexCount is ${vertexCount}; pass an integer from 2 to 65535.`,
    )
  }
  if (!Number.isFinite(cellSize) || cellSize <= 0 || Math.fround(cellSize) !== cellSize) {
    throw new TerrainError(
      'INVALID_GRID',
      `Revealed mask cellSize is ${cellSize}; pass a positive value exactly representable as float32.`,
    )
  }
  const count = vertexCount * vertexCount
  const packed = Math.ceil(count / 8)
  const entries = [...mask.chunks].map(([key, bits]) => {
    const coords = parseChunkKey(key)
    if (bits.length !== count) {
      throw new TerrainError(
        'INVALID_GRID',
        `Revealed mask chunk ${key} holds ${bits.length} values; vertexCount ${vertexCount} needs ${count}.`,
      )
    }
    return { ...coords, bits }
  })
  entries.sort((p, q) => p.cy - q.cy || p.cx - q.cx)
  const stride = 8 + packed
  const bytes = new Uint8Array(REVEALED_HEADER_BYTES + entries.length * stride)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  view.setUint8(4, REVEALED_FORMAT_VERSION)
  view.setUint8(5, 0)
  view.setUint16(6, vertexCount, true)
  view.setFloat32(8, cellSize, true)
  view.setUint32(12, entries.length, true)
  let offset = REVEALED_HEADER_BYTES
  for (const { cx, cy, bits } of entries) {
    view.setInt32(offset, cx, true)
    view.setInt32(offset + 4, cy, true)
    const base = offset + 8
    for (let k = 0; k < count; k++) if (bits[k]) bytes[base + (k >> 3)]! |= 1 << (k & 7)
    offset += stride
  }
  return bytes
}

/** Decodes format v1 into fresh arrays; the input may be any view, aligned or not. */
export function decodeRevealedMask(bytes: Uint8Array): RevealedMask {
  if (bytes.byteLength < MAGIC.length) {
    throw new TerrainError(
      'TRUNCATED',
      `Revealed mask buffer is ${bytes.byteLength} bytes, shorter than its ${REVEALED_HEADER_BYTES}-byte header; pass the complete mask.`,
    )
  }
  for (let k = 0; k < MAGIC.length; k++) {
    if (bytes[k] !== MAGIC[k]) {
      const found = Array.from(bytes.subarray(0, MAGIC.length), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(' ')
      throw new TerrainError(
        'INVALID_MAGIC',
        `Revealed mask buffer starts with bytes ${found}, not "JRRV"; pass bytes produced by encodeRevealedMask.`,
      )
    }
  }
  if (bytes.byteLength < REVEALED_HEADER_BYTES) {
    throw new TerrainError(
      'TRUNCATED',
      `Revealed mask buffer is ${bytes.byteLength} bytes, shorter than its ${REVEALED_HEADER_BYTES}-byte header; pass the complete mask.`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(4)
  if (version !== REVEALED_FORMAT_VERSION) {
    throw new TerrainError(
      'UNSUPPORTED_VERSION',
      `Revealed mask format version is ${version}; this decoder reads version ${REVEALED_FORMAT_VERSION} only.`,
    )
  }
  const flags = view.getUint8(5)
  if (flags !== 0) {
    throw new TerrainError(
      'UNSUPPORTED_VERSION',
      `Revealed mask format v1 flags are 0x${flags.toString(16)}; this decoder reads flags 0 only.`,
    )
  }
  const vertexCount = view.getUint16(6, true)
  const cellSize = view.getFloat32(8, true)
  const chunkCount = view.getUint32(12, true)
  if (vertexCount < 2 || !Number.isFinite(cellSize) || cellSize <= 0) {
    throw new TerrainError(
      'INVALID_GRID',
      `Revealed mask header declares vertexCount ${vertexCount} and cellSize ${cellSize}; pass bytes produced by encodeRevealedMask.`,
    )
  }
  const count = vertexCount * vertexCount
  const stride = 8 + Math.ceil(count / 8)
  const expected = REVEALED_HEADER_BYTES + chunkCount * stride
  if (bytes.byteLength < expected) {
    throw new TerrainError(
      'TRUNCATED',
      `Revealed mask buffer is ${bytes.byteLength} bytes; ${chunkCount} chunks of vertexCount ${vertexCount} need ${expected}. Pass the complete mask.`,
    )
  }
  if (bytes.byteLength > expected) {
    throw new TerrainError(
      'TRAILING_DATA',
      `Revealed mask buffer is ${bytes.byteLength} bytes; ${chunkCount} chunks of vertexCount ${vertexCount} need exactly ${expected}. Pass one mask per buffer.`,
    )
  }
  const chunks = new Map<string, Uint8Array>()
  for (let c = 0; c < chunkCount; c++) {
    const offset = REVEALED_HEADER_BYTES + c * stride
    const key = `${view.getInt32(offset, true)},${view.getInt32(offset + 4, true)}`
    if (chunks.has(key)) {
      throw new TerrainError(
        'INVALID_GRID',
        `Revealed mask lists chunk ${key} twice; pass bytes produced by encodeRevealedMask.`,
      )
    }
    const base = offset + 8
    const bits = new Uint8Array(count)
    for (let k = 0; k < count; k++) bits[k] = (bytes[base + (k >> 3)]! >> (k & 7)) & 1
    chunks.set(key, bits)
  }
  return { version: 1, cellSize, vertexCount, chunks }
}

function assertDiskAligned(mask: RevealedMask, disk: StopDisk, context: string): void {
  const { vertexCount } = mask
  const cells = vertexCount - 1
  const { width, height, cellSize } = disk.grid
  if (
    cellSize !== mask.cellSize ||
    disk.origin.i % cells !== 0 ||
    disk.origin.j % cells !== 0 ||
    (width - 1) % cells !== 0 ||
    (height - 1) % cells !== 0
  ) {
    throw new TerrainError(
      'INVALID_GRID',
      `${context}: disk grid (cellSize ${cellSize}, origin ${disk.origin.i},${disk.origin.j}, ${width}×${height}) does not align with the mask's ${vertexCount}-vertex chunks at cellSize ${mask.cellSize}; pass a disk computed for the mask's world.`,
    )
  }
}

function parseChunkKey(key: string): { cx: number; cy: number } {
  const match = /^(-?\d+),(-?\d+)$/.exec(key)
  const cx = match ? Number(match[1]) : Number.NaN
  const cy = match ? Number(match[2]) : Number.NaN
  if (!match || `${cx},${cy}` !== key) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `Revealed mask chunk key is "${key}"; use "cx,cy" with integer chunk coordinates.`,
    )
  }
  assertChunkCoord('cx', cx)
  assertChunkCoord('cy', cy)
  return { cx, cy }
}
