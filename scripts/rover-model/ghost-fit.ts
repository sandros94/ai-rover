import type { Shape } from './ghost'
import { box, flatten, orientedBox, simplify, triangleCount, voxelSurface, weld } from './ghost'
import type { Grid, Point2 } from './silhouette'
import { forPixels, gridOver, inside, rasterize, toPixels } from './silhouette'

type Vec3 = [number, number, number]

/** A moving part of the rover, as the ghost fits it. Everything is in the body frame at rest. */
export interface GhostPart {
  /** The app node it hangs from. */
  name: string
  /** The node's axes: extents are measured and vertices moved along them. */
  axes: [Vec3, Vec3, Vec3]
  /** The full model's triangles of the part, flat. */
  triangles: Float32Array
  /** The part's pieces, each fitted on its own (NASA's meshes), or one: the whole part. */
  groups: { name: string; triangles: Float32Array }[]
  /** A primitive fitted elsewhere, drawn as is in place of the groups. */
  fixed?: Shape
}

export interface GhostFitOptions {
  looks: Vec3[]
  /** Pixels along the longer side of each view. */
  resolution: number
  /** Triangles in all. */
  budget: number
  /** The triangle counts each group is simplified to, as candidates. */
  ladder: number[]
  /** Cube size of the closed surface a group's candidates are also simplified from, metres. */
  cell: number
  /**
   * Weight of each part's own silhouettes against the whole rover's: a part the rest hides at
   * rest still shows once it moves.
   */
  isolation: number
  /** How far a part's ghost may fall short of or reach past the part's extent, metres. */
  tolerance: number
  /**
   * Views whose IoU is under `goal` weigh `boost` times more, reassessed as the fit goes: the
   * target is every view, not their sum.
   */
  emphasis: { goal: number; boost: number }
  refine: {
    /** Vertex steps, metres, largest first. */
    steps: number[]
    passes: number
    /** How far a vertex may move from where the simplifier left it, metres. */
    reach: number
  }
}

export interface GhostFit {
  /** Each part's ghost, in the body frame. */
  shapes: Map<string, Shape>
  /** What each group became: a simplification (`surface`, `closed`), a box, or nothing. */
  choices: { group: string; kind: string; triangles: number }[]
  /** Where a part's ghost fell short of its extent, and how it was made to reach it. */
  extents: { part: string; face: string; kind: 'vertex' | 'box' }[]
  /** The weighted differing pixels, over the views, before and after refining. */
  refined: { before: number; after: number }
}

interface Candidate {
  kind: 'none' | 'box' | 'surface' | 'closed'
  shape: Shape
  /** Covered pixels per view. */
  pixels: Int32Array[]
}

interface Layer {
  grid: Grid
  /** The full model's silhouette. */
  full: Uint8Array
  /** How many ghost triangles cover each pixel. */
  count: Int32Array
  /** One over the full silhouette's pixel count. */
  base: number
  /** What a differing pixel weighs: {@link Layer.base}, times the emphasis while behind. */
  weight: number
}

/** Each layer's weight: its base, times `boost` while its IoU is under `goal`. */
function emphasize(layers: Layer[], emphasis?: { goal: number; boost: number }): void {
  for (const l of layers) {
    if (!emphasis) {
      l.weight = l.base
      continue
    }
    let both = 0
    let either = 0
    for (let i = 0; i < l.full.length; i++) {
      const c = l.count[i]! > 0 ? 1 : 0
      both += c & l.full[i]!
      either += c | l.full[i]!
    }
    l.weight = l.base * (both / either < emphasis.goal ? emphasis.boost : 1)
  }
}

/**
 * The ghost: every part at a small triangle budget, its silhouette from the given views matching
 * the full model's as closely as the budget allows.
 *
 * 1. Candidates. Each group is simplified by meshopt to each count of `ladder`, both from its
 *    own triangles (`surface`) and from the closed surface of the cubes it fills (`closed`, which
 *    collapses further before it loses the outline), and boxed along its principal axes (`box`).
 *    A group of a part with several may also be left out.
 * 2. Budget. Starting from each group's cheapest candidate, the change that most reduces the
 *    pixels where the ghost's and the full model's silhouettes differ, per triangle it costs, is
 *    taken until the budget is spent. The differences are the whole rover's plus, weighted by
 *    `isolation`, each part's own; each view counts in proportion to one over its full silhouette.
 *    So a part gets what its silhouette is worth, and a primitive wherever it draws a group's
 *    silhouette better than a simplification at the same cost.
 * 3. Extents. Where a part's ghost reaches past its extent (along its node's axes) it is pulled
 *    in; where it falls more than `tolerance` short of a face, a ghost vertex near the face's
 *    geometry moves out onto it, or, with none near, a flat box is added over that geometry.
 * 4. Refining. Every vertex in turn takes the step along its part's axes that most reduces the
 *    differing pixels, within `reach` of where it was, never past the part's extent, never out of
 *    a band it holds, never turning a triangle over.
 */
export async function fitGhost(parts: GhostPart[], options: GhostFitOptions): Promise<GhostFit> {
  const all = parts.map((p) => p.triangles)
  const layers: Layer[] = options.looks.map((look) => {
    const grid = gridOver(all, look, options.resolution, 0.1)
    const full = new Uint8Array(grid.width * grid.height)
    for (const t of all) rasterize(t, grid).forEach((x, i) => (full[i]! |= x))
    const base = 1 / full.reduce((s, x) => s + x, 0)
    return { grid, full, count: new Int32Array(full.length), base, weight: base }
  })
  const pixelsOf = (shape: Shape) => layers.map((l) => coverage(flatten(shape), l.grid))
  /** Each part's own silhouettes, and its ghost's cover, on the same grids. */
  const own = new Map(
    parts.map((p) => [
      p.name,
      layers.map((l) => ({
        full: rasterize(p.triangles, l.grid),
        count: new Int32Array(l.full.length),
      })),
    ]),
  )

  for (const part of parts) {
    if (!part.fixed) continue
    const pixels = pixelsOf(part.fixed)
    layers.forEach((l, k) => {
      for (const i of pixels[k]!) {
        l.count[i]! += 1
        own.get(part.name)![k]!.count[i]! += 1
      }
    })
  }

  // --- 1. Candidates.
  const groups: { part: GhostPart; name: string; candidates: Candidate[] }[] = []
  for (const part of parts) {
    if (part.fixed) continue
    for (const group of part.groups) {
      const candidates: Candidate[] = []
      const add = (kind: Candidate['kind'], shape: Shape) =>
        candidates.push({ kind, shape, pixels: pixelsOf(shape) })
      if (part.groups.length > 1)
        add('none', { positions: new Float32Array(), indices: new Uint32Array() })
      add('box', orientedBox(group.triangles))
      const sources = {
        surface: weld(group.triangles),
        closed: voxelSurface(group.triangles, options.cell),
      }
      for (const [kind, source] of Object.entries(sources)) {
        let last = -1
        for (const target of options.ladder) {
          if (target >= triangleCount(source)) break
          const shape = await simplify(source, target)
          if (triangleCount(shape) === last) continue
          last = triangleCount(shape)
          add(kind as Candidate['kind'], shape)
        }
      }
      groups.push({ part, name: group.name, candidates })
    }
  }

  // --- 2 and 3, repeated with less for the groups while the extents overrun the budget.
  const fixedTriangles = parts.reduce((s, p) => s + (p.fixed ? triangleCount(p.fixed) : 0), 0)
  const limits = new Map(parts.map((p) => [p.name, extentOf(p.triangles, p.axes)]))
  let groupBudget = options.budget - fixedTriangles
  let picks: number[]
  let pieces: { part: GhostPart; shape: Shape }[]
  let extents: { part: string; face: string; kind: 'vertex' | 'box' }[]
  const scratch = layers.map((l) => ({
    delta: new Int32Array(l.full.length),
    listed: new Uint8Array(l.full.length),
  }))
  for (;;) {
    picks = allocate(groups, layers, own, options, groupBudget, scratch)
    // Copies: the extents and refining move vertices of the picks.
    pieces = groups
      .map((g, k) => ({ part: g.part, shape: copy(g.candidates[picks[k]!]!.shape) }))
      .filter((p) => p.shape.indices.length)
    for (const piece of pieces) clamp(piece.shape, piece.part.axes, limits.get(piece.part.name)!)
    extents = reachExtents(parts, pieces, limits, options.tolerance)
    const total = fixedTriangles + pieces.reduce((s, p) => s + triangleCount(p.shape), 0)
    // Refining draws the pieces itself: the counts go back to the fixed parts alone.
    groups.forEach((g, k) => apply(layers, own.get(g.part.name)!, g.candidates[picks[k]!]!, -1))
    if (total <= options.budget) break
    groupBudget -= total - options.budget
  }

  // --- 4. Refining.
  const refined = refine(pieces, layers, limits, options)

  const shapes = new Map<string, Shape>()
  for (const part of parts) {
    const mine = pieces.filter((p) => p.part === part).map((p) => p.shape)
    shapes.set(part.name, part.fixed ?? mergeShapes(mine))
  }
  return {
    shapes,
    choices: groups.map((g, k) => {
      const pick = g.candidates[picks[k]!]!
      return { group: g.name, kind: pick.kind, triangles: triangleCount(pick.shape) }
    }),
    extents,
    refined,
  }
}

/** The pixels flat triangles cover in a grid, each once. */
function coverage(triangles: Float32Array, grid: Grid): Int32Array {
  const seen = new Set<number>()
  for (let t = 0; t < triangles.length; t += 9) {
    const corners = [0, 3, 6].map((k) => toPixels(grid, triangles.subarray(t + k, t + k + 3)))
    forPixels(grid, corners, (i) => seen.add(i))
  }
  return Int32Array.from(seen)
}

function apply(
  layers: Layer[],
  own: { count: Int32Array }[],
  candidate: Candidate,
  sign: 1 | -1,
): void {
  layers.forEach((l, k) => {
    for (const i of candidate.pixels[k]!) {
      l.count[i]! += sign
      own[k]!.count[i]! += sign
    }
  })
}

/** Per layer: each touched pixel's pending change, and whether it is listed. */
interface Scratch {
  delta: Int32Array
  listed: Uint8Array
}

/**
 * The weighted change in differing pixels if `from` gave way to `to` in a part: the whole
 * rover's, and `isolation` times the part's own.
 */
function change(
  layers: Layer[],
  own: { full: Uint8Array; count: Int32Array }[],
  from: Candidate,
  to: Candidate,
  isolation: number,
  scratch: Scratch[],
): number {
  let total = 0
  layers.forEach((l, k) => {
    const { delta, listed } = scratch[k]!
    const touched: number[] = []
    for (const [pixels, n] of [
      [from.pixels[k]!, -1],
      [to.pixels[k]!, 1],
    ] as const) {
      for (const i of pixels) {
        if (!listed[i]) {
          listed[i] = 1
          touched.push(i)
        }
        delta[i]! += n
      }
    }
    let whole = 0
    let alone = 0
    const mine = own[k]!
    for (const i of touched) {
      const n = delta[i]!
      delta[i] = 0
      listed[i] = 0
      if (!n) continue
      const was = l.count[i]! > 0 ? 1 : 0
      const now = l.count[i]! + n > 0 ? 1 : 0
      whole += (now ^ l.full[i]!) - (was ^ l.full[i]!)
      const wasOwn = mine.count[i]! > 0 ? 1 : 0
      const nowOwn = mine.count[i]! + n > 0 ? 1 : 0
      alone += (nowOwn ^ mine.full[i]!) - (wasOwn ^ mine.full[i]!)
    }
    total += (whole + isolation * alone) * l.weight
  })
  return total
}

/**
 * Each group's candidate within `budget` triangles in all, greedily: the change with the best
 * gain per triangle first, one that gains and saves triangles before any other. Leaves the picks
 * drawn in the layers.
 */
function allocate(
  groups: { part: GhostPart; candidates: Candidate[] }[],
  layers: Layer[],
  own: Map<string, { full: Uint8Array; count: Int32Array }[]>,
  options: Pick<GhostFitOptions, 'isolation' | 'emphasis'>,
  budget: number,
  scratch: Scratch[],
): number[] {
  const { isolation } = options
  const size = (c: Candidate) => triangleCount(c.shape)
  const picks = groups.map((g) => {
    let cheapest = 0
    g.candidates.forEach((c, k) => {
      if (size(c) < size(g.candidates[cheapest]!)) cheapest = k
    })
    return cheapest
  })
  groups.forEach((g, k) => apply(layers, own.get(g.part.name)!, g.candidates[picks[k]!]!, 1))
  let used = groups.reduce((s, g, k) => s + size(g.candidates[picks[k]!]!), 0)
  const best = (k: number) => {
    const g = groups[k]!
    const current = g.candidates[picks[k]!]!
    let out: { k: number; to: number; rate: number } | undefined
    g.candidates.forEach((c, to) => {
      if (to === picks[k]) return
      const cost = size(c) - size(current)
      if (used + cost > budget) return
      const gain = -change(layers, own.get(g.part.name)!, current, c, isolation, scratch)
      if (gain <= 0) return
      const rate = cost <= 0 ? Infinity : gain / cost
      if (!out || rate > out.rate) out = { k, to, rate }
    })
    return out
  }
  // Lazily: a group's best change is measured again when it comes up and taken if it still
  // leads. Other groups' changes shift as this one's are taken, so every few changes, and before
  // stopping, all are measured afresh.
  for (;;) {
    emphasize(layers, options.emphasis)
    const queue = groups.map((_, k) => best(k)).filter((m) => m !== undefined)
    let taken = 0
    while (queue.length && taken < REFRESH) {
      queue.sort((a, b) => b.rate - a.rate || a.k - b.k)
      const top = queue.shift()!
      const fresh = best(top.k)
      if (!fresh) continue
      if (queue.length && fresh.rate < queue[0]!.rate) {
        queue.push(fresh)
        continue
      }
      const g = groups[fresh.k]!
      const mine = own.get(g.part.name)!
      apply(layers, mine, g.candidates[picks[fresh.k]!]!, -1)
      apply(layers, mine, g.candidates[fresh.to]!, 1)
      used += size(g.candidates[fresh.to]!) - size(g.candidates[picks[fresh.k]!]!)
      picks[fresh.k] = fresh.to
      taken++
      const again = best(fresh.k)
      if (again) queue.push(again)
    }
    if (!taken) break
  }
  emphasize(layers)
  return picks
}

/** A set of points' extent along each of `axes`. */
function extentOf(triangles: ArrayLike<number>, axes: Vec3[]): { lo: Vec3; hi: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < triangles.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const d = dot(triangles, i, axes[k]!)
      lo[k] = Math.min(lo[k]!, d)
      hi[k] = Math.max(hi[k]!, d)
    }
  }
  return { lo, hi }
}

/**
 * Makes each part's pieces reach every face of its extent (along its node's axes) to within
 * `tolerance`: where they fall short, the ghost vertex nearest the full model's vertices on that
 * face moves out to it if that is within {@link DRAG} of where it was, or a flat box is added over
 * those vertices. Pieces are changed and added in place.
 */
function reachExtents(
  parts: GhostPart[],
  pieces: { part: GhostPart; shape: Shape }[],
  limits: Map<string, { lo: Vec3; hi: Vec3 }>,
  tolerance: number,
): { part: string; face: string; kind: 'vertex' | 'box' }[] {
  const out: { part: string; face: string; kind: 'vertex' | 'box' }[] = []
  for (const part of parts) {
    if (part.fixed) continue
    const full = limits.get(part.name)!
    for (let k = 0; k < 3; k++) {
      for (const side of [-1, 1] as const) {
        const mine = pieces.filter((p) => p.part === part)
        const ghost = extentOf(concat(mine.map((p) => p.shape.positions)), part.axes)
        const face = side > 0 ? full.hi[k]! : full.lo[k]!
        const short = side > 0 ? face - ghost.hi[k]! : ghost.lo[k]! - face
        if (!(short > tolerance)) continue
        const axis = part.axes[k]!
        // The full model's vertices on that face, and their middle.
        const band: number[] = []
        for (let i = 0; i < part.triangles.length; i += 3) {
          if (Math.abs(dot(part.triangles, i, axis) - face) <= tolerance / 2) {
            band.push(part.triangles[i]!, part.triangles[i + 1]!, part.triangles[i + 2]!)
          }
        }
        const reach = extentOf(band, part.axes)
        const middle = [0, 1, 2].map((j) => (reach.lo[j]! + reach.hi[j]!) / 2) as Vec3
        const target = face - (side * tolerance) / 2
        // The ghost vertex that, moved out onto the face, lands nearest one of those vertices;
        // one holding a face of its own stays.
        const holds = (shape: Shape, i: number) =>
          [0, 1, 2].some((j) => {
            const d = dot(shape.positions, i, part.axes[j]!)
            return d >= full.hi[j]! - tolerance || d <= full.lo[j]! + tolerance
          })
        let nearest: { shape: Shape; i: number; d: number } | undefined
        for (const { shape } of mine) {
          for (let i = 0; i < shape.positions.length; i += 3) {
            if (Math.abs(target - dot(shape.positions, i, axis)) > DRAG || holds(shape, i)) continue
            for (let b = 0; b < band.length; b += 3) {
              let d = 0
              for (let j = 0; j < 3; j++) {
                if (j !== k)
                  d += (dot(band, b, part.axes[j]!) - dot(shape.positions, i, part.axes[j]!)) ** 2
              }
              if (!nearest || d < nearest.d ** 2) nearest = { shape, i, d: Math.sqrt(d) }
            }
          }
        }
        const name = `${side < 0 ? '-' : '+'}${'xyz'[k]}`
        if (nearest && nearest.d <= DRAG) {
          const by = target - dot(nearest.shape.positions, nearest.i, axis)
          for (let j = 0; j < 3; j++) nearest.shape.positions[nearest.i + j]! += by * axis[j]!
          out.push({ part: part.name, face: name, kind: 'vertex' })
          continue
        }
        let centre: Vec3 = [0, 0, 0]
        const half = [0, 0, 0] as Vec3
        for (let j = 0; j < 3; j++) {
          // A band only a vertex wide still gets a millimetre of thickness.
          half[j] = Math.max((reach.hi[j]! - reach.lo[j]!) / 2, 0.001)
          const c = middle[j]!
          const a = part.axes[j]!
          centre = [centre[0] + a[0] * c, centre[1] + a[1] * c, centre[2] + a[2] * c]
        }
        pieces.push({ part, shape: box(centre, part.axes, half) })
        out.push({ part: part.name, face: name, kind: 'box' })
      }
    }
  }
  return out
}

/**
 * How far a ghost vertex may be moved to make its part reach a face, and how far from the face's
 * geometry it may land, metres: further, and the vertex does not stand for that geometry, which
 * gets a box of its own.
 */
const DRAG = 0.05

/** Changes the allocation takes between measuring every group afresh. */
const REFRESH = 8

/** Moves every vertex of `shape` inside `limits` along `axes`. */
function clamp(shape: Shape, axes: Vec3[], limits: { lo: Vec3; hi: Vec3 }): void {
  for (let i = 0; i < shape.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const d = dot(shape.positions, i, axes[k]!)
      const to = Math.min(limits.hi[k]!, Math.max(limits.lo[k]!, d))
      for (let j = 0; j < 3; j++) shape.positions[i + j]! += (to - d) * axes[k]![j]!
    }
  }
}

function refine(
  pieces: { part: GhostPart; shape: Shape }[],
  layers: Layer[],
  limits: Map<string, { lo: Vec3; hi: Vec3 }>,
  options: GhostFitOptions,
): { before: number; after: number } {
  const { steps, passes, reach } = options.refine
  const { tolerance } = options
  // Every vertex and triangle, numbered across the pieces.
  const positions: Float64Array[] = []
  const origins: Float64Array[] = []
  const axesOf: Vec3[][] = []
  const limitOf: { lo: Vec3; hi: Vec3 }[] = []
  const triangles: number[][] = []
  const incident: number[][] = []
  for (const { part, shape } of pieces) {
    const base = positions.length
    for (let v = 0; v < shape.positions.length / 3; v++) {
      positions.push(Float64Array.from(shape.positions.subarray(3 * v, 3 * v + 3)))
      origins.push(Float64Array.from(shape.positions.subarray(3 * v, 3 * v + 3)))
      axesOf.push(part.axes)
      limitOf.push(limits.get(part.name)!)
      incident.push([])
    }
    for (let t = 0; t < shape.indices.length; t += 3) {
      const tri = [0, 1, 2].map((k) => base + shape.indices[t + k]!)
      for (const v of tri) incident[v]!.push(triangles.length)
      triangles.push(tri)
    }
  }
  const scratch = layers.map((l) => ({
    delta: new Int32Array(l.full.length),
    listed: new Uint8Array(l.full.length),
    stamp: new Int32Array(l.full.length),
  }))
  for (const l of layers) {
    for (const tri of triangles) {
      forPixels(
        l.grid,
        tri.map((v) => toPixels(l.grid, positions[v]!)),
        (i) => (l.count[i]! += 1),
      )
    }
  }
  const differing = () =>
    layers.reduce((s, l) => {
      let d = 0
      for (let i = 0; i < l.full.length; i++) d += (l.count[i]! > 0 ? 1 : 0) ^ l.full[i]!
      return s + d * l.base
    }, 0)
  const before = differing()
  let tag = 0

  /** The weighted change in differing pixels if vertex `v` moved to `to`; made if `commit`. */
  const change = (v: number, to: Vec3, commit: boolean): number => {
    let total = 0
    layers.forEach((l, k) => {
      const { delta, listed, stamp } = scratch[k]!
      const touched: number[] = []
      const p = toPixels(l.grid, positions[v]!)
      const q = toPixels(l.grid, to)
      for (const t of incident[v]!) {
        tag++
        const [a, b] = triangles[t]!.filter((w) => w !== v).map((w) =>
          toPixels(l.grid, positions[w]!),
        ) as [Point2, Point2]
        const old = [a, b, p]
        const moved = [a, b, q]
        const visit = (i: number, x: number, y: number) => {
          if (stamp[i] === tag) return
          stamp[i] = tag
          const d = (inside(moved, x, y) ? 1 : 0) - (inside(old, x, y) ? 1 : 0)
          if (!d) return
          if (!listed[i]) {
            listed[i] = 1
            touched.push(i)
          }
          delta[i]! += d
        }
        // Only what the triangle's two moving edges sweep can change.
        forPixels(l.grid, [a, p, q], visit, true)
        forPixels(l.grid, [b, p, q], visit, true)
      }
      let d = 0
      for (const i of touched) {
        const n = delta[i]!
        delta[i] = 0
        listed[i] = 0
        if (!n) continue
        const was = l.count[i]! > 0 ? 1 : 0
        const now = l.count[i]! + n > 0 ? 1 : 0
        d += (now ^ l.full[i]!) - (was ^ l.full[i]!)
        if (commit) l.count[i]! += n
      }
      total += d * l.weight
    })
    if (commit) positions[v]!.set(to)
    return total
  }

  /** Whether moving vertex `v` to `to` breaks a limit: its part's extent, a band, its reach. */
  const allowed = (v: number, to: Vec3): boolean => {
    const axes = axesOf[v]!
    const { lo, hi } = limitOf[v]!
    for (let k = 0; k < 3; k++) {
      const now = dot(positions[v]!, 0, axes[k]!)
      const next = dot(to, 0, axes[k]!)
      if (next < lo[k]! - 1e-9 || next > hi[k]! + 1e-9) return false
      if (now >= hi[k]! - tolerance && next < hi[k]! - tolerance) return false
      if (now <= lo[k]! + tolerance && next > lo[k]! + tolerance) return false
      if (Math.abs(next - dot(origins[v]!, 0, axes[k]!)) > reach) return false
    }
    return !incident[v]!.some((t) => {
      const corners = triangles[t]!.map((w) => positions[w]!)
      const n0 = normal(corners)
      const n1 = normal(triangles[t]!.map((w) => (w === v ? to : positions[w]!)))
      return n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] <= 0
    })
  }

  for (const step of steps) {
    for (let pass = 0; pass < passes; pass++) {
      emphasize(layers, options.emphasis)
      let moved = 0
      for (let v = 0; v < positions.length; v++) {
        let bestMove: { to: Vec3; gain: number } | undefined
        for (const axis of axesOf[v]!) {
          for (const sign of [1, -1]) {
            const p = positions[v]!
            const to: Vec3 = [
              p[0]! + sign * step * axis[0],
              p[1]! + sign * step * axis[1],
              p[2]! + sign * step * axis[2],
            ]
            if (!allowed(v, to)) continue
            const gain = -change(v, to, false)
            if (gain > 1e-12 && (!bestMove || gain > bestMove.gain)) bestMove = { to, gain }
          }
        }
        if (bestMove) {
          change(v, bestMove.to, true)
          moved++
        }
      }
      if (!moved) break
    }
  }
  emphasize(layers)
  let v = 0
  for (const { shape } of pieces) {
    for (let i = 0; i < shape.positions.length / 3; i++) shape.positions.set(positions[v++]!, 3 * i)
  }
  return { before, after: differing() }
}

const dot = (a: ArrayLike<number>, i: number, b: Vec3) =>
  a[i]! * b[0] + a[i + 1]! * b[1] + a[i + 2]! * b[2]

function normal(p: ArrayLike<number>[]): Vec3 {
  const [a, b, c] = p as [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]
  const e = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
  const f = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
  return [
    e[1]! * f[2]! - e[2]! * f[1]!,
    e[2]! * f[0]! - e[0]! * f[2]!,
    e[0]! * f[1]! - e[1]! * f[0]!,
  ]
}

function copy(shape: Shape): Shape {
  return { positions: Float32Array.from(shape.positions), indices: Uint32Array.from(shape.indices) }
}

function concat(arrays: Float32Array[]): Float32Array {
  const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0))
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

function mergeShapes(shapes: Shape[]): Shape {
  const positions = new Float32Array(shapes.reduce((s, x) => s + x.positions.length, 0))
  const indices = new Uint32Array(shapes.reduce((s, x) => s + x.indices.length, 0))
  let p = 0
  let i = 0
  for (const shape of shapes) {
    positions.set(shape.positions, p)
    for (const index of shape.indices) indices[i++] = index + p / 3
    p += shape.positions.length
  }
  return { positions, indices }
}
