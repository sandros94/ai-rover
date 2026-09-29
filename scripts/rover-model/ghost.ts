import { MeshoptSimplifier } from 'meshoptimizer'
import { silhouettes, viewBasis } from './silhouette'

type Vec3 = [number, number, number]

/** An indexed triangle mesh, positions only. */
export interface Shape {
  positions: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
}

export const triangleCount = (shape: Shape): number => shape.indices.length / 3

/** Shapes as one. */
export function merge(shapes: Shape[]): Shape {
  const positions: number[] = []
  const indices: number[] = []
  for (const shape of shapes) {
    const base = positions.length / 3
    positions.push(...shape.positions)
    for (const i of shape.indices) indices.push(base + i)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/** A shape's triangles, flat. */
export function flatten(shape: Shape): Float32Array<ArrayBuffer> {
  const out = new Float32Array(shape.indices.length * 3)
  shape.indices.forEach((v, k) => out.set(shape.positions.subarray(3 * v, 3 * v + 3), 3 * k))
  return out
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a))

/** Two unit vectors square to `axis` and to each other. */
function across(axis: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalize(cross(axis, helper))
  return [u, cross(axis, u)]
}

/** A box about `centre` with half extents `half` along the unit `axes`: 12 triangles. */
export function box(centre: Vec3, axes: [Vec3, Vec3, Vec3], half: Vec3): Shape {
  const positions: number[] = []
  for (let c = 0; c < 8; c++) {
    let p = centre
    for (let k = 0; k < 3; k++) p = add(p, scale(axes[k]!, (c >> k) & 1 ? half[k]! : -half[k]!))
    positions.push(...p)
  }
  // Each face's corners, counter-clockwise seen from outside for a right-handed frame.
  const faces = [
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ]
  const handed = dot(cross(axes[0], axes[1]), axes[2]) > 0
  const indices: number[] = []
  for (const [a, b, c, d] of faces) {
    const quad = handed ? [a!, b!, c!, a!, c!, d!] : [a!, c!, b!, a!, d!, c!]
    indices.push(...quad)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/**
 * A prism of `segments` sides about `axis` through `centre`, from `from` to `to` along the axis:
 * its side, and the ends asked for as flat polygons. `inner` makes it a tube whose ends are
 * rings, drawn only where asked.
 */
export function cylinder(options: {
  centre: Vec3
  axis: Vec3
  radius: number
  from: number
  to: number
  segments: number
  ends?: { from?: boolean; to?: boolean }
  inner?: number
}): Shape {
  const { centre, radius, from, to, segments, ends = { from: true, to: true }, inner } = options
  const axis = normalize(options.axis)
  const [u, v] = across(axis)
  const positions: number[] = []
  const ring = (r: number, along: number) => {
    const first = positions.length / 3
    for (let s = 0; s < segments; s++) {
      const a = (2 * Math.PI * s) / segments
      positions.push(
        ...add(
          add(centre, scale(axis, along)),
          add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))),
        ),
      )
    }
    return first
  }
  const a = ring(radius, from)
  const b = ring(radius, to)
  const indices: number[] = []
  const next = (s: number) => (s + 1) % segments
  for (let s = 0; s < segments; s++) {
    indices.push(a + s, a + next(s), b + next(s), a + s, b + next(s), b + s)
  }
  const cap = (outer: number, along: number, facing: 1 | -1) => {
    if (inner) {
      const i = ring(inner, along)
      for (let s = 0; s < segments; s++) {
        const quad = [outer + s, i + s, i + next(s), outer + s, i + next(s), outer + next(s)]
        indices.push(
          ...(facing < 0 ? quad : [quad[0]!, quad[2]!, quad[1]!, quad[3]!, quad[5]!, quad[4]!]),
        )
      }
      return
    }
    for (let s = 1; s + 1 < segments; s++) {
      indices.push(
        ...(facing > 0 ? [outer, outer + s, outer + s + 1] : [outer, outer + s + 1, outer + s]),
      )
    }
  }
  if (ends.from) cap(a, from, -1)
  if (ends.to) cap(b, to, 1)
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/** A flat polygon of `segments` sides about `centre`, facing along `normal`. */
export function disc(centre: Vec3, normal: Vec3, radius: number, segments: number): Shape {
  const [u, v] = across(normalize(normal))
  const positions: number[] = []
  for (let s = 0; s < segments; s++) {
    const a = (2 * Math.PI * s) / segments
    positions.push(
      ...add(centre, add(scale(u, radius * Math.cos(a)), scale(v, radius * Math.sin(a)))),
    )
  }
  const indices: number[] = []
  for (let s = 1; s + 1 < segments; s++) indices.push(0, s, s + 1)
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/**
 * The radius of a regular polygon of `segments` sides with the area of a circle of `radius`:
 * the polygon's silhouette covers what the circle's does, on average over its edge.
 */
export const equalArea = (radius: number, segments: number): number =>
  radius * Math.sqrt((2 * Math.PI) / (segments * Math.sin((2 * Math.PI) / segments)))

/**
 * The box around flat triangles' area along axes of their own: the principal axes of their
 * surface (area-weighted), or `axes` when given.
 */
export function orientedBox(triangles: ArrayLike<number>, axes?: [Vec3, Vec3, Vec3]): Shape {
  const frame = axes ?? principalAxes(triangles)
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < triangles.length; i += 3) {
    const p: Vec3 = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!]
    for (let k = 0; k < 3; k++) {
      const d = dot(p, frame[k]!)
      lo[k] = Math.min(lo[k]!, d)
      hi[k] = Math.max(hi[k]!, d)
    }
  }
  let centre: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) centre = add(centre, scale(frame[k]!, (lo[k]! + hi[k]!) / 2))
  return box(centre, frame, [0, 1, 2].map((k) => (hi[k]! - lo[k]!) / 2) as Vec3)
}

/** The principal axes of flat triangles' surface, largest spread first. */
export function principalAxes(triangles: ArrayLike<number>): [Vec3, Vec3, Vec3] {
  let area = 0
  let mean: Vec3 = [0, 0, 0]
  const tri = (t: number): [Vec3, Vec3, Vec3] =>
    [0, 1, 2].map((k) => [
      triangles[t + 3 * k]!,
      triangles[t + 3 * k + 1]!,
      triangles[t + 3 * k + 2]!,
    ]) as [Vec3, Vec3, Vec3]
  const areas: number[] = []
  for (let t = 0; t < triangles.length; t += 9) {
    const [a, b, c] = tri(t)
    const w =
      Math.hypot(
        ...cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]),
      ) / 2
    areas.push(w)
    area += w
    mean = add(mean, scale(add(add(a, b), c), w / 3))
  }
  mean = scale(mean, 1 / (area || 1))
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let t = 0, n = 0; t < triangles.length; t += 9, n++) {
    for (const p of tri(t)) {
      const d = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]]
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) cov[3 * i + j]! += (areas[n]! * d[i]! * d[j]!) / 3
    }
  }
  return jacobiAxes(cov)
}

/** Eigenvectors of a symmetric 3×3 matrix by Jacobi rotations, largest eigenvalue first. */
function jacobiAxes(m: number[]): [Vec3, Vec3, Vec3] {
  const a = [...m]
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  for (let sweep = 0; sweep < 50; sweep++) {
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[3 * p + q]!
      if (Math.abs(apq) < 1e-15) continue
      const theta = (a[3 * q + q]! - a[3 * p + p]!) / (2 * apq)
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[3 * k + p]!
        const akq = a[3 * k + q]!
        a[3 * k + p] = c * akp - s * akq
        a[3 * k + q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[3 * p + k]!
        const aqk = a[3 * q + k]!
        a[3 * p + k] = c * apk - s * aqk
        a[3 * q + k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[3 * k + p]!
        const vkq = v[3 * k + q]!
        v[3 * k + p] = c * vkp - s * vkq
        v[3 * k + q] = s * vkp + c * vkq
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[4 * j]! - a[4 * i]!)
  const col = (i: number): Vec3 => [v[i]!, v[3 + i]!, v[6 + i]!]
  const [x, y] = [col(order[0]!), col(order[1]!)]
  return [x, y, cross(x, y)]
}

/**
 * The closed surface of the cubes of `cell` metres that flat triangles cross or enclose: every
 * cube a triangle passes through is marked, every one the outside cannot reach is solid, and each
 * face between a solid cube and the outside is a quad facing out. Unlike the source's open,
 * overlapping pieces, a closed surface collapses freely under simplification. It lies up to a
 * cell outside the triangles, half a cell on average.
 */
export function voxelSurface(triangles: ArrayLike<number>, cell: number): Shape {
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < triangles.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, triangles[i + k]!)
      hi[k] = Math.max(hi[k]!, triangles[i + k]!)
    }
  }
  // One empty cell all round, so the outside is connected.
  const origin = lo.map((x) => x - cell) as Vec3
  const [nx, ny, nz] = [0, 1, 2].map((k) => Math.ceil((hi[k]! - lo[k]!) / cell) + 3) as Vec3
  const at = (x: number, y: number, z: number) => x + nx * (y + ny * z)
  const grid = new Uint8Array(nx * ny * nz)
  const mark = (p: Vec3) => {
    const [x, y, z] = [0, 1, 2].map((k) => Math.floor((p[k]! - origin[k]!) / cell))
    grid[at(x!, y!, z!)] = 1
  }
  for (let t = 0; t < triangles.length; t += 9) {
    const a: Vec3 = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!]
    const b: Vec3 = [triangles[t + 3]!, triangles[t + 4]!, triangles[t + 5]!]
    const c: Vec3 = [triangles[t + 6]!, triangles[t + 7]!, triangles[t + 8]!]
    const edge = Math.max(
      Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
      Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]),
      Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]),
    )
    // Samples closer than half a cell: no cell a triangle crosses is missed.
    const n = Math.max(1, Math.ceil((2 * edge) / cell))
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const [s, r] = [i / n, j / n]
        mark([0, 1, 2].map((k) => a[k]! + s * (b[k]! - a[k]!) + r * (c[k]! - a[k]!)) as Vec3)
      }
    }
  }
  // The outside: every empty cell reachable from the corner. The rest is solid.
  const outside = new Uint8Array(grid.length)
  const queue = new Int32Array(grid.length)
  let head = 0
  let tail = 0
  outside[0] = 1
  queue[tail++] = 0
  const steps = [1, -1, nx, -nx, nx * ny, -nx * ny]
  while (head < tail) {
    const i = queue[head++]!
    const x = i % nx
    const y = Math.floor(i / nx) % ny
    const z = Math.floor(i / (nx * ny))
    for (let s = 0; s < 6; s++) {
      if ((s === 0 && x === nx - 1) || (s === 1 && x === 0)) continue
      if ((s === 2 && y === ny - 1) || (s === 3 && y === 0)) continue
      if ((s === 4 && z === nz - 1) || (s === 5 && z === 0)) continue
      const j = i + steps[s]!
      if (outside[j] || grid[j]) continue
      outside[j] = 1
      queue[tail++] = j
    }
  }
  // A quad on each face between a solid cell and the outside, facing out.
  const corners = new Map<number, number>()
  const positions: number[] = []
  const corner = (x: number, y: number, z: number) => {
    const key = x + (nx + 1) * (y + (ny + 1) * z)
    let v = corners.get(key)
    if (v === undefined) {
      v = positions.length / 3
      corners.set(key, v)
      positions.push(origin[0] + x * cell, origin[1] + y * cell, origin[2] + z * cell)
    }
    return v
  }
  const indices: number[] = []
  const quad = (p: number[][]) => {
    const [a, b, c, d] = p.map(([x, y, z]) => corner(x!, y!, z!))
    indices.push(a!, b!, c!, a!, c!, d!)
  }
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = at(x, y, z)
        if (outside[i]) continue
        if (outside[i + 1])
          quad([
            [x + 1, y, z],
            [x + 1, y + 1, z],
            [x + 1, y + 1, z + 1],
            [x + 1, y, z + 1],
          ])
        if (outside[i - 1])
          quad([
            [x, y, z],
            [x, y, z + 1],
            [x, y + 1, z + 1],
            [x, y + 1, z],
          ])
        if (outside[i + nx])
          quad([
            [x, y + 1, z],
            [x, y + 1, z + 1],
            [x + 1, y + 1, z + 1],
            [x + 1, y + 1, z],
          ])
        if (outside[i - nx])
          quad([
            [x, y, z],
            [x + 1, y, z],
            [x + 1, y, z + 1],
            [x, y, z + 1],
          ])
        if (outside[i + nx * ny])
          quad([
            [x, y, z + 1],
            [x + 1, y, z + 1],
            [x + 1, y + 1, z + 1],
            [x, y + 1, z + 1],
          ])
        if (outside[i - nx * ny])
          quad([
            [x, y, z],
            [x, y + 1, z],
            [x + 1, y + 1, z],
            [x + 1, y, z],
          ])
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/** A shape simplified by meshopt to about `target` triangles, whatever the error. */
export async function simplify(shape: Shape, target: number): Promise<Shape> {
  if (triangleCount(shape) <= target) return shape
  await MeshoptSimplifier.ready
  const [out] = MeshoptSimplifier.simplify(shape.indices, shape.positions, 3, target * 3, 1, [
    'Prune',
  ])
  return compact(shape.positions, out)
}

/** Only the vertices `indices` uses, renumbered in first-use order. */
export function compact(positions: Float32Array, indices: Uint32Array): Shape {
  const remap = new Int32Array(positions.length / 3).fill(-1)
  const kept: number[] = []
  const out = new Uint32Array(indices.length)
  indices.forEach((vertex, k) => {
    if (remap[vertex] === -1) {
      remap[vertex] = kept.length / 3
      kept.push(...positions.subarray(3 * vertex, 3 * vertex + 3))
    }
    out[k] = remap[vertex]!
  })
  return { positions: Float32Array.from(kept), indices: out }
}

/**
 * A wheel fitted to its triangles, turning about `axis`, with its outboard face towards
 * `outboard` along it: the tread as a prism of `segments` sides with the rim's outboard edge as a
 * ring, and the hub as a flat polygon on that face; the spokes between them are left out. The
 * radii come from the wheel's own silhouette along its axis: where its coverage, ring by ring,
 * crosses a half.
 */
export function wheel(
  triangles: ArrayLike<number>,
  options: { axis: Vec3; outboard: 1 | -1; segments: number; hubSegments: number },
): Shape {
  const axis = normalize(options.axis)
  const [u, v] = viewBasis(axis)
  const bounds = { u: [Infinity, -Infinity], v: [Infinity, -Infinity], a: [Infinity, -Infinity] }
  for (let i = 0; i < triangles.length; i += 3) {
    const p: Vec3 = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!]
    for (const [key, dir] of [
      ['u', u],
      ['v', v],
      ['a', axis],
    ] as const) {
      const d = dot(p, dir)
      bounds[key][0] = Math.min(bounds[key][0]!, d)
      bounds[key][1] = Math.max(bounds[key][1]!, d)
    }
  }
  const mid = (k: 'u' | 'v') => (bounds[k][0]! + bounds[k][1]!) / 2
  const mask = silhouettes(triangles, triangles, axis, 512)
  // Coverage in rings of 2.5 mm about the centre.
  const ring = 0.0025
  const rings = Math.ceil(Math.max(bounds.u[1]! - bounds.u[0]!, bounds.v[1]! - bounds.v[0]!) / ring)
  const covered = new Float64Array(rings)
  const total = new Float64Array(rings)
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const pu = mask.minU + (x + 0.5) * mask.pixel - mid('u')
      const pv = mask.minV + (y + 0.5) * mask.pixel - mid('v')
      const r = Math.floor(Math.hypot(pu, pv) / ring)
      if (r >= rings) continue
      total[r]! += 1
      covered[r]! += mask.a[y * mask.width + x]!
    }
  }
  const full = (r: number) => total[r]! > 0 && covered[r]! / total[r]! >= 0.5
  let hub = 0
  while (hub < rings && full(hub)) hub++
  let outer = rings - 1
  while (outer > 0 && !full(outer)) outer--
  let inner = outer
  while (inner > hub && full(inner)) inner--
  const radius = { hub: hub * ring, inner: (inner + 1) * ring, outer: (outer + 1) * ring }
  // The axis of this basis (u × v) is the wheel's axis, so its centre is the box's middle.
  const centre = add(scale(u, mid('u')), scale(v, mid('v')))
  const [from, to] = bounds.a as [number, number]
  const face = options.outboard > 0 ? to : from
  const tread = cylinder({
    centre,
    axis: scale(axis, options.outboard),
    radius: equalArea(radius.outer, options.segments),
    inner: equalArea(radius.inner, options.segments),
    from: options.outboard > 0 ? from : -to,
    to: options.outboard > 0 ? to : -from,
    segments: options.segments,
    ends: { to: true },
  })
  const hubDisc = disc(
    add(centre, scale(axis, face)),
    scale(axis, options.outboard),
    equalArea(radius.hub, options.hubSegments),
    options.hubSegments,
  )
  return merge([tread, hubDisc])
}

/** Flat triangles as an indexed shape, vertices at the same position shared. */
export function weld(triangles: ArrayLike<number>): Shape {
  const byPosition = new Map<string, number>()
  const positions: number[] = []
  const indices = new Uint32Array(triangles.length / 3)
  for (let v = 0; v < indices.length; v++) {
    const key = `${triangles[3 * v]},${triangles[3 * v + 1]},${triangles[3 * v + 2]}`
    let kept = byPosition.get(key)
    if (kept === undefined) {
      kept = positions.length / 3
      byPosition.set(key, kept)
      positions.push(triangles[3 * v]!, triangles[3 * v + 1]!, triangles[3 * v + 2]!)
    }
    indices[v] = kept
  }
  return { positions: Float32Array.from(positions), indices }
}
