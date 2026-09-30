import { silhouettes, viewBasis } from './silhouette'

export type Vec3 = [number, number, number]
type Vec2 = [number, number]

/** The points `p` with `n·p ≤ d`, `n` of unit length. */
export interface Plane {
  n: Vec3
  d: number
}

/** A closed polyhedron: its corners, and its faces as loops of them, anticlockwise from outside. */
export interface Solid {
  vertices: Vec3[]
  faces: number[][]
}

/**
 * A primitive of the low-poly rover: its solid, and the region it fills for comparing volumes:
 * inside every plane of `planes`, and outside the convex `hole` when there is one (a tube's).
 */
export interface Primitive {
  solid: Solid
  planes: Plane[]
  hole?: Plane[]
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a))

/** Triangles a solid is drawn with: a fan per face. */
export const triangleCount = (solid: Solid): number =>
  solid.faces.reduce((s, f) => s + f.length - 2, 0)

/** A solid's triangles, flat (nine numbers each). */
export function trianglesOf(solid: Solid): Float32Array<ArrayBuffer> {
  const out: number[] = []
  for (const face of solid.faces) {
    for (let k = 1; k + 1 < face.length; k++) {
      for (const v of [face[0]!, face[k]!, face[k + 1]!]) out.push(...solid.vertices[v]!)
    }
  }
  return Float32Array.from(out)
}

/**
 * Solids as one indexed mesh with flat normals: each face its own corners, carrying its normal,
 * so a face shades flat and neighbouring faces share no vertex across their edge.
 */
export function meshOf(solids: Solid[]): {
  positions: Float32Array<ArrayBuffer>
  normals: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
} {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (const solid of solids) {
    for (const face of solid.faces) {
      const corners = face.map((v) => solid.vertices[v]!)
      const n = faceNormal(corners)
      const base = positions.length / 3
      for (const p of corners) {
        positions.push(...p)
        normals.push(...n)
      }
      for (let k = 1; k + 1 < face.length; k++) indices.push(base, base + k, base + k + 1)
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
  }
}

/** A polygon's unit normal by Newell's method, the side it winds anticlockwise about. */
function faceNormal(corners: Vec3[]): Vec3 {
  let n: Vec3 = [0, 0, 0]
  corners.forEach((a, k) => (n = add(n, cross(a, corners[(k + 1) % corners.length]!))))
  return normalize(n)
}

/** A solid carried by a rigid map: rotation `r` (row-major) then translation `t`. */
export function moved(solid: Solid, r: number[], t: Vec3): Solid {
  const vertices = solid.vertices.map((p): Vec3 => [
    r[0]! * p[0] + r[1]! * p[1] + r[2]! * p[2] + t[0],
    r[3]! * p[0] + r[4]! * p[1] + r[5]! * p[2] + t[1],
    r[6]! * p[0] + r[7]! * p[1] + r[8]! * p[2] + t[2],
  ])
  return { vertices, faces: solid.faces }
}

/** Planes carried by a rigid map: rotation `r` (row-major) then translation `t`. */
export function movedPlanes(planes: Plane[], r: number[], t: Vec3): Plane[] {
  return planes.map(({ n, d }) => {
    const m: Vec3 = [
      r[0]! * n[0] + r[1]! * n[1] + r[2]! * n[2],
      r[3]! * n[0] + r[4]! * n[1] + r[5]! * n[2],
      r[6]! * n[0] + r[7]! * n[1] + r[8]! * n[2],
    ]
    return { n: m, d: d + dot(m, t) }
  })
}

/** Corners closer than this are one, metres. */
const SAME = 1e-6

/**
 * The convex solid the planes bound, or nothing when they bound none. Its corners are where three
 * planes meet inside all the others; a corner fewer than three faces share lies along an edge,
 * and is dropped, so faces meet edge to edge and every corner is shared exactly.
 */
export function convex(planes: Plane[]): Solid | undefined {
  const points: Vec3[] = []
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      for (let k = j + 1; k < planes.length; k++) {
        const [a, b, c] = [planes[i]!, planes[j]!, planes[k]!]
        const bc = cross(b.n, c.n)
        const det = dot(a.n, bc)
        if (Math.abs(det) < 1e-9) continue
        const p = scale(
          add(add(scale(bc, a.d), scale(cross(c.n, a.n), b.d)), scale(cross(a.n, b.n), c.d)),
          1 / det,
        )
        if (planes.some((q) => dot(q.n, p) > q.d + SAME)) continue
        if (points.some((q) => Math.hypot(...sub(p, q)) < SAME)) continue
        points.push(p)
      }
    }
  }
  if (points.length < 4) return undefined
  const on = planes.map((q) => points.flatMap((p, v) => (dot(q.n, p) > q.d - SAME ? [v] : [])))
  const uses = new Int32Array(points.length)
  const seen = new Set<string>()
  const loops: { plane: Plane; corners: number[] }[] = []
  planes.forEach((plane, k) => {
    const corners = on[k]!
    const key = [...corners].sort((a, b) => a - b).join()
    if (corners.length < 3 || seen.has(key)) return
    seen.add(key)
    loops.push({ plane, corners })
    for (const v of corners) uses[v]!++
  })
  const vertices: Vec3[] = []
  const renumber = new Int32Array(points.length).fill(-1)
  const faces: number[][] = []
  for (const { plane, corners } of loops) {
    const kept = corners.filter((v) => uses[v]! >= 3)
    if (kept.length < 3) continue
    const [u, w] = across(plane.n)
    const centre = scale(
      kept.reduce((s, v): Vec3 => add(s, points[v]!), [0, 0, 0]),
      1 / kept.length,
    )
    const angle = (v: number) => {
      const d = sub(points[v]!, centre)
      return Math.atan2(dot(d, w), dot(d, u))
    }
    kept.sort((a, b) => angle(a) - angle(b))
    faces.push(
      kept.map((v) => {
        if (renumber[v] === -1) {
          renumber[v] = vertices.length
          vertices.push(points[v]!)
        }
        return renumber[v]!
      }),
    )
  }
  return faces.length >= 4 ? { vertices, faces } : undefined
}

/** Two unit vectors square to `axis` and to each other, `u × v = axis`. */
function across(axis: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalize(cross(axis, helper))
  return [u, cross(axis, u)]
}

/** A right-handed frame: `w = u × v`. */
export interface Frame {
  u: Vec3
  v: Vec3
  w: Vec3
}

/**
 * The planes of a prism: the convex `outline` (anticlockwise in `u`, `v` coordinates of `frame`)
 * extruded along `w` from `from` to `to`.
 */
export function prism(frame: Frame, outline: Vec2[], from: number, to: number): Plane[] {
  const { u, v, w } = frame
  const planes: Plane[] = [
    { n: w, d: to },
    { n: scale(w, -1), d: -from },
  ]
  outline.forEach((a, k) => {
    const b = outline[(k + 1) % outline.length]!
    const [eu, ev] = [b[0] - a[0], b[1] - a[1]]
    const length = Math.hypot(eu, ev)
    if (length < SAME) return
    const [nu, nv] = [ev / length, -eu / length]
    planes.push({ n: add(scale(u, nu), scale(v, nv)), d: nu * a[0] + nv * a[1] })
  })
  return planes
}

/** A regular polygon of `sides` about `centre`, one corner along the first axis. */
export function polygon(centre: Vec2, radius: number, sides: number): Vec2[] {
  return Array.from({ length: sides }, (_, s): Vec2 => {
    const a = (2 * Math.PI * s) / sides
    return [centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a)]
  })
}

/**
 * The radius of a regular polygon of `sides` with the area of a circle of `radius`: the
 * polygon's silhouette covers what the circle's does, on average over its edge.
 */
export const equalArea = (radius: number, sides: number): number =>
  radius * Math.sqrt((2 * Math.PI) / (sides * Math.sin((2 * Math.PI) / sides)))

/** The convex hull of points, anticlockwise, no three corners in line (monotone chain). */
export function hull(points: Vec2[]): Vec2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const turn = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: Vec2[]) => {
    const out: Vec2[] = []
    for (const p of list) {
      while (out.length >= 2 && turn(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop()
      out.push(p)
    }
    out.pop()
    return out
  }
  return sorted.length < 3 ? sorted : [...half(sorted), ...half([...sorted].reverse())]
}

/** A polygon's signed area, positive anticlockwise. */
export function area(outline: Vec2[]): number {
  let s = 0
  outline.forEach((a, k) => {
    const b = outline[(k + 1) % outline.length]!
    s += a[0] * b[1] - a[1] * b[0]
  })
  return s / 2
}

/**
 * A convex outline with at most `corners`, circumscribing it: the edge whose removal (its two
 * neighbours extended to meet) adds the least area goes first, while the neighbours still meet
 * ahead of it. Covers everything the outline covers.
 */
export function reduceOutline(outline: Vec2[], corners: number): Vec2[] {
  let out = [...outline]
  while (out.length > corners) {
    let best = -1
    let bestArea = Infinity
    let bestPoint: Vec2 = [0, 0]
    const n = out.length
    for (let k = 0; k < n; k++) {
      // Edge k runs from out[k] to out[k+1]; its neighbours are out[k-1]→out[k] and out[k+1]→out[k+2].
      const [p0, p1, p2, p3] = [
        out[(k - 1 + n) % n]!,
        out[k]!,
        out[(k + 1) % n]!,
        out[(k + 2) % n]!,
      ]
      const d1: Vec2 = [p1[0] - p0[0], p1[1] - p0[1]]
      const d2: Vec2 = [p2[0] - p3[0], p2[1] - p3[1]]
      const denom = d1[0] * d2[1] - d1[1] * d2[0]
      if (denom >= -1e-12) continue
      const s = ((p3[0] - p0[0]) * d2[1] - (p3[1] - p0[1]) * d2[0]) / denom
      if (s < 1) continue
      const q: Vec2 = [p0[0] + s * d1[0], p0[1] + s * d1[1]]
      const added = area([p1, q, p2])
      if (added < bestArea) [best, bestArea, bestPoint] = [k, added, q]
    }
    if (best < 0) break
    out = out.flatMap((p, i) => (i === best ? [bestPoint] : i === (best + 1) % n ? [] : [p]))
  }
  return out
}

/** The rectangle of least area around a convex outline, as the angle of its first side. */
export function leastRectangle(outline: Vec2[]): number {
  let best = 0
  let bestArea = Infinity
  outline.forEach((a, k) => {
    const b = outline[(k + 1) % outline.length]!
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0])
    const [c, s] = [Math.cos(angle), Math.sin(angle)]
    let [lu, hu, lv, hv] = [Infinity, -Infinity, Infinity, -Infinity]
    for (const p of outline) {
      const pu = c * p[0] + s * p[1]
      const pv = -s * p[0] + c * p[1]
      ;[lu, hu, lv, hv] = [Math.min(lu, pu), Math.max(hu, pu), Math.min(lv, pv), Math.max(hv, pv)]
    }
    const a2 = (hu - lu) * (hv - lv)
    if (a2 < bestArea) [best, bestArea] = [angle, a2]
  })
  return best
}

/**
 * The circle fitted to points by least squares on `x² + y² + a·x + b·y + c = 0` (Kåsa's
 * method), or nothing for points in line.
 */
export function fitCircle(points: Vec2[]): { centre: Vec2; radius: number } | undefined {
  let [sx, sy, sxx, syy, sxy, sxz, syz, sz] = [0, 0, 0, 0, 0, 0, 0, 0]
  for (const [x, y] of points) {
    const z = x * x + y * y
    sx += x
    sy += y
    sxx += x * x
    syy += y * y
    sxy += x * y
    sxz += x * z
    syz += y * z
    sz += z
  }
  const n = points.length
  // Normal equations for [a, b, c].
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ]
  const r = [-sxz, -syz, -sz]
  const det3 = (a: number[][]) =>
    a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) -
    a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) +
    a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!)
  const det = det3(m)
  if (Math.abs(det) < 1e-18) return undefined
  const solve = (k: number) =>
    det3(m.map((row, i) => row.map((x, j) => (j === k ? r[i]! : x)))) / det
  const [a, b, c] = [solve(0), solve(1), solve(2)]
  const centre: Vec2 = [-a / 2, -b / 2]
  const r2 = centre[0] ** 2 + centre[1] ** 2 - c
  return r2 > 0 ? { centre, radius: Math.sqrt(r2) } : undefined
}

/** The principal axes of flat triangles' surface (area-weighted), largest spread first. */
export function principalAxes(triangles: ArrayLike<number>): [Vec3, Vec3, Vec3] {
  let total = 0
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
    const w = Math.hypot(...cross(sub(b, a), sub(c, a))) / 2
    areas.push(w)
    total += w
    mean = add(mean, scale(add(add(a, b), c), w / 3))
  }
  mean = scale(mean, 1 / (total || 1))
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let t = 0, n = 0; t < triangles.length; t += 9, n++) {
    for (const p of tri(t)) {
      const d = sub(p, mean)
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
 * A wheel fitted to its triangles, turning about `axis`: the tread and rim as a closed tube of
 * `segments` sides, and the hub as a closed prism of `hubSegments` inside it, both the wheel's
 * width; the spokes between them are left out. The radii come from the wheel's own silhouette
 * along its axis: where its coverage, ring by ring, crosses a half.
 */
export function wheel(
  triangles: ArrayLike<number>,
  options: { axis: Vec3; segments: number; hubSegments: number },
): Primitive[] {
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
  let hubRing = 0
  while (hubRing < rings && full(hubRing)) hubRing++
  let outer = rings - 1
  while (outer > 0 && !full(outer)) outer--
  let inner = outer
  while (inner > hubRing && full(inner)) inner--
  const radius = { hub: hubRing * ring, inner: (inner + 1) * ring, outer: (outer + 1) * ring }
  // A view's basis has u × v against the look: the prisms run along it, the wheel's axis reversed.
  const frame: Frame = { u, v, w: cross(u, v) }
  const centre: Vec2 = [mid('u'), mid('v')]
  const [from, to] = [-bounds.a[1]!, -bounds.a[0]!]
  const rim = (r: number, sides: number) => polygon(centre, equalArea(r, sides), sides)
  const outside = rim(radius.outer, options.segments)
  const hole = rim(radius.inner, options.segments)
  const hub = prism(frame, rim(radius.hub, options.hubSegments), from, to)
  return [
    {
      solid: tube(frame, outside, hole, from, to),
      planes: prism(frame, outside, from, to),
      hole: prism(frame, hole, from, to).slice(2),
    },
    { solid: convex(hub)!, planes: hub },
  ]
}

/**
 * The closed tube between two convex outlines of as many corners (anticlockwise, the second
 * inside the first) extruded along `w` from `from` to `to`: outer and inner sides, and a ring of
 * quads at each end.
 */
function tube(frame: Frame, outside: Vec2[], hole: Vec2[], from: number, to: number): Solid {
  const { u, v, w } = frame
  const n = outside.length
  const vertices: Vec3[] = []
  const ring = (outline: Vec2[], along: number) => {
    const first = vertices.length
    for (const [pu, pv] of outline) {
      vertices.push(add(add(scale(u, pu), scale(v, pv)), scale(w, along)))
    }
    return first
  }
  const [o0, o1, i0, i1] = [
    ring(outside, from),
    ring(outside, to),
    ring(hole, from),
    ring(hole, to),
  ]
  const faces: number[][] = []
  for (let s = 0; s < n; s++) {
    const t = (s + 1) % n
    faces.push([o0 + s, o0 + t, o1 + t, o1 + s])
    faces.push([i0 + t, i0 + s, i1 + s, i1 + t])
    faces.push([o0 + t, o0 + s, i0 + s, i0 + t])
    faces.push([o1 + s, o1 + t, i1 + t, i1 + s])
  }
  return { vertices, faces }
}

/**
 * How sound a surface of flat triangles is, its vertices matched by exact position: `open`, the
 * edges not matched by as many uses the other way round (a hole's rim, or a face wound against
 * its neighbours); `least`, the least volume a closed shell (an edge-connected piece) encloses,
 * cubic metres, negative for one wound inward; `smallest`, the least triangle area, square metres.
 */
export function surfaceHealth(triangles: ArrayLike<number>): {
  shells: number
  open: number
  least: number
  smallest: number
} {
  const ids = new Map<string, number>()
  const vertex = (i: number) => {
    const key = `${triangles[i]},${triangles[i + 1]},${triangles[i + 2]}`
    let id = ids.get(key)
    if (id === undefined) ids.set(key, (id = ids.size))
    return id
  }
  const count = triangles.length / 9
  const corners = Array.from({ length: 3 * count }, (_, k) => vertex(3 * k))
  // Directed uses of each edge, and its faces.
  const uses = new Map<string, number>()
  const faces = new Map<string, number[]>()
  for (let f = 0; f < count; f++) {
    for (let e = 0; e < 3; e++) {
      const [a, b] = [corners[3 * f + e]!, corners[3 * f + ((e + 1) % 3)]!]
      const key = a < b ? `${a},${b}` : `${b},${a}`
      uses.set(key, (uses.get(key) ?? 0) + (a < b ? 1 : -1))
      faces.set(key, [...(faces.get(key) ?? []), f])
    }
  }
  const root = Array.from({ length: count }, (_, f) => f)
  const find = (f: number): number => (root[f] === f ? f : (root[f] = find(root[f]!)))
  for (const list of faces.values()) for (const f of list) root[find(f)] = find(list[0]!)
  const openShell = new Set<number>()
  let open = 0
  for (const [key, n] of uses) {
    if (!n) continue
    open++
    openShell.add(find(faces.get(key)![0]!))
  }
  const volume = new Map<number, number>()
  let smallest = Infinity
  for (let f = 0; f < count; f++) {
    const p = (k: number): Vec3 => [
      triangles[9 * f + 3 * k]!,
      triangles[9 * f + 3 * k + 1]!,
      triangles[9 * f + 3 * k + 2]!,
    ]
    const [a, b, c] = [p(0), p(1), p(2)]
    smallest = Math.min(smallest, Math.hypot(...cross(sub(b, a), sub(c, a))) / 2)
    volume.set(find(f), (volume.get(find(f)) ?? 0) + dot(a, cross(b, c)) / 6)
  }
  let least = Infinity
  for (const [shell, v] of volume) if (!openShell.has(shell)) least = Math.min(least, v)
  return { shells: volume.size, open, least, smallest }
}
