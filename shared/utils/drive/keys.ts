import { DriveError } from './errors'

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
  if (!Number.isSafeInteger(sliceIndex) || sliceIndex < 0 || sliceIndex > MAX_SLICE_INDEX) {
    throw new DriveError(
      'INVALID_INPUT',
      `Slice index is ${sliceIndex}; pass an integer from 0 to ${MAX_SLICE_INDEX}.`,
    )
  }
  return `segments/${segmentId}/slices/${sliceIndex}.bin`
}

/** What a served journey key names; keys of any other shape are not served. */
export type JourneyKey =
  /** A chunk of a world's terrain. */
  | { kind: 'terrain' }
  /** A mission's stop manifest, disk pack or revealed mask. */
  | { kind: 'stop' }
  | { kind: 'segment-manifest'; segmentId: string }
  | { kind: 'segment-slice'; segmentId: string; index: number }

const TERRAIN_KEY = /^terrain\/[0-9a-f]{16}\/chunks\/-?\d{1,10}_-?\d{1,10}\.bin$/
const STOP_KEY =
  /^missions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:revealed\/(?:0|[1-9]\d{0,14})\.bin|stops\/(?:0|[1-9]\d{0,14})\.(?:json|pack))$/
const SEGMENT_KEY =
  /^segments\/([A-Za-z0-9_-]{1,64})\/(?:(manifest\.json)|slices\/(0|[1-9]\d{0,6})\.bin)$/

/**
 * Classifies a key built by `chunkKey`, `revealedKey`, `stopManifestKey`, `stopPackKey`,
 * `segmentManifestKey` or `segmentSliceKey`; null for anything else, including paths with `..` or a leading `/`.
 */
export function parseJourneyKey(key: string): JourneyKey | null {
  if (TERRAIN_KEY.test(key)) return { kind: 'terrain' }
  if (STOP_KEY.test(key)) return { kind: 'stop' }
  const match = SEGMENT_KEY.exec(key)
  if (!match) return null
  const segmentId = match[1]!
  if (match[2]) return { kind: 'segment-manifest', segmentId }
  return { kind: 'segment-slice', segmentId, index: Number(match[3]) }
}

export function assertSegmentId(segmentId: string): void {
  if (!SEGMENT_ID.test(segmentId)) {
    throw new DriveError(
      'INVALID_INPUT',
      `Segment id is ${JSON.stringify(segmentId)}; use 1 to 64 characters of A–Z, a–z, 0–9, "_" and "-".`,
    )
  }
}
