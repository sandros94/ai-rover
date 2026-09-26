import * as v from 'valibot'
import type { ChunkCoords } from './chunk'
import { assertChunkCoord } from './chunk'
import type { StopDisk } from './disk'
import { TerrainError } from './errors'
import { hashString } from './seed'
import type { World } from './world'

/**
 * Manifest version written by {@link buildStopManifest}, and the only one parsed: no version 1
 * manifest (without `world`) remains in any store that is served.
 */
export const STOP_MANIFEST_VERSION = 2

const WORLD_HASH = /^[0-9a-f]{16}$/
/** A mission id as the database makes them: a lowercase UUID. */
export const MISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const positive = v.pipe(v.number(), v.finite(), v.gtValue(0))

const int32 = v.pipe(v.number(), v.integer(), v.minValue(-0x80000000), v.maxValue(0x7fffffff))

/** JSON manifest of one stop: the disk's chunk blobs and the revealed mask as of that stop. */
export const StopManifestSchema = v.object({
  version: v.literal(STOP_MANIFEST_VERSION),
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
  chunks: v.array(v.object({ cx: int32, cy: int32, key: v.string() })),
  revealedKey: v.string(),
})

export type StopManifest = v.InferOutput<typeof StopManifestSchema>

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

export function buildStopManifest(
  world: World,
  disk: StopDisk,
  options: { missionId: string; stopIndex: number },
): StopManifest {
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
    chunks: disk.chunks.map(({ cx, cy }) => ({ cx, cy, key: chunkKey(hash, { cx, cy }) })),
    revealedKey: revealedKey(missionId, stopIndex),
  }
}

export function parseStopManifest(value: unknown): StopManifest {
  const result = v.safeParse(StopManifestSchema, value)
  if (result.success) return result.output
  const [issue] = result.issues
  const path = v.getDotPath(issue) ?? '(root)'
  throw new TerrainError(
    'INVALID_MANIFEST',
    `Stop manifest field ${path} is invalid: ${issue.message}. Pass a version ${STOP_MANIFEST_VERSION} manifest built by buildStopManifest.`,
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
