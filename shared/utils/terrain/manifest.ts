import * as v from 'valibot'
import type { ChunkCoords } from './chunk'
import { assertChunkCoord } from './chunk'
import type { StopDisk } from './disk'
import { chunksNearestFirst } from './disk'
import { TerrainError } from './errors'
import { hashString } from './seed'
import type { World } from './world'

/** Manifest version written by {@link buildStopManifest}. */
export const STOP_MANIFEST_VERSION = 4

const WORLD_HASH = /^[0-9a-f]{16}$/
/** A mission id as the database makes them: a lowercase UUID. */
export const MISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A revealed mask's digest as {@link revealedMaskDigest} writes it. */
const MASK_DIGEST = /^[0-9a-f]{16}$/

/** What names the objects of the landing stop, which no drive reached. */
export const LANDING_STOP = 'landing'

const positive = v.pipe(v.number(), v.finite(), v.gtValue(0))

const int32 = v.pipe(v.number(), v.integer(), v.minValue(-0x80000000), v.maxValue(0x7fffffff))

const finite = v.pipe(v.number(), v.finite())

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
  /** Where the stop stands; versions before 4 also carry its index, which readers ignore. */
  stop: v.object({ x: finite, y: finite }),
  radius: positive,
  /** Nearest the stop first (see `chunksNearestFirst`) from version 3, by (cy, cx) before. */
  chunks: v.array(v.object({ cx: int32, cy: int32, key: v.string() })),
  revealedKey: v.string(),
}

/** What version 3 added: a pack of the listed chunks and their height range. */
const PACKED_ENTRIES = {
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
}

/**
 * JSON manifest of one stop, as {@link buildStopManifest} writes it: the disk's chunk blobs, the
 * same chunks as one pack, and the revealed mask as of that stop. It holds nothing but what the
 * stop's disk and mask determine, so it is written before the stop takes its index.
 */
export const StopManifestV4Schema = v.object({
  version: v.literal(STOP_MANIFEST_VERSION),
  ...STOP_MANIFEST_ENTRIES,
  ...PACKED_ENTRIES,
})

/**
 * Every manifest version a store may serve. Older stops stay readable forever because their
 * blobs are immutable: version 2, written before disk packs, has no `packKey` and no
 * `heightRange`, and a reader of it loads chunk by chunk and measures the heights itself; version
 * 3 differs from 4 only by the stop index it carries.
 */
export const StopManifestSchema = v.variant('version', [
  v.object({ version: v.literal(2), ...STOP_MANIFEST_ENTRIES }),
  v.object({ version: v.literal(3), ...STOP_MANIFEST_ENTRIES, ...PACKED_ENTRIES }),
  StopManifestV4Schema,
])

/** A manifest as {@link buildStopManifest} writes it. */
export type StopManifestV4 = v.InferOutput<typeof StopManifestV4Schema>

/** A parsed manifest of any served version: a pack and a height range only from version 3. */
export type StopManifest = Omit<StopManifestV4, 'version' | 'heightRange' | 'packKey'> & {
  version: 2 | 3 | typeof STOP_MANIFEST_VERSION
  heightRange?: StopManifestV4['heightRange']
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

/** Where a stop's objects are stored: its manifest, its revealed mask and its disk pack. */
export interface StopKeys {
  manifestKey: string
  revealedKey: string
  packKey: string
}

/**
 * The keys of a stop's objects, named by what produced them: the drive that reached the stop
 * (`reachedBy`, its segment id; null for the landing stop, named {@link LANDING_STOP}) and, for the
 * mask and the manifest naming it, the mask's own digest. Never by the stop's index: ticks prepare
 * a stop before it takes one, and one working from an old snapshot must not write under a key a
 * later stop will be given. So two runs preparing the same stop write the same bytes under the
 * same keys, and a mask computed from another starting mask gets keys of its own. The pack depends
 * on the disk alone, which the drive's end fixes. Masks and stops are per mission, since two
 * missions on one world see different ground; chunks are not.
 */
export function stopKeys(
  missionId: string,
  options: { reachedBy: string | null; maskDigest: string },
): StopKeys {
  const { reachedBy, maskDigest } = options
  assertMissionId(missionId)
  if (reachedBy !== null && !MISSION_ID.test(reachedBy)) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `Segment id is ${JSON.stringify(reachedBy)}; pass the id of the drive that reached the stop, a lowercase UUID, or null for the landing stop.`,
    )
  }
  if (!MASK_DIGEST.test(maskDigest)) {
    throw new TerrainError(
      'OUT_OF_BOUNDS',
      `Mask digest is ${JSON.stringify(maskDigest)}; pass the 16 hex characters revealedMaskDigest returns.`,
    )
  }
  const base = `missions/${missionId}`
  const name = reachedBy ?? LANDING_STOP
  return {
    manifestKey: `${base}/stops/${name}.${maskDigest}.json`,
    revealedKey: `${base}/revealed/${name}.${maskDigest}.bin`,
    packKey: `${base}/stops/${name}.pack`,
  }
}

/** A stop's manifest over `disk`, naming the objects {@link stopKeys} gives it. */
export function buildStopManifest(
  world: World,
  disk: StopDisk,
  options: { missionId: string; keys: Pick<StopKeys, 'revealedKey' | 'packKey'> },
): StopManifestV4 {
  const { missionId, keys } = options
  const hash = worldHash(world)
  const { chunkSize, cellSize, mastHeight, slopeLimitDeg } = world.config
  return {
    version: STOP_MANIFEST_VERSION,
    missionId,
    worldHash: hash,
    world: { chunkSize, cellSize, mastHeight, slopeLimitDeg },
    stop: { x: disk.center.x, y: disk.center.y },
    radius: disk.radius,
    heightRange: heightRangeOf(disk.grid.heights),
    chunks: chunksNearestFirst(disk.chunks, { center: disk.center, chunkSize }).map(
      ({ cx, cy }) => ({ cx, cy, key: chunkKey(hash, { cx, cy }) }),
    ),
    packKey: keys.packKey,
    revealedKey: keys.revealedKey,
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
    `Stop manifest field ${path} is invalid: ${issue.message}. Pass a version 2 to ${STOP_MANIFEST_VERSION} manifest built by buildStopManifest.`,
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
