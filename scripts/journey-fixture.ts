/**
 * The recorded journey under `test/fixtures/records/`, built deterministically; not a script
 * itself. `record-journey-fixture.ts` writes it, and the client tests rebuild it to compare the
 * served blobs against the record they came from.
 */
import type { SegmentRecord, SegmentSlice, StoredSegmentManifest } from '#shared/utils/drive'
import {
  driveSegment,
  encodeSlice,
  segmentManifestKey,
  segmentSliceKey,
  sliceRecord,
} from '#shared/utils/drive'
import type { RevealedMask, StopDisk, StopManifestV3, World } from '#shared/utils/terrain'
import {
  buildStopManifest,
  computeStopDisk,
  createRevealedMask,
  defineWorld,
  encodeChunk,
  encodeDiskPack,
  encodeRevealedMask,
  generateChunk,
  revealDisk,
  stopManifestKey,
} from '#shared/utils/terrain'

/**
 * A 60 m survey keeps the disk, margin included, to the sixteen chunks around the origin, so
 * every blob the manifest names is on disk; a 30 m drive keeps the slices near 160 KB.
 * Production uses a 500 m survey, which would weigh megabytes.
 */
export const JOURNEY_FIXTURE = Object.freeze({
  seed: 'mars',
  missionId: '0192f000-0000-7000-8000-000000000001',
  stopIndex: 0,
  radius: 60,
  start: Object.freeze({ x: 0, y: 0, headingRad: 0 }),
  goal: Object.freeze({ x: 25, y: 15 }),
  segmentId: 'fixture-mars-0',
  /** 2026-09-26T12:00:00Z. */
  startedAt: Date.UTC(2026, 8, 26, 12),
})

export interface JourneyFixture {
  world: World
  disk: StopDisk
  mask: RevealedMask
  stopManifest: StopManifestV3
  record: SegmentRecord
  segmentManifest: StoredSegmentManifest
  slices: SegmentSlice[]
  /** Journey key → bytes as the route serves them once inflated. */
  files: Map<string, Uint8Array>
}

export function buildJourneyFixture(): JourneyFixture {
  const { seed, missionId, stopIndex, radius, start, goal, segmentId, startedAt } = JOURNEY_FIXTURE
  const world = defineWorld({ seed })
  const disk = computeStopDisk(world, { center: { x: start.x, y: start.y }, radius })
  const mask = revealDisk(createRevealedMask(world), disk)
  const stopManifest = buildStopManifest(world, disk, { missionId, stopIndex })
  const { record } = driveSegment(world, {
    disk,
    revealed: mask,
    start: { ...start },
    goal: { ...goal },
  })
  const { manifest, slices } = sliceRecord(record)
  const segmentManifest: StoredSegmentManifest = { ...manifest, segmentId, startedAt }

  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const files = new Map<string, Uint8Array>()
  const chunks = stopManifest.chunks.map(({ cx, cy }) => generateChunk(world, { cx, cy }))
  for (const [n, { key }] of stopManifest.chunks.entries()) files.set(key, encodeChunk(chunks[n]!))
  files.set(stopManifest.packKey, encodeDiskPack(chunks))
  files.set(stopManifest.revealedKey, encodeRevealedMask(mask))
  files.set(stopManifestKey(missionId, stopIndex), json(stopManifest))
  for (const slice of slices) files.set(segmentSliceKey(segmentId, slice.index), encodeSlice(slice))
  files.set(segmentManifestKey(segmentId), json(segmentManifest))
  return { world, disk, mask, stopManifest, record, segmentManifest, slices, files }
}
