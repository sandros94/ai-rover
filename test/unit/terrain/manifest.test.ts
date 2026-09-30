import { describe, expect, it } from 'vitest'
import {
  buildStopManifest,
  chunksNearestFirst,
  chunkKey,
  computeStopDisk,
  defineWorld,
  parseStopManifest,
  STOP_MANIFEST_VERSION,
  stopKeys,
  TerrainError,
  worldHash,
} from '#shared/utils/terrain'

/** The TerrainError thrown by `fn`, or undefined when it throws nothing or something else. */
function terrainErrorOf(fn: () => unknown): TerrainError | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof TerrainError) return error
  }
  return undefined
}

describe('worldHash', () => {
  it('is 16 hex characters and stable across world instances', () => {
    const a = worldHash(defineWorld({ seed: 'mars' }))
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(worldHash(defineWorld({ seed: 'mars' }))).toBe(a)
  })

  it('depends on the resolved config, not on how it was spelled', () => {
    const implicit = worldHash(defineWorld({ seed: 'mars' }))
    const explicit = worldHash(
      defineWorld({
        craters: { cellSize: 256 },
        seed: 'mars',
        chunkSize: 64,
        relief: { gain: 0.5 },
      }),
    )
    expect(explicit).toBe(implicit)
  })

  it('changes with any field', () => {
    const base = worldHash(defineWorld({ seed: 'mars' }))
    expect(worldHash(defineWorld({ seed: 'mars', relief: { amplitude: 17 } }))).not.toBe(base)
    expect(worldHash(defineWorld({ seed: 'deimos' }))).not.toBe(base)
    expect(worldHash(defineWorld({ seed: 'mars', mastHeight: 2.5 }))).not.toBe(base)
    expect(worldHash(defineWorld({ seed: 'mars', craters: { minFreshness: 0.4 } }))).not.toBe(base)
  })
})

const MISSION = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const SEGMENT = '0190a1b2-c3d4-8e5f-8a9b-0c1d2e3f4a5c'
const DIGEST = '0123456789abcdef'
const KEYS = stopKeys(MISSION, { reachedBy: SEGMENT, maskDigest: DIGEST })

describe('blob keys', () => {
  it('follow the documented layout: chunks per world, stops and masks per mission', () => {
    expect(chunkKey('0123456789abcdef', { cx: -3, cy: 7 })).toBe(
      'terrain/0123456789abcdef/chunks/-3_7.bin',
    )
    expect(KEYS).toEqual({
      manifestKey: `missions/${MISSION}/stops/${SEGMENT}.${DIGEST}.json`,
      revealedKey: `missions/${MISSION}/revealed/${SEGMENT}.${DIGEST}.bin`,
      packKey: `missions/${MISSION}/stops/${SEGMENT}.pack`,
    })
  })

  it('name the landing stop, which no drive reached, landing', () => {
    expect(stopKeys(MISSION, { reachedBy: null, maskDigest: DIGEST })).toEqual({
      manifestKey: `missions/${MISSION}/stops/landing.${DIGEST}.json`,
      revealedKey: `missions/${MISSION}/revealed/landing.${DIGEST}.bin`,
      packKey: `missions/${MISSION}/stops/landing.pack`,
    })
  })

  it('refuses a segment id that is not a lowercase UUID, and a digest that is not 16 hex', () => {
    for (const reachedBy of ['landing', '4', SEGMENT.toUpperCase(), `${SEGMENT}/..`]) {
      expect(terrainErrorOf(() => stopKeys(MISSION, { reachedBy, maskDigest: DIGEST }))?.code).toBe(
        'OUT_OF_BOUNDS',
      )
    }
    for (const maskDigest of ['', '0123', DIGEST.toUpperCase(), `${DIGEST}0`]) {
      expect(
        terrainErrorOf(() => stopKeys(MISSION, { reachedBy: SEGMENT, maskDigest }))?.code,
      ).toBe('OUT_OF_BOUNDS')
    }
  })

  it('refuses a mission id that is not a lowercase UUID', () => {
    for (const id of ['', '0123456789abcdef', MISSION.toUpperCase(), `${MISSION}/..`]) {
      expect(
        terrainErrorOf(() => stopKeys(id, { reachedBy: null, maskDigest: DIGEST }))?.code,
      ).toBe('OUT_OF_BOUNDS')
    }
  })

  it('refuses non-integer chunk coordinates', () => {
    expect(terrainErrorOf(() => chunkKey('0123456789abcdef', { cx: 0.5, cy: 0 }))?.code).toBe(
      'OUT_OF_BOUNDS',
    )
  })
})

describe('stop manifest', () => {
  const world = defineWorld({ seed: 'mars' })
  const disk = computeStopDisk(world, { center: { x: 12.5, y: -3 }, radius: 70 })
  const manifest = buildStopManifest(world, disk, { missionId: MISSION, keys: KEYS })
  const hash = worldHash(world)

  it('describes the disk with its blob keys', () => {
    expect(STOP_MANIFEST_VERSION).toBe(4)
    expect(manifest).toEqual({
      version: 4,
      missionId: MISSION,
      worldHash: hash,
      world: { chunkSize: 64, cellSize: 1, mastHeight: 2, slopeLimitDeg: 16 },
      stop: { x: 12.5, y: -3 },
      radius: 70,
      heightRange: manifest.heightRange,
      chunks: chunksNearestFirst(disk.chunks, { center: disk.center, chunkSize: 64 }).map((c) => ({
        cx: c.cx,
        cy: c.cy,
        key: chunkKey(hash, c),
      })),
      packKey: KEYS.packKey,
      revealedKey: KEYS.revealedKey,
    })
  })

  it('reads a version 3 manifest, which also names its stop index', () => {
    const v3 = { ...manifest, version: 3, stop: { index: 3, ...manifest.stop } }
    const parsed = parseStopManifest(JSON.parse(JSON.stringify(v3)))
    expect(parsed).toEqual({ ...manifest, version: 3 })
  })

  it('spans the heights of every listed chunk', () => {
    const present = disk.grid.heights.filter((h) => !Number.isNaN(h))
    expect(manifest.heightRange).toEqual({
      min: Math.min(...present),
      max: Math.max(...present),
    })
    expect(manifest.heightRange.min).toBeLessThan(manifest.heightRange.max)
  })

  it('refuses a height range whose min exceeds its max, naming the field', () => {
    const { min, max } = manifest.heightRange
    const error = terrainErrorOf(() =>
      parseStopManifest({ ...manifest, heightRange: { min: max, max: min } }),
    )
    expect(error?.code).toBe('INVALID_MANIFEST')
    expect(error?.message).toContain('heightRange')
  })

  it('refuses a manifest without its pack key, naming the field', () => {
    const { packKey: _packKey, ...v2 } = manifest
    expect(terrainErrorOf(() => parseStopManifest(v2))?.message).toContain('packKey')
  })

  it('carries the geometry of a non-default world', () => {
    const custom = defineWorld({ seed: 'mars', chunkSize: 32, cellSize: 2, mastHeight: 1.5 })
    const built = buildStopManifest(
      custom,
      computeStopDisk(custom, { center: { x: 0, y: 0 }, radius: 40 }),
      { missionId: MISSION, keys: KEYS },
    )
    expect(built.world).toEqual({ chunkSize: 32, cellSize: 2, mastHeight: 1.5, slopeLimitDeg: 16 })
  })

  it('round-trips through JSON and parse', () => {
    expect(parseStopManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
  })

  it('refuses another version, naming the field', () => {
    const error = terrainErrorOf(() => parseStopManifest({ ...manifest, version: 5 }))
    expect(error?.code).toBe('INVALID_MANIFEST')
    expect(error?.message).toContain('version')
    expect(error?.cause).toBeInstanceOf(Error)
    expect(terrainErrorOf(() => parseStopManifest({ version: 5 }))?.message).toContain('version')
  })

  it('reads a version 2 manifest, written before packs, without a pack or a height range', () => {
    const { packKey: _packKey, heightRange: _heightRange, ...rest } = manifest
    const v2 = { ...rest, version: 2 }
    const parsed = parseStopManifest(JSON.parse(JSON.stringify(v2)))
    expect(parsed).toEqual(v2)
    expect(parsed.packKey).toBeUndefined()
    expect(parsed.heightRange).toBeUndefined()
  })

  it('refuses a version 1 manifest, which carries no world geometry', () => {
    const { world: _world, ...v1 } = manifest
    const error = terrainErrorOf(() => parseStopManifest({ ...v1, version: 1 }))
    expect(error?.code).toBe('INVALID_MANIFEST')
    expect(error?.message).toContain('version')
  })

  it('refuses a manifest without world geometry or with a broken one, naming the field', () => {
    const { world: _world, ...rest } = manifest
    expect(terrainErrorOf(() => parseStopManifest(rest))?.message).toContain('world')
    for (const [field, value] of [
      ['chunkSize', 0],
      ['cellSize', -1],
      ['mastHeight', Number.NaN],
      ['slopeLimitDeg', 90],
    ] as const) {
      const broken = { ...manifest, world: { ...manifest.world, [field]: value } }
      const error = terrainErrorOf(() => parseStopManifest(broken))
      expect(error?.code).toBe('INVALID_MANIFEST')
      expect(error?.message).toContain(`world.${field}`)
    }
  })

  it('refuses a manifest without chunks, naming the field', () => {
    const { chunks: _chunks, ...rest } = manifest
    const error = terrainErrorOf(() => parseStopManifest(rest))
    expect(error?.code).toBe('INVALID_MANIFEST')
    expect(error?.message).toContain('chunks')
  })

  it('names nested paths', () => {
    const broken = { ...manifest, chunks: [{ cx: 0, cy: 'x', key: 'k' }] }
    expect(terrainErrorOf(() => parseStopManifest(broken))?.message).toContain('chunks.0.cy')
  })
})
