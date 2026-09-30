import { DriveError } from './errors'
import { TRACE_BLOCK } from './traces'

/** Caller-supplied segment identifier: 1 to 64 of `A–Z a–z 0–9 _ -`. */
export const SEGMENT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function segmentManifestKey(segmentId: string): string {
  assertSegmentId(segmentId)
  return `segments/${segmentId}/manifest.json`
}

/** Largest slice index, seven digits: 30 s slices over more than nine years of driving. */
export const MAX_SLICE_INDEX = 9_999_999

export function segmentSliceKey(segmentId: string, sliceIndex: number): string {
  assertSegmentId(segmentId)
  assertSliceIndex(sliceIndex)
  return `segments/${segmentId}/slices/${sliceIndex}.bin`
}

/** The trace of slice `sliceIndex`, released with it. */
export function segmentTraceKey(segmentId: string, sliceIndex: number): string {
  assertSegmentId(segmentId)
  assertSliceIndex(sliceIndex)
  return `segments/${segmentId}/traces/${sliceIndex}.bin`
}

/**
 * Traces `16 · block … 16 · block + 15` as one block (see `encodeTraceBlock`): only whole aligned
 * blocks are served, so every visitor asks for the same keys and the CDN keeps each once.
 */
export function segmentTraceBlockKey(segmentId: string, block: number): string {
  assertSegmentId(segmentId)
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new DriveError('INVALID_INPUT', `Trace block is ${block}; pass a non-negative integer.`)
  }
  const from = block * TRACE_BLOCK
  assertSliceIndex(from + TRACE_BLOCK - 1)
  return `segments/${segmentId}/traces/${from}-${from + TRACE_BLOCK - 1}.bin`
}

/** What a served journey key names; keys of any other shape are not served. */
export type JourneyKey =
  /** A chunk of a world's terrain. */
  | { kind: 'terrain' }
  /** A mission's stop manifest, disk pack or revealed mask. */
  | { kind: 'stop' }
  | { kind: 'segment-manifest'; segmentId: string }
  | { kind: 'segment-slice'; segmentId: string; index: number }
  | { kind: 'segment-trace'; segmentId: string; index: number }
  /** Traces `from … to`, a whole aligned block. */
  | { kind: 'segment-trace-block'; segmentId: string; from: number; to: number }

const TERRAIN_KEY = /^terrain\/[0-9a-f]{16}\/chunks\/-?\d{1,10}_-?\d{1,10}\.bin$/
const STOP_KEY =
  /^missions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:revealed\/(?:0|[1-9]\d{0,14})\.bin|stops\/(?:0|[1-9]\d{0,14})\.(?:json|pack))$/
const SEGMENT_KEY =
  /^segments\/([A-Za-z0-9_-]{1,64})\/(?:(manifest\.json)|(slices|traces)\/(0|[1-9]\d{0,6})(?:-([1-9]\d{0,6}))?\.bin)$/

/**
 * Classifies a key built by `chunkKey`, `revealedKey`, `stopManifestKey`, `stopPackKey`,
 * `segmentManifestKey`, `segmentSliceKey`, `segmentTraceKey` or `segmentTraceBlockKey`; null for
 * anything else, including paths with `..` or a leading `/` and trace ranges other than a block.
 */
export function parseJourneyKey(key: string): JourneyKey | null {
  if (TERRAIN_KEY.test(key)) return { kind: 'terrain' }
  if (STOP_KEY.test(key)) return { kind: 'stop' }
  const match = SEGMENT_KEY.exec(key)
  if (!match) return null
  const segmentId = match[1]!
  if (match[2]) return { kind: 'segment-manifest', segmentId }
  const index = Number(match[4])
  if (match[5] !== undefined) {
    const to = Number(match[5])
    const block =
      match[3] === 'traces' && index % TRACE_BLOCK === 0 && to === index + TRACE_BLOCK - 1
    return block ? { kind: 'segment-trace-block', segmentId, from: index, to } : null
  }
  return match[3] === 'slices'
    ? { kind: 'segment-slice', segmentId, index }
    : { kind: 'segment-trace', segmentId, index }
}

export function assertSegmentId(segmentId: string): void {
  if (!SEGMENT_ID.test(segmentId)) {
    throw new DriveError(
      'INVALID_INPUT',
      `Segment id is ${JSON.stringify(segmentId)}; use 1 to 64 characters of A–Z, a–z, 0–9, "_" and "-".`,
    )
  }
}

function assertSliceIndex(sliceIndex: number): void {
  if (!Number.isSafeInteger(sliceIndex) || sliceIndex < 0 || sliceIndex > MAX_SLICE_INDEX) {
    throw new DriveError(
      'INVALID_INPUT',
      `Slice index is ${sliceIndex}; pass an integer from 0 to ${MAX_SLICE_INDEX}.`,
    )
  }
}
