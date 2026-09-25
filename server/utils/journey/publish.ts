import type { SegmentRecord, StoredSegmentManifest } from '#shared/utils/drive'
import {
  assertSegmentId,
  DriveError,
  encodeSlice,
  segmentManifestKey,
  segmentSliceKey,
  sliceRecord,
  sliceReleaseAt,
} from '#shared/utils/drive'
import type { RevealedMask, StopDisk, World } from '#shared/utils/terrain'
import {
  buildStopManifest,
  encodeChunk,
  encodeRevealedMask,
  generateChunk,
  stopManifestKey,
} from '#shared/utils/terrain'
import type { JourneyStore, PutResult } from './store'

const BINARY = { contentType: 'application/octet-stream' }

/**
 * Publishes a stop: every chunk of its disk not yet stored (chunks are immutable per world), the
 * revealed mask as of this stop, then the stop manifest, so a reader that finds the manifest
 * finds everything it names.
 */
export async function publishStop(
  store: JourneyStore,
  options: { world: World; disk: StopDisk; mask: RevealedMask; stopIndex: number },
): Promise<{ manifestKey: string; written: PutResult[]; skipped: string[] }> {
  const { world, disk, mask, stopIndex } = options
  const manifest = buildStopManifest(world, disk, { stopIndex })
  const written: PutResult[] = []
  const skipped: string[] = []
  for (const { cx, cy, key } of manifest.chunks) {
    if (await store.has(key)) {
      skipped.push(key)
      continue
    }
    written.push(
      await store.putImmutable(key, encodeChunk(generateChunk(world, { cx, cy })), BINARY),
    )
  }
  written.push(await store.putImmutable(manifest.revealedKey, encodeRevealedMask(mask), BINARY))
  const manifestKey = stopManifestKey(manifest.worldHash, stopIndex)
  written.push(await store.putJson(manifestKey, manifest))
  return { manifestKey, written, skipped }
}

/**
 * Publishes a segment record as time-gated slices of the default length, each served once its
 * window has passed, then its manifest stamped with the segment id and wall-clock start (epoch
 * milliseconds). The manifest goes last, so a reader that finds it finds every slice. `endsAt` is
 * the release time of the last slice, epoch milliseconds: the drive's public end.
 */
export async function publishSegment(
  store: JourneyStore,
  options: { record: SegmentRecord; segmentId: string; startedAt: number },
): Promise<{ manifestKey: string; written: PutResult[]; endsAt: number }> {
  const { record, segmentId, startedAt } = options
  assertSegmentId(segmentId)
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new DriveError(
      'INVALID_INPUT',
      `publishSegment: startedAt is ${startedAt}; pass whole epoch milliseconds.`,
    )
  }
  const { manifest, slices } = sliceRecord(record)
  const written: PutResult[] = []
  for (const slice of slices) {
    written.push(
      await store.putImmutable(segmentSliceKey(segmentId, slice.index), encodeSlice(slice), BINARY),
    )
  }
  const stored: StoredSegmentManifest = { ...manifest, segmentId, startedAt }
  const manifestKey = segmentManifestKey(segmentId)
  written.push(await store.putJson(manifestKey, stored))
  const endsAt = sliceReleaseAt(startedAt, slices.length - 1, manifest.sliceSeconds)
  return { manifestKey, written, endsAt }
}
