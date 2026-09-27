export type { TerrainErrorCode } from './errors'
export { TerrainError } from './errors'
export type {
  CraterConfig,
  RegolithConfig,
  ReliefConfig,
  ResolvedWorldConfig,
  World,
  WorldConfig,
} from './world'
export {
  DEFAULT_CRATERS,
  DEFAULT_REGOLITH,
  DEFAULT_RELIEF,
  defineWorld,
  sampleHeights,
} from './world'
export type { GridCell, HeightGrid } from './grid'
export type { Chunk, ChunkCoords } from './chunk'
export { generateChunk, MASK_SEEN, MASK_TRAVERSABLE } from './chunk'
export { nearestTraversable, reachableFrom, slopeAt, traversableMask } from './analysis'
export { viewshed } from './viewshed'
export { CHUNK_FORMAT_VERSION, CHUNK_HEADER_BYTES, decodeChunk, encodeChunk } from './encode'
export type { SnapRefusal, StopDisk } from './disk'
export {
  chunksByRow,
  chunksCoveringDisk,
  chunksNearestFirst,
  completeStopDisk,
  computeStopDisk,
  DEFAULT_SNAP_RADIUS,
  DEFAULT_STOP_RADIUS,
  snapToPathable,
  worldToVertex,
} from './disk'
export type { RevealedMask } from './revealed'
export {
  createRevealedMask,
  decodeRevealedMask,
  encodeRevealedMask,
  isRevealed,
  REVEALED_FORMAT_VERSION,
  REVEALED_HEADER_BYTES,
  revealDisk,
  revealedOverDisk,
  revealedVertexCount,
  revealVertices,
} from './revealed'
export type { StopManifest, StopManifestV3 } from './manifest'
export {
  buildStopManifest,
  chunkKey,
  MISSION_ID,
  parseStopManifest,
  revealedKey,
  STOP_MANIFEST_VERSION,
  StopManifestSchema,
  StopManifestV3Schema,
  stopManifestKey,
  stopPackKey,
  worldHash,
} from './manifest'
export {
  decodeDiskPack,
  DISK_PACK_FORMAT_VERSION,
  DISK_PACK_HEADER_BYTES,
  encodeDiskPack,
  readDiskPack,
} from './pack'
