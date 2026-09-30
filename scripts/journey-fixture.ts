/**
 * The recorded journey under `test/fixtures/records/`, built deterministically; not a script
 * itself. `record-journey-fixture.ts` writes it, and the client tests rebuild it to compare the
 * served blobs against the record they came from.
 */
import type {
  SegmentRecord,
  SliceTrace,
  StoredSegmentManifest,
  WrittenSlice,
} from '#shared/utils/drive'
import {
  driveSegment,
  encodeSlice,
  encodeTrace,
  segmentManifestKey,
  segmentSliceKey,
  segmentTraceKey,
  sliceRecord,
} from '#shared/utils/drive'
import { landingMask } from '#shared/utils/mission'
import type { RevealedMask, StopDisk, StopKeys, StopManifestV4, World } from '#shared/utils/terrain'
import {
  buildStopManifest,
  computeStopDisk,
  createRevealedMask,
  defineWorld,
  encodeChunk,
  encodeDiskPack,
  encodeRevealedMask,
  generateChunk,
  revealedMaskDigest,
  stopKeys,
} from '#shared/utils/terrain'

/**
 * A 60 m survey keeps the disk, margin included, to the sixteen chunks around the origin, so
 * every blob the manifest names is on disk; a 30 m drive keeps the slices and traces near 225 KB.
 * Production uses a 500 m survey, which would weigh megabytes.
 */
export const JOURNEY_FIXTURE = Object.freeze({
  seed: 'mars',
  missionId: '0192f000-0000-7000-8000-000000000001',
  radius: 60,
  start: Object.freeze({ x: 0, y: 0, headingRad: 0 }),
  goal: Object.freeze({ x: 25, y: 15 }),
  segmentId: 'fixture-mars-0',
  /** The start a segment row would give the drive, 2026-09-26T12:00:00Z; not stored. */
  startedAt: Date.UTC(2026, 8, 26, 12),
})

export interface JourneyFixture {
  world: World
  disk: StopDisk
  mask: RevealedMask
  /** Where the landing stop's objects are stored. */
  stopKeys: StopKeys
  stopManifest: StopManifestV4
  record: SegmentRecord
  segmentManifest: StoredSegmentManifest
  slices: WrittenSlice[]
  traces: SliceTrace[]
  /** Journey key → bytes as the route serves them once inflated. */
  files: Map<string, Uint8Array>
}

export function buildJourneyFixture(): JourneyFixture {
  const { seed, missionId, radius, start, goal, segmentId } = JOURNEY_FIXTURE
  const world = defineWorld({ seed })
  const disk = computeStopDisk(world, { center: { x: start.x, y: start.y }, radius })
  const mask = landingMask(createRevealedMask(world), disk)
  const maskBytes = encodeRevealedMask(mask)
  const keys = stopKeys(missionId, { reachedBy: null, maskDigest: revealedMaskDigest(maskBytes) })
  const stopManifest = buildStopManifest(world, disk, { missionId, keys })
  const { record } = driveSegment(world, {
    disk,
    revealed: mask,
    start: { ...start },
    goal: { ...goal },
  })
  const { manifest, slices, traces } = sliceRecord(record)
  const segmentManifest: StoredSegmentManifest = { ...manifest, segmentId }

  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const files = new Map<string, Uint8Array>()
  const chunks = stopManifest.chunks.map(({ cx, cy }) => generateChunk(world, { cx, cy }))
  for (const [n, { key }] of stopManifest.chunks.entries()) files.set(key, encodeChunk(chunks[n]!))
  files.set(stopManifest.packKey, encodeDiskPack(chunks))
  files.set(keys.revealedKey, maskBytes)
  files.set(keys.manifestKey, json(stopManifest))
  for (const slice of slices) files.set(segmentSliceKey(segmentId, slice.index), encodeSlice(slice))
  for (const trace of traces) files.set(segmentTraceKey(segmentId, trace.index), encodeTrace(trace))
  files.set(segmentManifestKey(segmentId), json(segmentManifest))
  return {
    world,
    disk,
    mask,
    stopKeys: keys,
    stopManifest,
    record,
    segmentManifest,
    slices,
    traces,
    files,
  }
}
