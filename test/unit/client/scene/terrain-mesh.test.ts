import { describe, expect, it } from 'vitest'
import {
  chunkDistance,
  chunkLevel,
  chunkMesh,
  chunksFromGrid,
  fogDelta,
  LOD_FAR_M,
  LOD_HYSTERESIS_M,
  recolourChunkMesh,
} from '#shared/utils/client/scene/terrain-mesh'
import { reliefLight, reliefRgb, srgbToLinear } from '#shared/utils/client/scene/palette'

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

  it('colours by the relief ramp and light in linear space, as the 2D map does in sRGB', () => {
    const mesh = chunkMesh(
      chunk(3, () => 5),
      { heightRange: RANGE },
    )
    const light = reliefLight(Math.sin(Math.PI / 4))
    const expected = reliefRgb(0.5).map((c) => srgbToLinear(c * light))
    for (let k = 0; k < 9; k++) {
      for (let c = 0; c < 3; c++) expect(mesh.colors[3 * k + c]).toBeCloseTo(expected[c]!, 5)
    }
  })

  it('dims unseen vertices', () => {
    const seen = new Uint8Array(9).fill(1)
    seen[4] = 0
    const mesh = chunkMesh(
      chunk(3, () => 5),
      { heightRange: RANGE, seen },
    )
    const sum = (k: number) =>
      mesh.colors[3 * k]! + mesh.colors[3 * k + 1]! + mesh.colors[3 * k + 2]!
    expect(sum(4)).toBeLessThan(sum(0) * 0.5)
  })

  it('shades edge vertices from the neighbour heights, so seams match across chunks', () => {
    const slope = (i: number, j: number) => 0.4 * i + 0.1 * j * j
    const left = chunk(3, (a, b) => slope(a, b))
    const right = chunk(3, (a, b) => slope(a + 2, b), 1, 0)
    const outside = (i: number, j: number) => slope(i, j)
    const a = chunkMesh(left, { heightRange: RANGE, heightOutside: outside })
    const b = chunkMesh(right, { heightRange: RANGE, heightOutside: outside })
    // Vertex (2, 1) of the left chunk is vertex (0, 1) of the right one.
    for (let c = 0; c < 3; c++) expect(a.colors[3 * 5 + c]).toBeCloseTo(b.colors[3 * 3 + c]!, 6)
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
    const seen = new Uint8Array(25).fill(1)
    const cut = chunksFromGrid({ heights, width, height: 5, cellSize: 1 }, { i: -2, j: 8 }, 3, seen)
    expect(cut.map(({ chunk }) => [chunk.cx, chunk.cy])).toEqual([
      [-1, 4],
      [0, 4],
      [-1, 5],
    ])
    const right = cut[1]!.chunk
    expect(Array.from(right.heights.subarray(0, 3))).toEqual([2, 3, 4])
    expect(right.heights[3]).toBe(7)
    expect(cut[1]!.seen).toHaveLength(9)
  })

  it('refuses a grid whose origin is not on a chunk corner', () => {
    const grid = { heights: new Float32Array(9), width: 3, height: 3, cellSize: 1 }
    expect(() => chunksFromGrid(grid, { i: 1, j: 0 }, 3)).toThrow(/origin/)
  })
})

describe('fogDelta', () => {
  // Two 5-vertex chunks side by side, (0, 0) and (1, 0), stitched into a 9 × 5 disk grid at
  // world vertex (0, 0): disk index j · 9 + i. Vertex i = 4 is the shared edge.
  const layout = { width: 9, origin: { i: 0, j: 0 } }
  const flat = (cx: number) => chunk(5, (a, b) => 0.3 * (a + 4 * cx) + 0.1 * b, cx, 0)
  const unseen = () => new Uint8Array(25)
  const pair = () => [
    { chunk: flat(0), base: unseen() },
    { chunk: flat(1), base: unseen() },
  ]

  it('lifts revealed vertices in every chunk holding them, the shared edge in both', () => {
    // (1, 1) lies in the left chunk only; (4, 2) on the edge both chunks store.
    const changes = fogDelta(pair(), [{ vertices: [1 * 9 + 1] }, { vertices: [2 * 9 + 4] }], layout)
    expect(changes.map((c) => c.key)).toEqual(['0,0', '1,0'])
    expect(changes[0]!.vertices.toSorted((a, b) => a - b)).toEqual([6, 14])
    expect(changes[1]!.vertices).toEqual([10])
    expect(changes[0]!.seen[6]).toBe(1)
    expect(changes[1]!.seen[10]).toBe(1)
    expect(changes[1]!.seen.reduce((n, v) => n + v, 0)).toBe(1)
  })

  it('reports only what differs from the shown fog, and re-fogs after a seek back', () => {
    const chunks = pair()
    const first = fogDelta(chunks, [{ vertices: [1 * 9 + 1] }], layout)
    const shown = chunks.map((c, k) => ({
      ...c,
      shown: first.find((f) => f.key === `${k},0`)?.seen,
    }))
    expect(fogDelta(shown, [{ vertices: [1 * 9 + 1] }], layout)).toEqual([])
    const back = fogDelta(shown, [], layout)
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ key: '0,0', vertices: [6] })
    expect(back[0]!.seen[6]).toBe(0)
  })

  it('leaves chunks without fog and indices outside every chunk alone', () => {
    const chunks = [{ chunk: flat(0) }, { chunk: flat(1), base: unseen() }]
    expect(fogDelta(chunks, [{ vertices: [1 * 9 + 1, 9 * 5 + 3] }], layout)).toEqual([])
  })
})

describe('recolourChunkMesh', () => {
  it('matches a mesh built with the new fog, at both levels and on the skirt', () => {
    const c = chunk(9, (a, b) => 0.2 * a + 0.05 * b * b)
    const before = new Uint8Array(81)
    const after = before.slice()
    const lifted = [0, 4, 40, 44, 80, 13]
    for (const k of lifted) after[k] = 1
    for (const step of [1, 4]) {
      const options = { heightRange: RANGE, step, skirtM: 3 }
      const mesh = chunkMesh(c, { ...options, seen: before })
      recolourChunkMesh(mesh, c, { ...options, seen: after, vertices: lifted })
      const fresh = chunkMesh(c, { ...options, seen: after })
      expect(Array.from(mesh.colors)).toEqual(Array.from(fresh.colors))
    }
  })
})
