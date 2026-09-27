import type { Chunk } from './chunk'
import { decodeChunk, encodeChunk } from './encode'
import { TerrainError } from './errors'

/** Disk pack format version written by {@link encodeDiskPack}. */
export const DISK_PACK_FORMAT_VERSION = 1
/** Bytes before the first entry: magic, version, flags, chunkCount. */
export const DISK_PACK_HEADER_BYTES = 10

const MAGIC = new TextEncoder().encode('JRPK')
/** Each entry's length prefix. */
const ENTRY_PREFIX_BYTES = 4

/**
 * Disk pack format v1, little-endian: `"JRPK"`, u8 version, u8 flags (0), u32 chunkCount, then per
 * chunk a u32 byteLength and the chunk's {@link encodeChunk} bytes, in the order given.
 */
export function encodeDiskPack(chunks: readonly Chunk[]): Uint8Array {
  const entries = chunks.map(encodeChunk)
  const total = entries.reduce(
    (sum, entry) => sum + ENTRY_PREFIX_BYTES + entry.byteLength,
    DISK_PACK_HEADER_BYTES,
  )
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  bytes.set(MAGIC, 0)
  view.setUint8(4, DISK_PACK_FORMAT_VERSION)
  view.setUint8(5, 0)
  view.setUint32(6, entries.length, true)
  let offset = DISK_PACK_HEADER_BYTES
  for (const entry of entries) {
    view.setUint32(offset, entry.byteLength, true)
    bytes.set(entry, offset + ENTRY_PREFIX_BYTES)
    offset += ENTRY_PREFIX_BYTES + entry.byteLength
  }
  return bytes
}

/** Decodes a whole format v1 pack into its chunks, in pack order. */
export function decodeDiskPack(bytes: Uint8Array): Chunk[] {
  const count = readHeader(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: Chunk[] = []
  let offset = DISK_PACK_HEADER_BYTES
  for (let n = 0; n < count; n++) {
    if (bytes.byteLength < offset + ENTRY_PREFIX_BYTES) throw truncated(n, count)
    const length = view.getUint32(offset, true)
    offset += ENTRY_PREFIX_BYTES
    if (bytes.byteLength < offset + length) throw truncated(n, count)
    chunks.push(decodeChunk(bytes.subarray(offset, offset + length)))
    offset += length
  }
  if (offset !== bytes.byteLength) throw trailing(bytes.byteLength - offset, count)
  return chunks
}

/**
 * Decodes a format v1 pack from a byte stream, yielding each chunk as soon as its bytes are in,
 * so decoding overlaps the download. The reader's lock is released however the read ends; a
 * stream left unread (a decode error, or a consumer that stops early) is cancelled first.
 */
export async function* readDiskPack(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Chunk, void, undefined> {
  const queue = createByteQueue(reader)
  try {
    const header = await queue.take(DISK_PACK_HEADER_BYTES)
    // A short header is reported as the header check words it: magic first, then length.
    const count = readHeader(header ?? (await queue.rest()))
    for (let n = 0; n < count; n++) {
      const prefix = await queue.take(ENTRY_PREFIX_BYTES)
      if (!prefix) throw truncated(n, count)
      const length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, true)
      const entry = await queue.take(length)
      if (!entry) throw truncated(n, count)
      yield decodeChunk(entry)
    }
    const extra = (await queue.rest()).byteLength
    if (extra > 0) throw trailing(extra, count)
  } finally {
    await queue.release()
  }
}

/** The pack's chunk count, after checking magic, version and flags. */
function readHeader(bytes: Uint8Array): number {
  if (bytes.byteLength < MAGIC.length) throw shortHeader(bytes.byteLength)
  for (let k = 0; k < MAGIC.length; k++) {
    if (bytes[k] !== MAGIC[k]) {
      const found = Array.from(bytes.subarray(0, MAGIC.length), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(' ')
      throw new TerrainError(
        'INVALID_MAGIC',
        `Disk pack starts with bytes ${found}, not "JRPK"; pass bytes produced by encodeDiskPack.`,
      )
    }
  }
  if (bytes.byteLength < DISK_PACK_HEADER_BYTES) throw shortHeader(bytes.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(4)
  if (version !== DISK_PACK_FORMAT_VERSION) {
    throw new TerrainError(
      'UNSUPPORTED_VERSION',
      `Disk pack format version is ${version}; this decoder reads version ${DISK_PACK_FORMAT_VERSION} only.`,
    )
  }
  const flags = view.getUint8(5)
  if (flags !== 0) {
    throw new TerrainError(
      'UNSUPPORTED_VERSION',
      `Disk pack format v1 flags are 0x${flags.toString(16)}; this decoder reads flags 0 only.`,
    )
  }
  return view.getUint32(6, true)
}

function shortHeader(length: number): TerrainError {
  return new TerrainError(
    'TRUNCATED',
    `Disk pack is ${length} bytes, shorter than its ${DISK_PACK_HEADER_BYTES}-byte header; pass the complete pack.`,
  )
}

function truncated(entry: number, count: number): TerrainError {
  return new TerrainError(
    'TRUNCATED',
    `Disk pack ends inside chunk ${entry + 1} of the ${count} it declares; pass the complete pack.`,
  )
}

function trailing(extra: number, count: number): TerrainError {
  return new TerrainError(
    'TRAILING_DATA',
    `Disk pack continues ${extra} bytes past the ${count} chunks it declares; pass one pack per buffer.`,
  )
}

/** Bytes pulled from a stream reader on demand, handed out in exact lengths. */
function createByteQueue(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const parts: Uint8Array[] = []
  let held = 0
  let done = false

  async function fill(length: number): Promise<boolean> {
    while (held < length && !done) {
      const result = await reader.read()
      if (result.done) done = true
      else if (result.value.byteLength > 0) {
        parts.push(result.value)
        held += result.value.byteLength
      }
    }
    return held >= length
  }

  function splice(length: number): Uint8Array {
    const first = parts[0]
    // An entry inside one network read is handed out without a copy.
    if (first && first.byteLength >= length) {
      const out = first.subarray(0, length)
      if (first.byteLength === length) parts.shift()
      else parts[0] = first.subarray(length)
      held -= length
      return out
    }
    const out = new Uint8Array(length)
    let offset = 0
    while (offset < length) {
      const part = parts[0]!
      const used = Math.min(part.byteLength, length - offset)
      out.set(part.subarray(0, used), offset)
      offset += used
      if (used === part.byteLength) parts.shift()
      else parts[0] = part.subarray(used)
    }
    held -= length
    return out
  }

  return {
    /** Exactly `length` bytes, or null when the stream ends first. */
    async take(length: number): Promise<Uint8Array | null> {
      return (await fill(length)) ? splice(length) : null
    },
    /** Everything left until the stream ends. */
    async rest(): Promise<Uint8Array> {
      await fill(Infinity)
      return splice(held)
    },
    async release(): Promise<void> {
      if (!done) await reader.cancel().catch(() => {})
      reader.releaseLock()
    },
  }
}
