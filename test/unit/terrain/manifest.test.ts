import { describe, expect, it } from 'vitest'
import {
  buildStopManifest,
  chunkKey,
  computeStopDisk,
  defineWorld,
  parseStopManifest,
  revealedKey,
  STOP_MANIFEST_VERSION,
  stopManifestKey,
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

describe('blob keys', () => {
  it('follow the documented layout', () => {
    expect(chunkKey('0123456789abcdef', { cx: -3, cy: 7 })).toBe(
      'terrain/0123456789abcdef/chunks/-3_7.bin',
    )
    expect(revealedKey('0123456789abcdef', 4)).toBe('terrain/0123456789abcdef/revealed/4.bin')
    expect(stopManifestKey('0123456789abcdef', 4)).toBe('terrain/0123456789abcdef/stops/4.json')
  })

  it('refuses a negative or fractional stop index', () => {
    expect(terrainErrorOf(() => revealedKey('0123456789abcdef', -1))?.code).toBe('OUT_OF_BOUNDS')
    expect(terrainErrorOf(() => stopManifestKey('0123456789abcdef', 1.5))?.code).toBe(
      'OUT_OF_BOUNDS',
    )
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
  const manifest = buildStopManifest(world, disk, { stopIndex: 3 })
  const hash = worldHash(world)

  it('describes the disk with its blob keys', () => {
    expect(STOP_MANIFEST_VERSION).toBe(1)
    expect(manifest).toEqual({
      version: 1,
      worldHash: hash,
      stop: { index: 3, x: 12.5, y: -3 },
      radius: 70,
      chunks: disk.chunks.map((c) => ({ cx: c.cx, cy: c.cy, key: chunkKey(hash, c) })),
      revealedKey: revealedKey(hash, 3),
    })
  })

  it('round-trips through JSON and parse', () => {
    expect(parseStopManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
  })

  it('refuses another version, naming the field', () => {
    const error = terrainErrorOf(() => parseStopManifest({ ...manifest, version: 2 }))
    expect(error?.code).toBe('INVALID_MANIFEST')
    expect(error?.message).toContain('version')
    expect(error?.cause).toBeInstanceOf(Error)
    expect(terrainErrorOf(() => parseStopManifest({ version: 2 }))?.message).toContain('version')
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

  it('refuses a non-integer stop index when building', () => {
    expect(terrainErrorOf(() => buildStopManifest(world, disk, { stopIndex: -1 }))?.code).toBe(
      'OUT_OF_BOUNDS',
    )
  })
})
