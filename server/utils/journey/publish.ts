import { hash } from 'unsecure/hash'
import type { SegmentManifest, SegmentRecord, StoredSegmentManifest } from '#shared/utils/drive'
import {
  assertSegmentId,
  encodeSlice,
  encodeTrace,
  segmentManifestKey,
  segmentSliceKey,
  segmentTraceKey,
  sliceRecord,
} from '#shared/utils/drive'
import type { Chunk, RevealedMask, StopDisk, StopKeys, World } from '#shared/utils/terrain'
import {
  buildStopManifest,
  encodeChunk,
  encodeDiskPack,
  encodeRevealedMask,
  generateChunk,
  revealedMaskDigest,
  stopKeys,
} from '#shared/utils/terrain'
import type { JourneyStore, PutEntry, PutResult } from './store'
import { putAll } from './store'

const BINARY = 'application/octet-stream'

/**
 * Publishes a mission's stop: every chunk of its disk and the revealed mask as of this stop, then
 * the disk's chunks again as one pack, then the stop manifest, so a reader that finds the pack
 * finds every chunk it holds and one that finds the manifest finds everything it names. Every
 * object is named by what produced it (see `stopKeys`): `reachedBy`, the segment that reached the
 * stop (null for the landing), and the mask's digest. So publishing the same stop again writes the
 * same bytes under the same keys, and a blob already stored is skipped. The pack holds exactly
 * the chunks the manifest lists, all of them public once the stop is.
 */
export async function publishStop(
  store: JourneyStore,
  options: {
    world: World
    disk: StopDisk
    mask: RevealedMask
    missionId: string
    reachedBy: string | null
  },
): Promise<{ keys: StopKeys; written: PutResult[]; skipped: string[] }> {
  const { world, disk, mask, missionId, reachedBy } = options
  const encodedMask = encodeRevealedMask(mask)
  const keys = stopKeys(missionId, { reachedBy, maskDigest: revealedMaskDigest(encodedMask) })
  const manifest = buildStopManifest(world, disk, { missionId, keys })
  const generated = new Map<number, Chunk>()
  const chunk = (n: number) => {
    let found = generated.get(n)
    if (!found) generated.set(n, (found = generateChunk(world, manifest.chunks[n]!)))
    return found
  }
  const named: PutEntry[] = manifest.chunks.map(({ key }, n) => ({
    key,
    bytes: () => encodeChunk(chunk(n)),
    contentType: BINARY,
  }))
  named.push({ key: keys.revealedKey, bytes: () => encodedMask, contentType: BINARY })
  const pack: PutEntry = {
    key: keys.packKey,
    bytes: () => encodeDiskPack(manifest.chunks.map((_, n) => chunk(n))),
    contentType: BINARY,
  }
  const described: PutEntry = {
    key: keys.manifestKey,
    bytes: () => new TextEncoder().encode(JSON.stringify(manifest)),
    contentType: 'application/json',
  }
  const first = await putAll(store, named)
  const packed = await putAll(store, [pack])
  const last = await putAll(store, [described])
  return {
    keys,
    written: [...first.written, ...packed.written, ...last.written],
    skipped: [...first.skipped, ...packed.skipped, ...last.skipped],
  }
}

/** A segment record cut into slices of the default length and encoded, ready to publish. */
export interface EncodedSegment {
  manifest: SegmentManifest
  /** Slice `n`'s bytes at index `n`. */
  slices: Uint8Array[]
  /** Slice `n`'s trace at index `n`. */
  traces: Uint8Array[]
}

export function encodeSegment(record: SegmentRecord): EncodedSegment {
  const { manifest, slices, traces } = sliceRecord(record)
  return { manifest, slices: slices.map(encodeSlice), traces: traces.map(encodeTrace) }
}

/**
 * A segment id naming `segment`'s content within `scope`: a UUID (version 8) from the SHA-256 of
 * the scope, the manifest, every slice and every trace. The same content in the same scope always
 * gets the same id, so its blobs, keyed by that id, never change once stored.
 */
export async function contentSegmentId(segment: EncodedSegment, scope: string): Promise<string> {
  const head = new TextEncoder().encode(JSON.stringify([scope, segment.manifest]))
  const parts = [head, ...segment.slices, ...segment.traces]
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  const digest = await hash(bytes, { returnAs: 'bytes' })
  digest[6] = (digest[6]! & 0x0f) | 0x80
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Publishes an encoded segment as slices and traces, then its manifest stamped with the segment
 * id, last, so a reader that finds the manifest finds every slice and trace. Every blob is pure
 * content: publishing the same segment again, from any run at any time, writes the same bytes, so
 * a blob already stored under the id is skipped. When the drive starts is the segment row's, and
 * the journey route serves each slice and trace once its window since that start has passed.
 * `sliceCount` is the number of slices, which with the row's start gives the drive's public end
 * (see `sliceReleaseAt`).
 */
export async function publishSegment(
  store: JourneyStore,
  options: { segment: EncodedSegment; segmentId: string },
): Promise<{ manifestKey: string; written: PutResult[]; skipped: string[]; sliceCount: number }> {
  const { segment, segmentId } = options
  assertSegmentId(segmentId)
  const { written, skipped } = await putAll(store, [
    ...segment.slices.map((bytes, index) => ({
      key: segmentSliceKey(segmentId, index),
      bytes: () => bytes,
      contentType: BINARY,
    })),
    ...segment.traces.map((bytes, index) => ({
      key: segmentTraceKey(segmentId, index),
      bytes: () => bytes,
      contentType: BINARY,
    })),
  ])
  const stored: StoredSegmentManifest = { ...segment.manifest, segmentId }
  const manifestKey = segmentManifestKey(segmentId)
  const last = await putAll(store, [
    {
      key: manifestKey,
      bytes: () => new TextEncoder().encode(JSON.stringify(stored)),
      contentType: 'application/json',
    },
  ])
  written.push(...last.written)
  skipped.push(...last.skipped)
  return { manifestKey, written, skipped, sliceCount: segment.slices.length }
}
