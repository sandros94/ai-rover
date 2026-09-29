import type { Document } from '@gltf-transform/core'

type Vec3 = [number, number, number]

/** A box along a frame's axes. */
export interface Bounds {
  min: Vec3
  max: Vec3
}

/**
 * The orthographic views two builds of the rover are compared from, as the direction each looks
 * along (body frame: x forward, y left, z up): straight down, from ahead, from the left, and three
 * obliques from above: front left, rear right, and front right from low down.
 */
export const SILHOUETTE_VIEWS: { name: string; look: Vec3 }[] = [
  { name: 'top', look: [0, 0, -1] },
  { name: 'front', look: [-1, 0, 0] },
  { name: 'side', look: [0, -1, 0] },
  { name: 'front-left', look: [-1, -1, -1] },
  { name: 'rear-right', look: [1, 1, -1] },
  { name: 'front-right-low', look: [-1, 1, -0.35] },
]

/**
 * Each part's triangles, flat (nine numbers each), by the joint node its mesh hangs from: in the
 * body frame (the model's root) at the model's current pose, or with `frame: 'part'` in that
 * node's own frame.
 */
export function partTriangles(
  doc: Document,
  frame: 'body' | 'part' = 'body',
): Map<string, Float32Array> {
  const out = new Map<string, number[]>()
  for (const meshNode of doc.getRoot().listNodes()) {
    const mesh = meshNode.getMesh()
    const owner = meshNode.getParentNode()
    if (!mesh || !owner) continue
    // The mesh child's transform carries quantization's scale and offset.
    const m = frame === 'body' ? meshNode.getWorldMatrix() : meshNode.getMatrix()
    let list = out.get(owner.getName())
    if (!list) out.set(owner.getName(), (list = []))
    const v: number[] = [0, 0, 0]
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION')!
      const indices = primitive.getIndices()
      const count = indices ? indices.getCount() : position.getCount()
      for (let i = 0; i < count; i++) {
        position.getElement(indices ? indices.getScalar(i) : i, v)
        list.push(
          m[0]! * v[0]! + m[4]! * v[1]! + m[8]! * v[2]! + m[12]!,
          m[1]! * v[0]! + m[5]! * v[1]! + m[9]! * v[2]! + m[13]!,
          m[2]! * v[0]! + m[6]! * v[1]! + m[10]! * v[2]! + m[14]!,
        )
      }
    }
  }
  return new Map([...out].map(([name, list]) => [name, Float32Array.from(list)]))
}

/** The box around flat triangles' vertices. */
export function boundsOf(triangles: ArrayLike<number>): Bounds {
  const box: Bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  }
  for (let i = 0; i < triangles.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      box.min[k] = Math.min(box.min[k]!, triangles[i + k]!)
      box.max[k] = Math.max(box.max[k]!, triangles[i + k]!)
    }
  }
  return box
}

/** The largest distance between matching faces of two boxes, metres. */
export const boundsDelta = (a: Bounds, b: Bounds): number =>
  Math.max(
    ...[0, 1, 2].flatMap((k) => [Math.abs(a.min[k]! - b.min[k]!), Math.abs(a.max[k]! - b.max[k]!)]),
  )

/** An orthographic view's pixel grid: pixel (x, y) spans `minU + x·pixel` along `u`, and so on. */
export interface Grid {
  u: Vec3
  v: Vec3
  minU: number
  minV: number
  pixel: number
  width: number
  height: number
}

/**
 * A grid looking along `look` over flat triangles (one set or several), `resolution` pixels along
 * the longer side of their projection, with `margin` metres of room around it.
 */
export function gridOver(
  triangles: ArrayLike<number>[],
  look: Vec3,
  resolution: number,
  margin = 0,
): Grid {
  const [u, v] = viewBasis(look)
  let [minU, minV, maxU, maxV] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const set of triangles) {
    for (let i = 0; i < set.length; i += 3) {
      const [x, y, z] = [set[i]!, set[i + 1]!, set[i + 2]!]
      const pu = x * u[0] + y * u[1] + z * u[2]
      const pv = x * v[0] + y * v[1] + z * v[2]
      minU = Math.min(minU, pu)
      maxU = Math.max(maxU, pu)
      minV = Math.min(minV, pv)
      maxV = Math.max(maxV, pv)
    }
  }
  const pixel = Math.max(maxU - minU, maxV - minV) / resolution
  return {
    u,
    v,
    minU: minU - margin,
    minV: minV - margin,
    pixel,
    width: Math.ceil((maxU - minU + 2 * margin) / pixel) + 1,
    height: Math.ceil((maxV - minV + 2 * margin) / pixel) + 1,
  }
}

/**
 * Two models' silhouettes seen along `look`: both projected orthographically onto one grid
 * spanning them both, `resolution` pixels along its longer side, a pixel covered when its centre
 * lies inside a triangle. Rows run from the bottom of the view up.
 */
export function silhouettes(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  look: Vec3,
  resolution = 512,
): Grid & { a: Uint8Array; b: Uint8Array } {
  const grid = gridOver([a, b], look, resolution)
  return { ...grid, a: rasterize(a, grid), b: rasterize(b, grid) }
}

/** The intersection over union of two models' {@link silhouettes} seen along `look`. */
export function silhouetteIoU(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  look: Vec3,
  resolution = 512,
): number {
  const masks = silhouettes(a, b, look, resolution)
  let both = 0
  let either = 0
  for (let i = 0; i < masks.a.length; i++) {
    both += masks.a[i]! & masks.b[i]!
    either += masks.a[i]! | masks.b[i]!
  }
  return either ? both / either : 1
}

/** Screen axes for a view along `look`: up is the body's up, or its forward looking straight down. */
export function viewBasis(look: Vec3): [Vec3, Vec3] {
  const l = Math.hypot(...look)
  const d = look.map((x) => x / l) as Vec3
  const up: Vec3 = Math.abs(d[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1]
  const u = normalize(cross(d, up))
  return [u, cross(u, d)]
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(...a)
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** A point in a grid's pixel coordinates. */
export type Point2 = [number, number]

export function toPixels(grid: Grid, p: ArrayLike<number>): Point2 {
  const { u, v } = grid
  return [
    (p[0]! * u[0] + p[1]! * u[1] + p[2]! * u[2] - grid.minU) / grid.pixel,
    (p[0]! * v[0] + p[1]! * v[1] + p[2]! * v[2] - grid.minV) / grid.pixel,
  ]
}

/** Flat triangles' coverage of a grid, a byte per pixel. */
export function rasterize(triangles: ArrayLike<number>, grid: Grid): Uint8Array {
  const mask = new Uint8Array(grid.width * grid.height)
  for (let t = 0; t < triangles.length; t += 9) {
    const corners = [0, 3, 6].map((k) =>
      toPixels(grid, [triangles[t + k]!, triangles[t + k + 1]!, triangles[t + k + 2]!]),
    )
    forPixels(grid, corners, (i) => (mask[i] = 1))
  }
  return mask
}

/** Whether a pixel centre lies in a triangle (pixel coordinates); degenerate ones cover none. */
export function inside(t: Point2[], x: number, y: number): boolean {
  const [[x0, y0], [x1, y1], [x2, y2]] = t as [Point2, Point2, Point2]
  const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
  if (area === 0) return false
  const s = area > 0 ? 1 : -1
  return (
    s * ((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0)) >= 0 &&
    s * ((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) >= 0 &&
    s * ((x0 - x2) * (y - y2) - (y0 - y2) * (x - x2)) >= 0
  )
}

/**
 * Calls `visit` with the index of each pixel whose centre lies in the triangle (pixel
 * coordinates); with `loose`, of a superset: every pixel within about a pixel of it.
 */
export function forPixels(
  grid: Grid,
  t: Point2[],
  visit: (i: number, x: number, y: number) => void,
  loose = false,
): void {
  const pad = loose ? 1 : 0
  const ys = t.map((p) => p[1])
  const fromY = Math.max(0, Math.ceil(Math.min(...ys) - 0.5) - pad)
  const toY = Math.min(grid.height - 1, Math.floor(Math.max(...ys) - 0.5) + pad)
  for (let py = fromY; py <= toY; py++) {
    const y = py + 0.5
    let lo = Infinity
    let hi = -Infinity
    for (const row of loose ? [y - 1, y, y + 1] : [y]) {
      const span = rowSpan(t, row)
      if (!span) continue
      lo = Math.min(lo, span[0])
      hi = Math.max(hi, span[1])
    }
    if (lo > hi) continue
    const fromX = Math.max(0, Math.ceil(lo - 0.5) - pad)
    const toX = Math.min(grid.width - 1, Math.floor(hi - 0.5) + pad)
    for (let px = fromX; px <= toX; px++) {
      const x = px + 0.5
      if (loose || inside(t, x, y)) visit(py * grid.width + px, x, y)
    }
  }
}

/** Where a horizontal line at `y` crosses a triangle's edges, or nothing. */
function rowSpan(t: Point2[], y: number): Point2 | undefined {
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < 3; k++) {
    const [a, b] = [t[k]!, t[(k + 1) % 3]!]
    if ((a[1] - y) * (b[1] - y) > 0) continue
    if (a[1] === b[1]) {
      lo = Math.min(lo, a[0], b[0])
      hi = Math.max(hi, a[0], b[0])
      continue
    }
    const x = a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])
    lo = Math.min(lo, x)
    hi = Math.max(hi, x)
  }
  return lo <= hi ? [lo, hi] : undefined
}
