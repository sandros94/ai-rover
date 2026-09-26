import { describe, expect, it } from 'vitest'
import { drapePath, groundDisc, ribbonMesh } from '#shared/utils/client/scene/overlays'

const vertex = (positions: Float32Array, k: number) =>
  Array.from(positions.subarray(3 * k, 3 * k + 3))

describe('drapePath', () => {
  it('adds points at most the spacing apart and sets each on the ground', () => {
    const path = drapePath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      (x) => x / 2,
      { spacingM: 3 },
    )
    expect(path).toHaveLength(5)
    for (let k = 1; k < path.length; k++) {
      expect(
        Math.hypot(path[k]!.x - path[k - 1]!.x, path[k]!.y - path[k - 1]!.y),
      ).toBeLessThanOrEqual(3)
    }
    for (const p of path) expect(p.z).toBeCloseTo(p.x / 2)
    expect(path.at(-1)).toEqual({ x: 10, y: 0, z: 5 })
  })

  it('carries the last known height across ground that is not loaded', () => {
    const path = drapePath(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
      (x) => (x < 2 ? 1 : undefined),
      { spacingM: 1 },
    )
    expect(path.map((p) => p.z)).toEqual([1, 1, 1, 1, 1])
  })
})

describe('ribbonMesh', () => {
  it('lays a strip of the given width across each point, relative to the first point', () => {
    const mesh = ribbonMesh(
      [
        { x: 100, y: 50, z: 2 },
        { x: 104, y: 50, z: 3 },
        { x: 104, y: 54, z: 3 },
      ],
      { widthM: 2, liftM: 0.1 },
    )
    expect(mesh.origin).toEqual({ x: 100, y: 50, z: 2 })
    expect(mesh.positions).toHaveLength(6 * 3)
    expect(mesh.indices).toHaveLength(2 * 6)
    // Heading east: left is north.
    expect(vertex(mesh.positions, 0)).toEqual([0, 1, expect.closeTo(0.1, 6)])
    expect(vertex(mesh.positions, 1)).toEqual([0, -1, expect.closeTo(0.1, 6)])
    // Heading north at the end: left is west.
    expect(vertex(mesh.positions, 4)).toEqual([3, 4, expect.closeTo(1.1, 6)])
  })

  it('draws two triangles per segment, counter-clockwise from above', () => {
    const mesh = ribbonMesh(
      [
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 1, z: 0 },
        { x: 5, y: 4, z: 0 },
      ],
      { widthM: 1, liftM: 0 },
    )
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [p, q, r] = [0, 1, 2].map((o) => vertex(mesh.positions, mesh.indices[t + o]!))
      const cross = (q![0]! - p![0]!) * (r![1]! - p![1]!) - (q![1]! - p![1]!) * (r![0]! - p![0]!)
      expect(cross).toBeGreaterThan(0)
    }
  })

  it('is empty below two points', () => {
    const mesh = ribbonMesh([{ x: 1, y: 2, z: 3 }], { widthM: 1, liftM: 0 })
    expect(mesh.indices).toHaveLength(0)
  })
})

describe('groundDisc', () => {
  it('fans a disc around the centre with every rim vertex on the ground', () => {
    const disc = groundDisc({ x: 10, y: 20 }, (x, y) => x + y, {
      radiusM: 2,
      segments: 8,
      liftM: 0,
    })
    expect(disc.origin).toEqual({ x: 10, y: 20, z: 30 })
    expect(disc.positions).toHaveLength((1 + 8) * 3)
    expect(disc.indices).toHaveLength(8 * 3)
    for (let k = 1; k <= 8; k++) {
      const [x, y, z] = vertex(disc.positions, k)
      expect(Math.hypot(x!, y!)).toBeCloseTo(2, 5)
      expect(z).toBeCloseTo(x! + y!, 5)
    }
  })
})
