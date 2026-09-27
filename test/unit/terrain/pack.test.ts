import { describe, expect, it } from 'vitest'
import type { Chunk } from '#shared/utils/terrain'
import {
  decodeDiskPack,
  defineWorld,
  encodeChunk,
  encodeDiskPack,
  generateChunk,
  readDiskPack,
  TerrainError,
} from '#shared/utils/terrain'

const world = defineWorld({ seed: 'mars' })
const chunks = [
  generateChunk(world, { cx: -1, cy: -1 }),
  generateChunk(world, { cx: 0, cy: -1 }),
  generateChunk(world, { cx: -1, cy: 0 }),
]
const ENTRY = encodeChunk(chunks[0]!).byteLength

/** The TerrainError `run` throws or rejects with, or undefined when it succeeds or fails otherwise. */
async function terrainErrorOf(run: () => unknown): Promise<TerrainError | undefined> {
  try {
    await run()
  } catch (error) {
    if (error instanceof TerrainError) return error
  }
  return undefined
}

/** A stream handing out `bytes` in reads of `size` bytes; `reads` counts the reads made. */
function streamOf(bytes: Uint8Array, size: number) {
  let offset = 0
  const state = { reads: 0, cancelled: false }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.reads++
      if (offset >= bytes.byteLength) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { stream, state }
}

async function readAll(bytes: Uint8Array, size = 997): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const chunk of readDiskPack(streamOf(bytes, size).stream.getReader())) out.push(chunk)
  return out
}

describe('disk pack format v1', () => {
  it('writes the documented header and length-prefixed entries', () => {
    const bytes = encodeDiskPack(chunks)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('JRPK')
    expect(view.getUint8(4)).toBe(1)
    expect(view.getUint8(5)).toBe(0)
    expect(view.getUint32(6, true)).toBe(3)
    expect(view.getUint32(10, true)).toBe(ENTRY)
    expect(bytes.subarray(14, 14 + ENTRY)).toEqual(encodeChunk(chunks[0]!))
    expect(bytes.byteLength).toBe(10 + 3 * (4 + ENTRY))
  })

  it('round-trips in order, whole and streamed', async () => {
    const bytes = encodeDiskPack(chunks)
    expect(decodeDiskPack(bytes)).toEqual(chunks)
    expect(await readAll(bytes)).toEqual(chunks)
    expect(await readAll(bytes, 1)).toEqual(chunks)
    expect(await readAll(bytes, bytes.byteLength)).toEqual(chunks)
  })

  it('round-trips an empty pack', async () => {
    const bytes = encodeDiskPack([])
    expect(bytes.byteLength).toBe(10)
    expect(decodeDiskPack(bytes)).toEqual([])
    expect(await readAll(bytes)).toEqual([])
  })

  it('yields each chunk as soon as its bytes are in', async () => {
    const bytes = encodeDiskPack(chunks)
    const { stream, state } = streamOf(bytes, 4096)
    const reader = stream.getReader()
    const pack = readDiskPack(reader)
    const first = await pack.next()
    expect(first.value).toEqual(chunks[0])
    // Only the reads the first chunk spans were made (the stream may pull one ahead).
    expect(state.reads).toBeLessThanOrEqual(Math.ceil((14 + ENTRY) / 4096) + 1)
    await pack.return()
    expect(state.cancelled).toBe(true)
  })

  it('refuses truncation anywhere: header, length prefix or entry', async () => {
    const bytes = encodeDiskPack(chunks)
    for (const length of [0, 3, 9, 12, 14 + ENTRY - 1, bytes.byteLength - 1]) {
      const cut = bytes.subarray(0, length)
      expect(await terrainErrorOf(() => decodeDiskPack(cut)), `${length}`).toMatchObject({
        code: 'TRUNCATED',
      })
      expect(await terrainErrorOf(() => readAll(cut)), `${length}`).toMatchObject({
        code: 'TRUNCATED',
      })
    }
  })

  it('refuses bytes past the declared chunks', async () => {
    const bytes = encodeDiskPack(chunks)
    const padded = new Uint8Array(bytes.byteLength + 2)
    padded.set(bytes)
    expect((await terrainErrorOf(() => decodeDiskPack(padded)))?.code).toBe('TRAILING_DATA')
    expect((await terrainErrorOf(() => readAll(padded)))?.code).toBe('TRAILING_DATA')
  })

  it('refuses a wrong magic, version or flags', async () => {
    for (const [offset, value, code] of [
      [0, 0x58, 'INVALID_MAGIC'],
      [4, 2, 'UNSUPPORTED_VERSION'],
      [5, 1, 'UNSUPPORTED_VERSION'],
    ] as const) {
      const bytes = encodeDiskPack(chunks)
      bytes[offset] = value
      expect((await terrainErrorOf(() => decodeDiskPack(bytes)))?.code).toBe(code)
      expect((await terrainErrorOf(() => readAll(bytes)))?.code).toBe(code)
    }
  })

  it('refuses an entry that is not a chunk, with the chunk decoder’s error', async () => {
    const bytes = encodeDiskPack(chunks)
    bytes[14] = 0x58
    expect((await terrainErrorOf(() => decodeDiskPack(bytes)))?.code).toBe('INVALID_MAGIC')
    expect((await terrainErrorOf(() => readAll(bytes)))?.code).toBe('INVALID_MAGIC')
  })

  it('releases the reader once done, so the stream can be read no further', async () => {
    const { stream } = streamOf(encodeDiskPack(chunks), 997)
    const reader = stream.getReader()
    for await (const _ of readDiskPack(reader)) void _
    expect(() => stream.getReader()).not.toThrow()
  })
})
