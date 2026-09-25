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
export { reachableFrom, slopeAt, traversableMask } from './analysis'
export { viewshed } from './viewshed'
export { CHUNK_FORMAT_VERSION, CHUNK_HEADER_BYTES, decodeChunk, encodeChunk } from './encode'
export type { StopDisk } from './disk'
export { chunksCoveringDisk, computeStopDisk, DEFAULT_STOP_RADIUS, worldToVertex } from './disk'
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
  revealVertices,
} from './revealed'
export type { StopManifest } from './manifest'
export {
  buildStopManifest,
  chunkKey,
  parseStopManifest,
  revealedKey,
  STOP_MANIFEST_VERSION,
  StopManifestSchema,
  stopManifestKey,
  worldHash,
} from './manifest'
