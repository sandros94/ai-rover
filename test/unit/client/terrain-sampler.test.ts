import { describe, expect, it } from 'vitest'
import {
  buildStopManifest,
  computeStopDisk,
  encodeChunk,
  generateChunk,
} from '#shared/utils/terrain'
import { createChunkCache, createJourneyClient, createTerrainSampler } from '#shared/utils/client'
import { JOURNEY_FIXTURE, journeyFixture, recordsFetch } from './helpers'

const fixture = journeyFixture()
const { worldHash } = fixture.stopManifest

function setup() {
  const client = createJourneyClient({ fetch: recordsFetch().fetch })
  const cache = createChunkCache({ client, worldHash })
  return { cache, sampler: createTerrainSampler(cache) }
}

/** Height of world vertex (i, j) in the fixture disk. */
function vertex(i: number, j: number): number {
  const { grid, origin } = fixture.disk
  return grid.heights[(j - origin.j) * grid.width + (i - origin.i)]!
}

describe('createTerrainSampler over the recorded chunks', () => {
  it('knows nothing before a chunk is loaded', () => {
    const { sampler } = setup()
    expect(sampler.heightAt(1, 1)).toBeUndefined()
    expect(sampler.traversableAt(1, 1)).toBeUndefined()
    expect(sampler.assembleDiskGrid(fixture.stopManifest)).toBeUndefined()
  })

  it('returns the chunk height exactly on a vertex', async () => {
    const { cache, sampler } = setup()
    await cache.prefetch(fixture.stopManifest.chunks)
    for (const [i, j] of [
      [0, 0],
      [5, 7],
      [-64, -64],
      [63, 63],
      [64, 64],
      [-13, 40],
      [0, -30],
    ] as const) {
      expect(sampler.heightAt(i, j)).toBe(vertex(i, j))
    }
  })

  it('interpolates bilinearly between vertices', async () => {
    const { cache, sampler } = setup()
    await cache.prefetch(fixture.stopManifest.chunks)
    for (const [x, y] of [
      [10.5, 20.5],
      [-3.25, 7.75],
      [-0.5, -0.5],
      [12.2, -40.9],
    ] as const) {
      const i = Math.floor(x)
      const j = Math.floor(y)
      const u = x - i
      const w = y - j
      const expected =
        vertex(i, j) * (1 - u) * (1 - w) +
        vertex(i + 1, j) * u * (1 - w) +
        vertex(i, j + 1) * (1 - u) * w +
        vertex(i + 1, j + 1) * u * w
      expect(sampler.heightAt(x, y)).toBeCloseTo(expected, 9)
    }
    expect(sampler.heightAt(10.5, 20)).toBeCloseTo((vertex(10, 20) + vertex(11, 20)) / 2, 9)
  })

  it('is undefined outside the loaded chunks, and samples a shared edge from either side', async () => {
    const { cache, sampler } = setup()
    await cache.get(-1, 0)
    expect(sampler.heightAt(-10, 10)).toBeDefined()
    expect(sampler.heightAt(10, 10)).toBeUndefined()
    expect(sampler.heightAt(-10, -10)).toBeUndefined()
    expect(sampler.heightAt(200, 0)).toBeUndefined()
    expect(sampler.heightAt(0, 10)).toBe(vertex(0, 10))
    expect(sampler.heightAt(0, 64)).toBe(vertex(0, 64))
    expect(sampler.heightAt(Number.NaN, 0)).toBeUndefined()
  })

  it("reads the nearest vertex's traversable bit", async () => {
    const { cache, sampler } = setup()
    await cache.prefetch(fixture.stopManifest.chunks)
    const { disk } = fixture
    for (let j = disk.origin.j; j < disk.origin.j + disk.grid.height; j += 7) {
      for (let i = disk.origin.i; i < disk.origin.i + disk.grid.width; i += 5) {
        const k = (j - disk.origin.j) * disk.grid.width + (i - disk.origin.i)
        expect(sampler.traversableAt(i + 0.3, j - 0.4)).toBe(disk.traversable[k] === 1)
      }
    }
  })

  it('assembles the disk grid computeStopDisk builds, once every chunk is loaded', async () => {
    const { cache, sampler } = setup()
    await cache.get(0, 0)
    expect(sampler.assembleDiskGrid(fixture.stopManifest)).toBeUndefined()
    await cache.prefetch(fixture.stopManifest.chunks)
    const disk = computeStopDisk(fixture.world, {
      center: { x: fixture.stopManifest.stop.x, y: fixture.stopManifest.stop.y },
      radius: fixture.stopManifest.radius,
    })
    const assembled = sampler.assembleDiskGrid(fixture.stopManifest)!
    expect(assembled.grid).toEqual(disk.grid)
    expect(assembled.origin).toEqual(disk.origin)
    expect(assembled.traversable).toEqual(disk.traversable)
  })

  it('leaves the bounding-box corners outside every listed chunk NaN and untraversable', async () => {
    const { world } = fixture
    const disk = computeStopDisk(world, { center: { x: 10, y: -5 }, radius: 130 })
    const manifest = buildStopManifest(world, disk, {
      missionId: JOURNEY_FIXTURE.missionId,
      keys: fixture.stopKeys,
    })
    const client = createJourneyClient({
      // Chunks beyond the recorded four, generated as the server would store them.
      fetch: async (input) => {
        const [cx, cy] = /(-?\d+)_(-?\d+)\.bin$/.exec(input)!.slice(1).map(Number)
        const bytes = encodeChunk(generateChunk(world, { cx: cx!, cy: cy! }))
        return new Response(bytes as Uint8Array<ArrayBuffer>)
      },
    })
    const cache = createChunkCache({ client, worldHash })
    await cache.prefetch(manifest.chunks)
    const assembled = createTerrainSampler(cache).assembleDiskGrid(manifest)!
    expect(assembled.grid.heights.some(Number.isNaN)).toBe(true)
    expect(assembled.grid).toEqual(disk.grid)
    expect(assembled.origin).toEqual(disk.origin)
    expect(assembled.traversable).toEqual(disk.traversable)
  })
})
