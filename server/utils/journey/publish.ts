import { hash } from 'unsecure/hash'
import type { SegmentManifest, SegmentRecord, StoredSegmentManifest } from '#shared/utils/drive'
import {
  assertSegmentId,
  DriveError,
  encodeSlice,
  segmentManifestKey,
  segmentSliceKey,
  sliceRecord,
  sliceReleaseAt,
} from '#shared/utils/drive'
import type { Chunk, RevealedMask, StopDisk, World } from '#shared/utils/terrain'
import {
  buildStopManifest,
  encodeChunk,
  encodeDiskPack,
  encodeRevealedMask,
  generateChunk,
  stopManifestKey,
} from '#shared/utils/terrain'
import type { JourneyStore, PutEntry, PutResult } from './store'
import { putAll } from './store'

const BINARY = 'application/octet-stream'

/**
 * Publishes a mission's stop: every chunk of its disk and the revealed mask as of this stop, then
 * the disk's chunks again as one pack, then the stop manifest, so a reader that finds the pack
 * finds every chunk it holds and one that finds the manifest finds everything it names. A blob
 * already stored is skipped: chunks are immutable per world, and a stop index is taken by one
 * drive of the mission only, so its pack and mask are too. The pack holds exactly the chunks the
 * manifest lists, all of them public once the stop is.
 */
export async function publishStop(
  store: JourneyStore,
  options: {
    world: World
    disk: StopDisk
    mask: RevealedMask
    missionId: string
    stopIndex: number
  },
): Promise<{ manifestKey: string; written: PutResult[]; skipped: string[] }> {
  const { world, disk, mask, missionId, stopIndex } = options
  const manifest = buildStopManifest(world, disk, { missionId, stopIndex })
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
  named.push({
    key: manifest.revealedKey,
    bytes: () => encodeRevealedMask(mask),
    contentType: BINARY,
  })
  const pack: PutEntry = {
    key: manifest.packKey,
    bytes: () => encodeDiskPack(manifest.chunks.map((_, n) => chunk(n))),
    contentType: BINARY,
  }
  const first = await putAll(store, named)
  const packed = await putAll(store, [pack])
  const manifestKey = stopManifestKey(missionId, stopIndex)
  const written = [...first.written, ...packed.written, await store.putJson(manifestKey, manifest)]
  return { manifestKey, written, skipped: [...first.skipped, ...packed.skipped] }
}

/** A segment record cut into slices of the default length and encoded, ready to publish. */
export interface EncodedSegment {
  manifest: SegmentManifest
  /** Slice `n`'s bytes at index `n`. */
  slices: Uint8Array[]
}

export function encodeSegment(record: SegmentRecord): EncodedSegment {
  const { manifest, slices } = sliceRecord(record)
  return { manifest, slices: slices.map(encodeSlice) }
}

/**
 * A segment id naming `segment`'s content within `scope`: a UUID (version 8) from the SHA-256 of
 * the scope, the manifest and every slice. The same content in the same scope always gets the
 * same id, so its slices, keyed by that id, never change once stored.
 */
export async function contentSegmentId(segment: EncodedSegment, scope: string): Promise<string> {
  const head = new TextEncoder().encode(JSON.stringify([scope, segment.manifest]))
  const bytes = new Uint8Array(
    segment.slices.reduce((sum, slice) => sum + slice.byteLength, head.byteLength),
  )
  bytes.set(head)
  let offset = head.byteLength
  for (const slice of segment.slices) {
    bytes.set(slice, offset)
    offset += slice.byteLength
  }
  const digest = await hash(bytes, { returnAs: 'bytes' })
  digest[6] = (digest[6]! & 0x0f) | 0x80
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Publishes an encoded segment as time-gated slices, each served once its window has passed,
 * then its manifest stamped with the segment id and wall-clock start (epoch milliseconds). A
 * slice already stored under the id is skipped; the manifest is always written, last, so a reader
 * that finds it finds every slice. `endsAt` is the release time of the last slice, epoch
 * milliseconds: the drive's public end.
 */
export async function publishSegment(
  store: JourneyStore,
  options: { segment: EncodedSegment; segmentId: string; startedAt: number },
): Promise<{ manifestKey: string; written: PutResult[]; skipped: string[]; endsAt: number }> {
  const { segment, segmentId, startedAt } = options
  assertSegmentId(segmentId)
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new DriveError(
      'INVALID_INPUT',
      `publishSegment: startedAt is ${startedAt}; pass whole epoch milliseconds.`,
    )
  }
  const { written, skipped } = await putAll(
    store,
    segment.slices.map((bytes, index) => ({
      key: segmentSliceKey(segmentId, index),
      bytes: () => bytes,
      contentType: BINARY,
    })),
  )
  const stored: StoredSegmentManifest = { ...segment.manifest, segmentId, startedAt }
  const manifestKey = segmentManifestKey(segmentId)
  written.push(await store.putJson(manifestKey, stored))
  const { sliceSeconds } = segment.manifest
  const endsAt = sliceReleaseAt(startedAt, segment.slices.length - 1, sliceSeconds)
  return { manifestKey, written, skipped, endsAt }
}
