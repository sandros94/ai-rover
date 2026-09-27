import * as v from 'valibot'
import type { ChunkCoords } from './chunk'
import { assertChunkCoord } from './chunk'
import type { StopDisk } from './disk'
import { chunksNearestFirst } from './disk'
import { TerrainError } from './errors'
import { hashString } from './seed'
import type { World } from './world'

/** Manifest version written by {@link buildStopManifest}. */
export const STOP_MANIFEST_VERSION = 3

const WORLD_HASH = /^[0-9a-f]{16}$/
/** A mission id as the database makes them: a lowercase UUID. */
export const MISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const positive = v.pipe(v.number(), v.finite(), v.gtValue(0))

const int32 = v.pipe(v.number(), v.integer(), v.minValue(-0x80000000), v.maxValue(0x7fffffff))

/** What every served manifest version holds. */
const STOP_MANIFEST_ENTRIES = {
  missionId: v.pipe(v.string(), v.regex(MISSION_ID)),
  worldHash: v.pipe(v.string(), v.regex(WORLD_HASH)),
  /** The world's geometry, so a client can place chunks and judge slopes before fetching any. */
  world: v.object({
    chunkSize: positive,
    cellSize: positive,
    mastHeight: v.pipe(v.number(), v.finite(), v.minValue(0)),
    slopeLimitDeg: v.pipe(v.number(), v.gtValue(0), v.ltValue(90)),
  }),
  stop: v.object({
    index: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    x: v.pipe(v.number(), v.finite()),
    y: v.pipe(v.number(), v.finite()),
  }),
  radius: positive,
  /** Nearest the stop first (see `chunksNearestFirst`) from version 3, by (cy, cx) before. */
  chunks: v.array(v.object({ cx: int32, cy: int32, key: v.string() })),
  revealedKey: v.string(),
}

/**
 * JSON manifest of one stop, as {@link buildStopManifest} writes it: the disk's chunk blobs, the
 * same chunks as one pack, and the revealed mask as of that stop.
 */
export const StopManifestV3Schema = v.object({
  version: v.literal(STOP_MANIFEST_VERSION),
  ...STOP_MANIFEST_ENTRIES,
  /**
   * Lowest and highest height over every listed chunk, so a view tints ground chunk by chunk as
   * it arrives without the colours shifting.
   */
  heightRange: v.pipe(
    v.object({ min: v.pipe(v.number(), v.finite()), max: v.pipe(v.number(), v.finite()) }),
    v.check(({ min, max }) => min <= max, 'min must not exceed max'),
  ),
  /** Every listed chunk in one blob, in list order (see `encodeDiskPack`). */
  packKey: v.string(),
})

/**
 * Every manifest version a store may serve. Older stops stay readable forever because their
 * blobs are immutable: version 2, written before disk packs, has no `packKey` and no
 * `heightRange`, and a reader of it loads chunk by chunk and measures the heights itself.
 */
export const StopManifestSchema = v.variant('version', [
  v.object({ version: v.literal(2), ...STOP_MANIFEST_ENTRIES }),
  StopManifestV3Schema,
])

/** A manifest as {@link buildStopManifest} writes it. */
export type StopManifestV3 = v.InferOutput<typeof StopManifestV3Schema>

/** A parsed manifest of any served version: a pack and a height range only from version 3. */
export type StopManifest = Omit<StopManifestV3, 'version' | 'heightRange' | 'packKey'> & {
  version: 2 | typeof STOP_MANIFEST_VERSION
  heightRange?: StopManifestV3['heightRange']
  packKey?: string
}

/**
 * Fingerprint of the resolved world config: its canonical JSON (keys sorted at every level)
 * hashed twice under different lane prefixes, as 16 hex characters.
 */
export function worldHash(world: World): string {
  const canonical = canonicalJson(world.config)
  return [1, 2]
    .map((lane) => hashString(`${lane}\u0000${canonical}`).toString(16).padStart(8, '0'))
    .join('')
}

export function chunkKey(worldHash: string, coords: ChunkCoords): string {
  assertWorldHash(worldHash)
  assertChunkCoord('cx', coords.cx)
  assertChunkCoord('cy', coords.cy)
  return `terrain/${worldHash}/chunks/${coords.cx}_${coords.cy}.bin`
}

/**
 * Key of the mission's revealed mask accumulated up to and including stop `stopIndex`. Masks and
 * stops are per mission, since two missions on one world see different ground; chunks are not.
 */
export function revealedKey(missionId: string, stopIndex: number): string {
  assertMissionId(missionId)
  assertStopIndex(stopIndex)
  return `missions/${missionId}/revealed/${stopIndex}.bin`
}

export function stopManifestKey(missionId: string, stopIndex: number): string {
  assertMissionId(missionId)
  assertStopIndex(stopIndex)
  return `missions/${missionId}/stops/${stopIndex}.json`
}

/** Key of the stop's disk pack: every chunk of its disk in one blob. */
export function stopPackKey(missionId: string, stopIndex: number): string {
  assertMissionId(missionId)
  assertStopIndex(stopIndex)
  return `missions/${missionId}/stops/${stopIndex}.pack`
}

export function buildStopManifest(
  world: World,
  disk: StopDisk,
  options: { missionId: string; stopIndex: number },
): StopManifestV3 {
  const { missionId, stopIndex } = options
  const hash = worldHash(world)
  const { chunkSize, cellSize, mastHeight, slopeLimitDeg } = world.config
  return {
    version: STOP_MANIFEST_VERSION,
    missionId,
    worldHash: hash,
    world: { chunkSize, cellSize, mastHeight, slopeLimitDeg },
    stop: { index: stopIndex, x: disk.center.x, y: disk.center.y },
    radius: disk.radius,
    heightRange: heightRangeOf(disk.grid.heights),
    chunks: chunksNearestFirst(disk.chunks, { center: disk.center, chunkSize }).map(
      ({ cx, cy }) => ({ cx, cy, key: chunkKey(hash, { cx, cy }) }),
    ),
    packKey: stopPackKey(missionId, stopIndex),
    revealedKey: revealedKey(missionId, stopIndex),
  }
}

/** Over the heights present; the disk grid holds NaN only outside every listed chunk. */
function heightRangeOf(heights: Float32Array): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const h of heights) {
    if (Number.isNaN(h)) continue
    if (h < min) min = h
    if (h > max) max = h
  }
  if (min > max) {
    throw new TerrainError(
      'INVALID_GRID',
      'buildStopManifest: the disk grid holds no height; pass a disk from computeStopDisk.',
    )
  }
  return { min, max }
}

export function parseStopManifest(value: unknown): StopManifest {
  const result = v.safeParse(StopManifestSchema, value)
  if (result.success) return result.output
  const [issue] = result.issues
  const path = v.getDotPath(issue) ?? '(root)'
  throw new TerrainError(
    'INVALID_MANIFEST',
    `Stop manifest field ${path} is invalid: ${issue.message}. Pass a version 2 or ${STOP_MANIFEST_VERSION} manifest built by buildStopManifest.`,
    { cause: new v.ValiError(result.issues) },
  )
}

/** JSON with object keys sorted at every level, so equal values always serialise alike. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, item]) => `${JSON.stringify(k)}:${canonicalJson(item)}`).join(',')}}`
}

function assertWorldHash(hash: string): void {
  if (!WORLD_HASH.test(hash)) {
    throw new TerrainError(
      'INVALID_CONFIG',
      `World hash is "${hash}"; pass the 16 hex characters returned by worldHash(world).`,
    )
  }
}

function assertMissionId(missionId: string): void {
  if (!MISSION_ID.test(missionId)) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `Mission id is ${JSON.stringify(missionId)}; pass the mission's id, a lowercase UUID.`,
    )
  }
}

function assertStopIndex(stopIndex: number): void {
  if (!Number.isSafeInteger(stopIndex) || stopIndex < 0) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `Stop index is ${stopIndex}; pass a non-negative integer.`,
    )
  }
}
