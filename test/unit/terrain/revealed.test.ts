import { describe, expect, it } from 'vitest'
import type { RevealedMask, StopDisk, World } from '#shared/utils/terrain'
import {
  computeStopDisk,
  createRevealedMask,
  decodeRevealedMask,
  defineWorld,
  encodeRevealedMask,
  isRevealed,
  revealDisk,
  revealedOverDisk,
  revealVertices,
  TerrainError,
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

/** World positions of every vertex the disk marks visible. */
function visiblePoints(world: World, disk: StopDisk): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = []
  const { cellSize } = world.config
  for (let gj = 0; gj < disk.grid.height; gj++) {
    for (let gi = 0; gi < disk.grid.width; gi++) {
      if (disk.visible[gj * disk.grid.width + gi])
        points.push({ x: (gi + disk.origin.i) * cellSize, y: (gj + disk.origin.j) * cellSize })
    }
  }
  return points
}

function snapshot(mask: RevealedMask): [string, number[]][] {
  return [...mask.chunks].map(([key, bits]) => [key, Array.from(bits)])
}

const world = defineWorld({ seed: 'mars' })
const first = computeStopDisk(world, { center: { x: 10, y: 10 }, radius: 90 })
const second = computeStopDisk(world, { center: { x: 150.5, y: 30.2 }, radius: 90 })

describe('revealed mask', () => {
  it('starts empty with the world’s chunk shape', () => {
    const mask = createRevealedMask(world)
    expect(mask.version).toBe(1)
    expect(mask.cellSize).toBe(1)
    expect(mask.vertexCount).toBe(65)
    expect(mask.chunks.size).toBe(0)
    expect(isRevealed(mask, world, { x: 10, y: 10 })).toBe(false)
  })

  it('returns a new mask and leaves its input untouched', () => {
    const empty = createRevealedMask(world)
    const once = revealDisk(empty, first)
    expect(once).not.toBe(empty)
    expect(empty.chunks.size).toBe(0)
    const before = snapshot(once)
    const twice = revealDisk(once, second)
    expect(snapshot(once)).toEqual(before)
    expect(twice).not.toBe(once)
  })

  it('reveals exactly the visible vertices of one stop', () => {
    const mask = revealDisk(createRevealedMask(world), first)
    for (const point of visiblePoints(world, first))
      expect(isRevealed(mask, world, point)).toBe(true)
    let hidden = 0
    for (let gj = 0; gj < first.grid.height; gj++) {
      for (let gi = 0; gi < first.grid.width; gi++) {
        if (first.visible[gj * first.grid.width + gi]) continue
        const point = { x: gi + first.origin.i, y: gj + first.origin.j }
        expect(isRevealed(mask, world, point)).toBe(false)
        hidden++
      }
    }
    expect(hidden).toBeGreaterThan(0)
  })

  it('ORs stops together', () => {
    const mask = revealDisk(revealDisk(createRevealedMask(world), first), second)
    const points = [...visiblePoints(world, first), ...visiblePoints(world, second)]
    for (const point of points) expect(isRevealed(mask, world, point)).toBe(true)
    expect(revealDisk(revealDisk(createRevealedMask(world), second), first).chunks).toEqual(
      mask.chunks,
    )
  })

  it('is false for a point in no stored chunk', () => {
    const mask = revealDisk(createRevealedMask(world), first)
    expect(isRevealed(mask, world, { x: 5000, y: -5000 })).toBe(false)
  })

  it('finds an edge vertex stored only in the chunk west or south of it', () => {
    const bits = new Uint8Array(65 * 65)
    bits[10 * 65 + 64] = 1
    bits[64 * 65 + 64] = 1
    const mask: RevealedMask = { ...createRevealedMask(world), chunks: new Map([['0,0', bits]]) }
    expect(isRevealed(mask, world, { x: 64, y: 10 })).toBe(true)
    expect(isRevealed(mask, world, { x: 64, y: 64 })).toBe(true)
    expect(isRevealed(mask, world, { x: 63, y: 10 })).toBe(false)
  })

  it('refuses a disk from a world with a different cell size', () => {
    const coarse = defineWorld({ seed: 'mars', cellSize: 2 })
    const disk = computeStopDisk(coarse, { center: { x: 0, y: 0 }, radius: 40 })
    expect(terrainErrorOf(() => revealDisk(createRevealedMask(world), disk))?.code).toBe(
      'INVALID_GRID',
    )
  })
})

describe('revealedOverDisk', () => {
  it('matches isRevealed at every vertex of the disk grid', () => {
    const mask = revealDisk(createRevealedMask(world), second)
    const bits = revealedOverDisk(mask, first)
    const { width, height } = first.grid
    expect(bits.length).toBe(width * height)
    let revealed = 0
    let hidden = 0
    for (let gj = 0; gj < height; gj++) {
      for (let gi = 0; gi < width; gi++) {
        const point = { x: gi + first.origin.i, y: gj + first.origin.j }
        const expected = isRevealed(mask, world, point) ? 1 : 0
        expect(bits[gj * width + gi]).toBe(expected)
        if (expected) revealed++
        else hidden++
      }
    }
    expect(revealed).toBeGreaterThan(0)
    expect(hidden).toBeGreaterThan(0)
  })

  it('refuses a disk from a world with a different cell size', () => {
    const coarse = defineWorld({ seed: 'mars', cellSize: 2 })
    const disk = computeStopDisk(coarse, { center: { x: 0, y: 0 }, radius: 40 })
    expect(terrainErrorOf(() => revealedOverDisk(createRevealedMask(world), disk))?.code).toBe(
      'INVALID_GRID',
    )
  })
})

describe('revealVertices', () => {
  it('adds disk-grid vertices, shared chunk edges included, without touching its input', () => {
    const empty = createRevealedMask(world)
    const { width } = first.grid
    // An interior vertex, and one on a chunk corner shared by four chunks.
    const interior = { x: 5, y: 7 }
    const corner = { x: 64, y: 64 }
    const index = (p: { x: number; y: number }) =>
      (p.y - first.origin.j) * width + (p.x - first.origin.i)
    const mask = revealVertices(empty, first, [index(interior), index(corner)])
    expect(empty.chunks.size).toBe(0)
    expect(isRevealed(mask, world, interior)).toBe(true)
    expect(isRevealed(mask, world, corner)).toBe(true)
    expect(isRevealed(mask, world, { x: 6, y: 7 })).toBe(false)
    // The corner is held by every chunk that stores it, as revealDisk would.
    for (const key of ['0,0', '1,0', '0,1', '1,1']) expect(mask.chunks.has(key)).toBe(true)
    const bits = revealedOverDisk(mask, first)
    expect(bits.reduce((n, b) => n + b, 0)).toBe(2)
  })

  it('agrees with revealDisk over the visible vertices', () => {
    const visible: number[] = []
    for (let k = 0; k < first.visible.length; k++) if (first.visible[k]) visible.push(k)
    const viaVertices = revealVertices(createRevealedMask(world), first, visible)
    const viaDisk = revealDisk(createRevealedMask(world), first)
    expect(revealedOverDisk(viaVertices, first)).toEqual(revealedOverDisk(viaDisk, first))
  })

  it('refuses a vertex outside the disk grid', () => {
    const size = first.grid.width * first.grid.height
    expect(
      terrainErrorOf(() => revealVertices(createRevealedMask(world), first, [size]))?.code,
    ).toBe('OUT_OF_BOUNDS')
  })
})

describe('revealed mask binary format v1', () => {
  const mask = revealDisk(revealDisk(createRevealedMask(world), first), second)
  const packed = Math.ceil((65 * 65) / 8)

  it('writes the documented header and packed size', () => {
    const bytes = encodeRevealedMask(mask)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('JRRV')
    expect(view.getUint8(4)).toBe(1)
    expect(view.getUint8(5)).toBe(0)
    expect(view.getUint16(6, true)).toBe(65)
    expect(view.getFloat32(8, true)).toBe(1)
    expect(view.getUint32(12, true)).toBe(mask.chunks.size)
    expect(bytes.byteLength).toBe(16 + mask.chunks.size * (8 + packed))
  })

  it('round-trips byte-identically', () => {
    const bytes = encodeRevealedMask(mask)
    const decoded = decodeRevealedMask(bytes)
    expect(decoded.version).toBe(1)
    expect(decoded.vertexCount).toBe(65)
    expect(decoded.cellSize).toBe(1)
    expect(new Map(decoded.chunks)).toEqual(new Map(mask.chunks))
    expect(encodeRevealedMask(decoded)).toEqual(bytes)
  })

  it('round-trips an empty mask', () => {
    const bytes = encodeRevealedMask(createRevealedMask(world))
    expect(bytes.byteLength).toBe(16)
    expect(decodeRevealedMask(bytes).chunks.size).toBe(0)
  })

  it('decodes from an unaligned view', () => {
    const bytes = encodeRevealedMask(mask)
    const padded = new Uint8Array(bytes.byteLength + 1)
    padded.set(bytes, 1)
    expect(encodeRevealedMask(decodeRevealedMask(padded.subarray(1)))).toEqual(bytes)
  })

  it('refuses a wrong magic', () => {
    const bytes = encodeRevealedMask(mask)
    bytes[0] = 0x58
    expect(terrainErrorOf(() => decodeRevealedMask(bytes))?.code).toBe('INVALID_MAGIC')
  })

  it('refuses a chunk blob', () => {
    const bytes = encodeRevealedMask(mask)
    bytes.set(new TextEncoder().encode('JRTC'), 0)
    expect(terrainErrorOf(() => decodeRevealedMask(bytes))?.code).toBe('INVALID_MAGIC')
  })

  it('refuses an unknown version or flags', () => {
    const bytes = encodeRevealedMask(mask)
    bytes[4] = 2
    expect(terrainErrorOf(() => decodeRevealedMask(bytes))?.code).toBe('UNSUPPORTED_VERSION')
    const flagged = encodeRevealedMask(mask)
    flagged[5] = 1
    expect(terrainErrorOf(() => decodeRevealedMask(flagged))?.code).toBe('UNSUPPORTED_VERSION')
  })

  it('refuses truncated buffers', () => {
    const bytes = encodeRevealedMask(mask)
    expect(terrainErrorOf(() => decodeRevealedMask(bytes.subarray(0, 3)))?.code).toBe('TRUNCATED')
    expect(terrainErrorOf(() => decodeRevealedMask(bytes.subarray(0, 10)))?.code).toBe('TRUNCATED')
    expect(
      terrainErrorOf(() => decodeRevealedMask(bytes.subarray(0, bytes.byteLength - 1)))?.code,
    ).toBe('TRUNCATED')
  })

  it('refuses trailing bytes', () => {
    const bytes = encodeRevealedMask(mask)
    const longer = new Uint8Array(bytes.byteLength + 4)
    longer.set(bytes)
    expect(terrainErrorOf(() => decodeRevealedMask(longer))?.code).toBe('TRAILING_DATA')
  })

  it('refuses a chunk listed twice', () => {
    const bytes = encodeRevealedMask(mask)
    const stride = 8 + packed
    const view = new DataView(bytes.buffer)
    view.setInt32(16 + stride, view.getInt32(16, true), true)
    view.setInt32(16 + stride + 4, view.getInt32(20, true), true)
    expect(terrainErrorOf(() => decodeRevealedMask(bytes))?.code).toBe('INVALID_GRID')
  })
})
