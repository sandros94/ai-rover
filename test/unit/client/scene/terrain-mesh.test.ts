import { describe, expect, it } from 'vitest'
import {
  chunkDistance,
  chunkLevel,
  chunkMesh,
  chunksFromGrid,
  chunkFogged,
  chunkRect,
  FOG_STEP,
  LOD_FAR_M,
  LOD_HYSTERESIS_M,
  recolourChunkMesh,
  refogChunkMesh,
} from '#shared/utils/client/scene/terrain-mesh'
import {
  groundRgb,
  HILLSHADE_EXAGGERATION,
  reliefRgb,
  srgbToLinear,
} from '#shared/utils/client/scene/palette'
import { fogSurface, revealTimes, updateRevealTimes } from '#shared/utils/client/fog'

const RANGE = { min: 0, max: 10 }

function chunk(vertexCount: number, heightAt: (a: number, b: number) => number, cx = 0, cy = 0) {
  const heights = new Float32Array(vertexCount * vertexCount)
  for (let b = 0; b < vertexCount; b++)
    for (let a = 0; a < vertexCount; a++) heights[b * vertexCount + a] = heightAt(a, b)
  return { cx, cy, vertexCount, cellSize: 1, heights }
}

/** Vertex k of a mesh as [x, y, z]. */
const vertex = (positions: Float32Array, k: number) =>
  Array.from(positions.subarray(3 * k, 3 * k + 3))

describe('chunkMesh', () => {
  it('builds one vertex per grid vertex and two triangles per cell for a 3×3 chunk', () => {
    const mesh = chunkMesh(
      chunk(3, (a, b) => a + 2 * b),
      { heightRange: RANGE },
    )
    expect(mesh.side).toBe(3)
    expect(mesh.positions).toHaveLength(9 * 3)
    expect(mesh.colors).toHaveLength(9 * 3)
    expect(mesh.indices).toHaveLength(2 * 2 * 2 * 3)
    expect(vertex(mesh.positions, 5)).toEqual([2, 1, 4])
  })

  it('welds shared edges: each interior vertex is used by all six triangles around it', () => {
    const mesh = chunkMesh(
      chunk(3, () => 1),
      { heightRange: RANGE },
    )
    const uses = Array.from({ length: 9 }, () => 0)
    for (const k of mesh.indices) uses[k] = uses[k]! + 1
    expect(uses[4]).toBe(6)
    expect(Math.max(...mesh.indices)).toBe(8)
  })

  it('winds every triangle counter-clockwise seen from above', () => {
    const mesh = chunkMesh(
      chunk(5, (a, b) => Math.sin(a) + b * 0.3),
      { heightRange: RANGE },
    )
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [p, q, r] = [0, 1, 2].map((o) => vertex(mesh.positions, mesh.indices[t + o]!))
      const cross = (q![0]! - p![0]!) * (r![1]! - p![1]!) - (q![1]! - p![1]!) * (r![0]! - p![0]!)
      expect(cross).toBeGreaterThan(0)
    }
  })

  it('places the chunk by its coordinates with vertices relative to its corner', () => {
    const mesh = chunkMesh(
      chunk(3, () => 0, -2, 5),
      { heightRange: RANGE },
    )
    expect(mesh.origin).toEqual({ x: -4, y: 10 })
    expect(vertex(mesh.positions, 8)).toEqual([2, 2, 0])
  })

  it('downsamples by the level step and keeps the four corners', () => {
    const c = chunk(9, (a, b) => a * 10 + b)
    const mesh = chunkMesh(c, { heightRange: RANGE, step: 4 })
    expect(mesh.side).toBe(3)
    expect(mesh.indices).toHaveLength(2 * 2 * 2 * 3)
    expect(vertex(mesh.positions, 0)).toEqual([0, 0, 0])
    expect(vertex(mesh.positions, 2)).toEqual([8, 0, 80])
    expect(vertex(mesh.positions, 6)).toEqual([0, 8, 8])
    expect(vertex(mesh.positions, 8)).toEqual([8, 8, 88])
  })

  it('refuses a step that does not divide the cells', () => {
    expect(() =>
      chunkMesh(
        chunk(9, () => 0),
        { heightRange: RANGE, step: 3 },
      ),
    ).toThrow(/step/)
  })

  it('hangs a skirt below every edge vertex, facing outwards', () => {
    const mesh = chunkMesh(
      chunk(3, () => 5),
      { heightRange: RANGE, skirtM: 2 },
    )
    // 8 edge vertices copied 2 m lower; 8 edge segments of two triangles each.
    expect(mesh.positions).toHaveLength((9 + 8) * 3)
    expect(mesh.indices).toHaveLength(2 * 2 * 2 * 3 + 8 * 2 * 3)
    for (let k = 9; k < 17; k++) expect(vertex(mesh.positions, k)[2]).toBe(3)
    // Each skirt triangle's normal points away from the chunk centre (1, 1).
    for (let t = 24; t < mesh.indices.length; t += 3) {
      const [p, q, r] = [0, 1, 2].map((o) => vertex(mesh.positions, mesh.indices[t + o]!))
      const u = [q![0]! - p![0]!, q![1]! - p![1]!, q![2]! - p![2]!]
      const v = [r![0]! - p![0]!, r![1]! - p![1]!, r![2]! - p![2]!]
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!]
      const mid = [(p![0]! + q![0]! + r![0]!) / 3 - 1, (p![1]! + q![1]! + r![1]!) / 3 - 1]
      expect(n[0]! * mid[0]! + n[1]! * mid[1]!).toBeGreaterThan(0)
    }
  })

  it('colours by the relief ramp in linear space, as the 2D map tints in sRGB', () => {
    const mesh = chunkMesh(
      chunk(3, () => 5),
      { heightRange: RANGE },
    )
    const expected = reliefRgb(0.5).map(srgbToLinear)
    for (let k = 0; k < 9; k++) {
      for (let c = 0; c < 3; c++) expect(mesh.colors[3 * k + c]).toBeCloseTo(expected[c]!, 5)
      // `+ 0` folds the -0 of a flat slope's negated gradient.
      expect(vertex(mesh.normals, k).map((c) => c + 0)).toEqual([0, 0, 1])
    }
  })

  it('gives each vertex the unit normal of its slope, scaled as the 2D hillshade scales it', () => {
    const mesh = chunkMesh(
      chunk(3, (a) => 0.2 * a),
      { heightRange: RANGE },
    )
    const g = 0.2 * HILLSHADE_EXAGGERATION
    const expected = [-g, 0, 1].map((c) => c / Math.hypot(g, 1))
    for (let k = 0; k < 9; k++) {
      vertex(mesh.normals, k).forEach((c, i) => expect(c).toBeCloseTo(expected[i]!, 6))
    }
  })

  it('lays fogged vertices on the fog surface, flat and fully fogged, hiding the true ground', () => {
    const c = chunk(5, (a, b) => 2 * a + b)
    // The chunk is the whole 5 × 5 disk grid; only the west column is revealed.
    const grid = { heights: c.heights, width: 5, height: 5, cellSize: 1 }
    const seen = new Uint8Array(25)
    for (let b = 0; b < 5; b++) seen[b * 5] = 1
    const surface = fogSurface(grid, { seen })
    const layout = { width: 5, origin: { i: 0, j: 0 } }
    const mesh = chunkMesh(c, { heightRange: RANGE, fog: { surface, layout, sight: seen } })
    const plain = chunkMesh(c, { heightRange: RANGE })
    const at = (array: Float32Array, k: number, c: number) => array[3 * k + c]!
    const revealed = [0, 5, 10, 15, 20]
    const fogged = Array.from({ length: 25 }, (_, k) => k).filter((k) => !seen[k])
    for (const k of revealed) {
      expect(at(mesh.positions, k, 2)).toBe(c.heights[k])
      for (let ch = 0; ch < 3; ch++) expect(at(mesh.colors, k, ch)).toBe(at(plain.colors, k, ch))
      for (let ch = 0; ch < 3; ch++) expect(at(mesh.normals, k, ch)).toBe(at(plain.normals, k, ch))
      expect(mesh.fogAmounts[k]).toBe(0)
    }
    for (const k of fogged) {
      expect(at(mesh.positions, k, 2)).toBeCloseTo(surface.heights[k]!, 6)
      expect(mesh.fogAmounts[k]).toBe(surface.amount[k])
      if (surface.amount[k] !== 1) continue
      expect(vertex(mesh.colors, k)).toEqual([0, 0, 0])
      expect(vertex(mesh.normals, k)).toEqual([0, 0, 1])
    }
    // No fogged vertex shows its true height.
    expect(mesh.positions[3 * 24 + 2]).not.toBeCloseTo(c.heights[24]!, 1)
  })

  it('leans the normal from the slope to the vertical as the fog thickens', () => {
    const c = chunk(3, (a) => 0.4 * a)
    const layout = { width: 3, origin: { i: 0, j: 0 } }
    const tilt = (amount: number) => {
      const surface = { heights: c.heights, amount: new Float32Array(9).fill(amount) }
      const n = vertex(chunkMesh(c, { heightRange: RANGE, fog: { surface, layout } }).normals, 4)
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 6)
      return Math.acos(n[2]!)
    }
    const [bare, half, full] = [tilt(0), tilt(0.5), tilt(1)]
    expect(bare).toBeGreaterThan(half)
    expect(half).toBeGreaterThan(full)
    expect(full).toBe(0)
  })

  it('orients edge normals by the neighbour heights, so light matches across chunk seams', () => {
    const slope = (i: number, j: number) => 0.4 * i + 0.1 * j * j
    const left = chunk(3, (a, b) => slope(a, b))
    const right = chunk(3, (a, b) => slope(a + 2, b), 1, 0)
    const outside = (i: number, j: number) => slope(i, j)
    const a = chunkMesh(left, { heightRange: RANGE, heightOutside: outside })
    const b = chunkMesh(right, { heightRange: RANGE, heightOutside: outside })
    // Vertex (2, 1) of the left chunk is vertex (0, 1) of the right one.
    for (let c = 0; c < 3; c++) expect(a.normals[3 * 5 + c]).toBeCloseTo(b.normals[3 * 3 + c]!, 6)
  })
})

describe('chunkLevel', () => {
  it('uses full resolution near and the coarse level beyond the far distance', () => {
    expect(chunkLevel(0)).toBe(0)
    expect(chunkLevel(LOD_FAR_M - 1)).toBe(0)
    expect(chunkLevel(LOD_FAR_M + LOD_HYSTERESIS_M + 1)).toBe(1)
  })

  it('holds its current level inside the hysteresis band', () => {
    const inBand = LOD_FAR_M + LOD_HYSTERESIS_M / 2
    expect(chunkLevel(inBand, 0)).toBe(0)
    expect(chunkLevel(inBand, 1)).toBe(1)
  })
})

describe('chunkDistance', () => {
  it('is zero inside the chunk and the gap to its nearest edge outside', () => {
    const c = { cx: 1, cy: 0, vertexCount: 65, cellSize: 1 }
    expect(chunkDistance(c, { x: 70, y: 10 })).toBe(0)
    expect(chunkDistance(c, { x: 60, y: 10 })).toBe(4)
    expect(chunkDistance(c, { x: 60, y: -3 })).toBe(5)
  })
})

describe('chunksFromGrid', () => {
  it('cuts a stitched grid back into chunks sharing their edge vertices, skipping missing ones', () => {
    // 2×2 chunks of 3 vertices, the top-right chunk missing (NaN), origin at chunk (-1, 4).
    const width = 5
    const heights = new Float32Array(25).map((_, k) => k)
    for (const k of [18, 19, 23, 24]) heights[k] = Number.NaN
    const cut = chunksFromGrid({ heights, width, height: 5, cellSize: 1 }, { i: -2, j: 8 }, 3)
    expect(cut.map(({ chunk }) => [chunk.cx, chunk.cy])).toEqual([
      [-1, 4],
      [0, 4],
      [-1, 5],
    ])
    const right = cut[1]!.chunk
    expect(Array.from(right.heights.subarray(0, 3))).toEqual([2, 3, 4])
    expect(right.heights[3]).toBe(7)
  })

  it('refuses a grid whose origin is not on a chunk corner', () => {
    const grid = { heights: new Float32Array(9), width: 3, height: 3, cellSize: 1 }
    expect(() => chunksFromGrid(grid, { i: 1, j: 0 }, 3)).toThrow(/origin/)
  })
})

describe('chunkRect', () => {
  it('is the disk-grid rectangle of the chunk vertices', () => {
    const c = chunk(5, () => 0, 1, 2)
    expect(chunkRect(c, { width: 20, origin: { i: -4, j: 0 } })).toEqual({
      i0: 8,
      j0: 8,
      i1: 13,
      j1: 13,
    })
  })
})

describe('fog on chunks', () => {
  // One 9-vertex chunk at (1, 0) inside a 17 × 9 disk grid at world vertex (0, 0).
  const layout = { width: 17, origin: { i: 0, j: 0 } }
  const c = chunk(9, (a, b) => 0.2 * (a + 8) + 0.05 * b * b, 1, 0)
  const disk = (() => {
    const heights = new Float32Array(17 * 9)
    for (let j = 0; j < 9; j++)
      for (let i = 0; i < 17; i++) heights[j * 17 + i] = 0.2 * i + 0.05 * j * j
    return { heights, width: 17, height: 9, cellSize: 1 }
  })()
  const westOnly = new Uint8Array(17 * 9)
  for (let j = 0; j < 9; j++) for (let i = 0; i < 4; i++) westOnly[j * 17 + i] = 1

  it('knows a chunk is wholly fogged until a reveal touches it', () => {
    const surface = fogSurface(disk, { seen: westOnly })
    expect(chunkFogged(c, { surface, layout })).toBe(true)
    const lifted = westOnly.slice()
    lifted[4 * 17 + 12] = 1
    expect(chunkFogged(c, { surface: fogSurface(disk, { seen: lifted }), layout })).toBe(false)
    expect(FOG_STEP).toBeGreaterThan(4)
  })

  it('refogs positions and colours in place to match a fresh build, at every level and the skirt', () => {
    const lifted = westOnly.slice()
    for (const [i, j] of [
      [8, 0],
      [12, 4],
      [16, 8],
      [9, 1],
      [13, 5],
    ] as const)
      lifted[j * 17 + i] = 1
    const revealedAt = revealTimes(westOnly)
    updateRevealTimes(revealedAt, lifted, 100, 17)
    const before = fogSurface(disk, { seen: westOnly })
    for (const now of [100 + 300, 100 + 600]) {
      const after = fogSurface(disk, { seen: lifted, revealedAt, now })
      for (const step of [1, 4, 8]) {
        const options = { heightRange: RANGE, step, skirtM: 3 }
        const fog = { layout }
        const mesh = chunkMesh(c, { ...options, fog: { ...fog, surface: before } })
        refogChunkMesh(mesh, c, { ...options, fog: { ...fog, surface: after } })
        const fresh = chunkMesh(c, { ...options, fog: { ...fog, surface: after } })
        expect(Array.from(mesh.positions)).toEqual(Array.from(fresh.positions))
        expect(Array.from(mesh.colors)).toEqual(Array.from(fresh.colors))
        expect(Array.from(mesh.normals)).toEqual(Array.from(fresh.normals))
        expect(Array.from(mesh.fogAmounts)).toEqual(Array.from(fresh.fogAmounts))
      }
    }
    // Once the fade is over, a revealed vertex sits on its true height.
    const done = fogSurface(disk, { seen: lifted, revealedAt, now: 100 + 600 })
    const mesh = chunkMesh(c, {
      heightRange: RANGE,
      fog: { surface: done, layout },
    })
    expect(mesh.positions[3 * (4 * 9 + 4) + 2]).toBe(c.heights[4 * 9 + 4])
  })

  const everywhere = new Uint8Array(17 * 9).fill(1)
  const flat = chunk(3, () => 5, 1, 0)
  const flatLayout = { width: 5, origin: { i: 0, j: 0 } }
  const flatDisk = { heights: new Float32Array(15).fill(5), width: 5, height: 3, cellSize: 1 }

  it('tints revealed ground in sight by the relief ramp and out of it by the seen ramp', () => {
    const surface = fogSurface(flatDisk, { seen: new Uint8Array(15).fill(1) })
    // In sight: the chunk's west column (disk column 2).
    const sight = new Uint8Array(15)
    for (let j = 0; j < 3; j++) sight[j * 5 + 2] = 1
    const mesh = chunkMesh(flat, {
      heightRange: RANGE,
      fog: { surface, layout: flatLayout, sight },
    })
    const linear = (inSight: boolean) => groundRgb(0.5, inSight).map(srgbToLinear)
    for (let k = 0; k < 9; k++) {
      const expected = linear(k % 3 === 0)
      for (let ch = 0; ch < 3; ch++) expect(mesh.colors[3 * k + ch]).toBeCloseTo(expected[ch]!, 6)
    }
    expect(linear(true)).not.toEqual(linear(false))
  })

  it('recolours in place to a fresh build for a new sight, heights, normals and fog untouched', () => {
    const surface = fogSurface(disk, { seen: everywhere })
    const before = new Uint8Array(17 * 9)
    const after = new Uint8Array(17 * 9)
    for (let j = 0; j < 9; j++) for (let i = 10; i < 17; i++) after[j * 17 + i] = 1
    for (const step of [1, 4, 8]) {
      const options = { heightRange: RANGE, step, skirtM: 3 }
      const fog = { surface, layout }
      const mesh = chunkMesh(c, { ...options, fog: { ...fog, sight: before } })
      const positions = mesh.positions.slice()
      const normals = mesh.normals.slice()
      const fogAmounts = mesh.fogAmounts.slice()
      const colors = mesh.colors.slice()
      recolourChunkMesh(mesh, c, { ...options, fog: { ...fog, sight: after } })
      const fresh = chunkMesh(c, { ...options, fog: { ...fog, sight: after } })
      expect(Array.from(mesh.colors)).toEqual(Array.from(fresh.colors))
      expect(Array.from(mesh.colors)).not.toEqual(Array.from(colors))
      expect(mesh.positions).toEqual(positions)
      expect(mesh.normals).toEqual(normals)
      expect(mesh.fogAmounts).toEqual(fogAmounts)
    }
  })
})
