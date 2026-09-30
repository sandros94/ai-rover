import type { Frame, Plane, Primitive, Solid, Vec3 } from './ghost'
import {
  convex,
  cross,
  dot,
  equalArea,
  fitCircle,
  hull,
  leastRectangle,
  moved,
  movedPlanes,
  polygon,
  principalAxes,
  prism,
  reduceOutline,
  scale,
  surfaceHealth,
  triangleCount,
  trianglesOf,
} from './ghost'
import type { Grid } from './silhouette'
import { forPixels, gridOver, rasterize, toPixels } from './silhouette'

type Vec2 = [number, number]

/** A moving part of the rover, as the low-poly model fits it. */
export interface GhostPart {
  /** The app node it hangs from. */
  name: string
  /** The node in the body frame at rest: rotation (row-major) then origin. */
  pose: { r: number[]; t: Vec3 }
  /** The full model's triangles of the part, flat, in the node's frame. */
  triangles: Float32Array
  /** Primitives fitted elsewhere (a wheel's), in the node's frame, drawn as they are. */
  fixed?: Primitive[]
}

export interface GhostFitOptions {
  /** The views the silhouettes are compared from, each the direction it looks along. */
  looks: Vec3[]
  /** Pixels along the longer side of each view. */
  resolution: number
  /** Triangles in all. */
  budget: number
  /** Cube size of the volumes compared, metres. */
  cell: number
  /** What the volume's difference weighs against one view's silhouette's. */
  volume: number
  /**
   * How far a part's primitives may reach past the part's extent before they are cut back to it,
   * and how far short of it they may fall, metres.
   */
  tolerance: number
  /** The size a part's pieces are grouped up to before the fit starts merging them, metres. */
  piece: number
  /**
   * What each primitive costs besides its triangles, in the loss's units: pieces merge, or small
   * ones go, where the silhouettes and volume lose less than this.
   */
  primitive: number
  /** Sides of the cylinders, and most corners of the prisms' outlines, offered. */
  sides: number[]
  /**
   * The volume overlap (intersection over union) a primitive must gain over its piece's best box,
   * per triangle more it costs, to be offered besides it.
   */
  price: number
}

export interface GhostFit {
  /** Each part's primitives, in its node's frame. */
  shapes: Map<string, Solid[]>
  /** Each part's primitives: kind and triangles. */
  choices: Map<string, { kind: string; triangles: number }[]>
}

/** A primitive offered for a piece, with what it covers of each layer once measured. */
interface Variant {
  kind: string
  primitive: Primitive
  triangles: number
  /** Its extent in the part's frame. */
  lo: Vec3
  hi: Vec3
  cover?: Int32Array[]
}

/** A piece of a part: a set of its triangles, and the two pieces it splits into. */
interface Piece {
  part: number
  triangles: Int32Array
  lo: Vec3
  hi: Vec3
  children?: [Piece, Piece]
  parent?: Piece
  offered?: Variant[]
}

/** A cube grid: cube (x, y, z) spans `origin + (x, y, z)·cell` to one cube further. */
interface Voxels {
  origin: Vec3
  cell: number
  n: [number, number, number]
}

/** A layer the fit compares on: one view's pixels, or the volume's cubes. */
interface Layer {
  full: Uint8Array
  count: Int32Array
  weight: number
  delta: Int32Array
  listed: Uint8Array
}

/** Least triangle area a primitive may draw, square metres: quantizing shrinks some a little. */
const MIN_AREA = 2e-6
/**
 * Shortest edge a primitive may have, metres: quantizing the model's positions (a 0.2 mm step over
 * the chassis) would tilt a sliver's face by degrees against the normal it carries.
 */
const MIN_EDGE = 0.003
/** Least thickness of a box or prism, metres. */
const MIN_THICKNESS = 0.01
/** Cubes along the longest side of a piece's grid when its primitives' overlap is measured. */
const LOCAL_CUBES = 20
/** How often every pending move is measured afresh, in moves taken. */
const REFRESH = 16

/**
 * The low-poly rover: each part a few convex primitives fitted to its geometry in its own frame,
 * within `budget` triangles, every primitive a closed solid wound outward.
 *
 * 1. Pieces. A part's triangles fall into connected pieces; a piece whose two halves (cut across
 *    its principal axes) fill much less than it does is split, and so on down to `piece`; pieces
 *    are then grouped pairwise, the pair adding the least empty box volume first, into one tree.
 * 2. Primitives. Each piece is offered its box of least volume, and prisms of its convex outline
 *    along each of its principal axes and its part's (outlines of a few corners circumscribing
 *    the outline) and cylinders about them (least squares circles on the outline, as polygons of
 *    equal area); each is cut back to the part's extent where it reaches more than `tolerance`
 *    past it, and kept only as a closed solid with no triangle under {@link MIN_AREA}. The best
 *    box by volume overlap with the piece is offered, and the primitive with the best overlap
 *    less `price` per triangle when that is another.
 * 3. Budget. The fit starts from the pieces up to `piece` in size, each its best primitive, and
 *    takes the change that loses the least per triangle it saves until the budget holds: two
 *    pieces merged into their parent's primitive, a piece dropped, or a cheaper primitive for it;
 *    never one that leaves its part more than `tolerance` short of its extent. The loss is the
 *    growth of the cubes and pixels where the fit and the full model differ, each view's pixels
 *    over its full silhouette's count, and the volume's cubes over the full volume's, weighted by
 *    `volume`.
 */
export function fitGhost(parts: GhostPart[], options: GhostFitOptions): GhostFit {
  const body = parts.map((p) => movedTriangles(p.triangles, p.pose))
  const extents = parts.map((p) => boundsOf(p.triangles))

  // --- Layers: each view's silhouette, and the volume.
  const layers: Layer[] = []
  const grids = options.looks.map((look) => gridOver(body, look, options.resolution, 0.1))
  for (const grid of grids) {
    const full = new Uint8Array(grid.width * grid.height)
    for (const t of body) rasterize(t, grid).forEach((x, i) => (full[i]! |= x))
    layers.push(layerOf(full, 1))
  }
  const all = body.map(boundsOf).reduce((a, b) => ({
    lo: [0, 1, 2].map((k) => Math.min(a.lo[k]!, b.lo[k]!)) as Vec3,
    hi: [0, 1, 2].map((k) => Math.max(a.hi[k]!, b.hi[k]!)) as Vec3,
  }))
  const space: Voxels = voxelsOver(all.lo, all.hi, options.cell, 2)
  {
    const full = new Uint8Array(space.n[0] * space.n[1] * space.n[2])
    for (const triangles of body) {
      const box = boundsOf(triangles)
      const own = voxelsOver(box.lo, box.hi, options.cell, 1, space)
      const solid = solidOf(triangles, own)
      forCells(own, (i, x, y, z) => {
        if (solid[i]) full[indexIn(space, own, x, y, z)] = 1
      })
    }
    layers.push(layerOf(full, options.volume))
  }
  const coverOf = (part: GhostPart, primitive: Primitive): Int32Array[] => {
    const flat = trianglesOf(moved(primitive.solid, part.pose.r, part.pose.t))
    const out = grids.map((grid) => pixelsOf(flat, grid))
    const planes = movedPlanes(primitive.planes, part.pose.r, part.pose.t)
    const hole = primitive.hole && movedPlanes(primitive.hole, part.pose.r, part.pose.t)
    out.push(cellsOf(space, planes, hole, boundsOf(flat)))
    return out
  }
  const apply = (cover: Int32Array[], sign: 1 | -1) =>
    layers.forEach((l, k) => {
      for (const i of cover[k]!) l.count[i]! += sign
    })

  // --- Fixed primitives: drawn from the start, never changed.
  let used = 0
  for (const part of parts) {
    for (const q of part.fixed ?? []) {
      if (!isSound(q.solid)) throw new Error(`fitGhost: ${part.name}'s primitive is not sound.`)
      apply(coverOf(part, q), 1)
      used += triangleCount(q.solid)
    }
  }

  // --- 1 and 2. Pieces, the ones to start from, and their primitives.
  const frontier = new Map<Piece, Variant | null>()
  parts.forEach((part, k) => {
    if (part.fixed) return
    const start = (piece: Piece): Piece[] =>
      piece.children && size(piece) > options.piece ? piece.children.flatMap(start) : [piece]
    for (const piece of start(treeOf(part.triangles, k, options.piece))) frontier.set(piece, null)
  })
  const offer = (piece: Piece): Variant[] => {
    piece.offered ??= offered(parts[piece.part]!, piece, extents[piece.part]!, options)
    for (const v of piece.offered) v.cover ??= coverOf(parts[piece.part]!, v.primitive)
    return piece.offered
  }
  for (const piece of frontier.keys()) {
    const best = offer(piece)[0]
    if (!best) continue
    frontier.set(piece, best)
    apply(best.cover!, 1)
    used += best.triangles
  }

  // --- 3. Budget.
  /** Whether a part's primitives reach its extent to within tolerance, some replaced. */
  const reaches = (part: number, without: Piece[], adding: Variant[]) => {
    const extent = extents[part]!
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    const take = (v: Variant) => {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, v.lo[k]!)
        hi[k] = Math.max(hi[k]!, v.hi[k]!)
      }
    }
    for (const [piece, v] of frontier) {
      if (piece.part === part && v && !without.includes(piece)) take(v)
    }
    adding.forEach(take)
    return [0, 1, 2].every(
      (k) =>
        lo[k]! <= extent.lo[k]! + options.tolerance && hi[k]! >= extent.hi[k]! - options.tolerance,
    )
  }
  interface Move {
    site: Piece
    /** The pieces it replaces, and what it draws in their place. */
    from: Piece[]
    to: Variant | null
    saved: number
    loss: number
  }
  const rate = (m: Move) => m.loss / m.saved
  /** The best move at a site: a drawn piece, or a parent whose children both are drawn or dropped. */
  const bestAt = (site: Piece): Move | undefined => {
    const moves: Omit<Move, 'loss' | 'site'>[] = []
    if (frontier.has(site)) {
      const current = frontier.get(site)
      if (!current) return undefined
      moves.push({ from: [site], to: null, saved: current.triangles })
      for (const v of offer(site)) {
        if (v.triangles < current.triangles) {
          moves.push({ from: [site], to: v, saved: current.triangles - v.triangles })
        }
      }
    } else if (site.children?.every((c) => frontier.has(c))) {
      const total = site.children.reduce((s, c) => s + (frontier.get(c)?.triangles ?? 0), 0)
      for (const v of offer(site)) {
        moves.push({ from: site.children, to: v, saved: total - v.triangles })
      }
      moves.push({ from: site.children, to: null, saved: total })
    } else return undefined
    let best: Move | undefined
    for (const m of moves) {
      if (m.saved <= 0) continue
      if (!reaches(site.part, m.from, m.to ? [m.to] : [])) continue
      const before = m.from.flatMap((p) => {
        const v = frontier.get(p)
        return v ? [v.cover!] : []
      })
      const fewer = before.length - (m.to ? 1 : 0)
      const loss = change(layers, before, m.to ? [m.to.cover!] : []) - options.primitive * fewer
      const move = { ...m, site, loss }
      if (!best || rate(move) < rate(best)) best = move
    }
    return best
  }
  const wanted = (m: Move | undefined): m is Move =>
    m !== undefined && (used > options.budget || m.loss < 0)
  for (;;) {
    const sites = new Set<Piece>()
    for (const piece of frontier.keys()) {
      sites.add(piece)
      if (piece.parent) sites.add(piece.parent)
    }
    const queue = [...sites].map(bestAt).filter(wanted)
    let taken = 0
    while (queue.length && taken < REFRESH) {
      queue.sort((a, b) => rate(a) - rate(b))
      const fresh = bestAt(queue.shift()!.site)
      if (!wanted(fresh)) continue
      if (queue.length && rate(fresh) > rate(queue[0]!)) {
        queue.push(fresh)
        continue
      }
      for (const p of fresh.from) {
        const v = frontier.get(p)
        if (v) apply(v.cover!, -1)
        frontier.delete(p)
      }
      frontier.set(fresh.site, fresh.to)
      if (fresh.to) apply(fresh.to.cover!, 1)
      used -= fresh.saved
      taken++
      for (const site of [fresh.site, fresh.site.parent]) {
        const again = site && bestAt(site)
        if (wanted(again)) queue.push(again)
      }
    }
    if (!taken) break
  }

  const shapes = new Map<string, Solid[]>()
  const choices = new Map<string, { kind: string; triangles: number }[]>()
  parts.forEach((part, k) => {
    const drawn = [
      ...(part.fixed ?? []).map((q) => ({
        kind: 'wheel',
        primitive: q,
        triangles: triangleCount(q.solid),
      })),
      ...[...frontier].flatMap(([piece, v]) => (piece.part === k && v ? [v] : [])),
    ]
    shapes.set(
      part.name,
      drawn.map((v) => v.primitive.solid),
    )
    choices.set(
      part.name,
      drawn.map(({ kind, triangles }) => ({ kind, triangles })),
    )
  })
  return { shapes, choices }
}

function layerOf(full: Uint8Array, weight: number): Layer {
  return {
    full,
    count: new Int32Array(full.length),
    weight: weight / full.reduce((s, x) => s + x, 0),
    delta: new Int32Array(full.length),
    listed: new Uint8Array(full.length),
  }
}

/** The weighted change in differing pixels and cubes if the covers `from` gave way to `to`. */
function change(layers: Layer[], from: Int32Array[][], to: Int32Array[][]): number {
  let total = 0
  layers.forEach((l, k) => {
    const { delta, listed } = l
    const touched: number[] = []
    for (const [covers, n] of [
      [from, -1],
      [to, 1],
    ] as const) {
      for (const cover of covers) {
        for (const i of cover[k]!) {
          if (!listed[i]) {
            listed[i] = 1
            touched.push(i)
          }
          delta[i]! += n
        }
      }
    }
    let differ = 0
    for (const i of touched) {
      const n = delta[i]!
      delta[i] = 0
      listed[i] = 0
      if (!n) continue
      const was = l.count[i]! > 0 ? 1 : 0
      const now = l.count[i]! + n > 0 ? 1 : 0
      differ += (now ^ l.full[i]!) - (was ^ l.full[i]!)
    }
    total += differ * l.weight
  })
  return total
}

/** The largest side of a piece's extent. */
const size = (piece: Piece) => Math.max(...[0, 1, 2].map((k) => piece.hi[k]! - piece.lo[k]!))

/**
 * A part's pieces as one tree: its connected pieces, each split while its halves fill much less
 * than it (down to `least`), grouped pairwise by the least empty box volume the pair adds.
 */
function treeOf(triangles: Float32Array, part: number, least: number): Piece {
  const count = triangles.length / 9
  // Connected pieces: triangles sharing a corner (to a tenth of a millimetre).
  const ids = new Map<string, number>()
  const root: number[] = []
  const find = (a: number): number => (root[a] === a ? a : (root[a] = find(root[a]!)))
  const corner = new Int32Array(3 * count)
  for (let c = 0; c < 3 * count; c++) {
    const key = [0, 1, 2].map((k) => Math.round(triangles[3 * c + k]! * 1e4)).join()
    let id = ids.get(key)
    if (id === undefined) {
      ids.set(key, (id = root.length))
      root.push(id)
    }
    corner[c] = id
  }
  for (let t = 0; t < count; t++) {
    const a = find(corner[3 * t]!)
    root[find(corner[3 * t + 1]!)] = a
    root[find(corner[3 * t + 2]!)] = a
  }
  const byRoot = new Map<number, number[]>()
  for (let t = 0; t < count; t++) {
    const r = find(corner[3 * t]!)
    let list = byRoot.get(r)
    if (!list) byRoot.set(r, (list = []))
    list.push(t)
  }
  const pieces = [...byRoot.values()].map((list) =>
    split(triangles, pieceOf(triangles, part, list), least),
  )

  // Grouped pairwise: each step the pair whose box adds the least volume over their own.
  const volume = (lo: Vec3, hi: Vec3) =>
    [0, 1, 2].reduce((s, k) => s * Math.max(hi[k]! - lo[k]!, 0.01), 1)
  const cost = (a: Piece, b: Piece) => {
    const lo = [0, 1, 2].map((k) => Math.min(a.lo[k]!, b.lo[k]!)) as Vec3
    const hi = [0, 1, 2].map((k) => Math.max(a.hi[k]!, b.hi[k]!)) as Vec3
    return volume(lo, hi) - volume(a.lo, a.hi) - volume(b.lo, b.hi)
  }
  const alive = new Set(pieces)
  const heap = new PairHeap()
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      heap.push(cost(pieces[i]!, pieces[j]!), pieces[i]!, pieces[j]!)
    }
  }
  while (alive.size > 1) {
    const [a, b] = heap.pop()!
    if (!alive.has(a) || !alive.has(b)) continue
    alive.delete(a)
    alive.delete(b)
    const merged: Piece = {
      part,
      triangles: concatInt(a.triangles, b.triangles),
      lo: [0, 1, 2].map((k) => Math.min(a.lo[k]!, b.lo[k]!)) as Vec3,
      hi: [0, 1, 2].map((k) => Math.max(a.hi[k]!, b.hi[k]!)) as Vec3,
      children: [a, b],
    }
    a.parent = merged
    b.parent = merged
    for (const c of alive) heap.push(cost(merged, c), merged, c)
    alive.add(merged)
  }
  return [...alive][0]!
}

function pieceOf(triangles: Float32Array, part: number, list: ArrayLike<number>): Piece {
  const ts = Int32Array.from(list)
  const { lo, hi } = boundsOf(gather(triangles, ts))
  return { part, triangles: ts, lo, hi }
}

/**
 * A connected piece split in two across one of its principal axes, where the halves' boxes (on
 * those axes) fill least, while they fill under three quarters of its box and it is larger than
 * twice `least`; and each half likewise.
 */
function split(triangles: Float32Array, piece: Piece, least: number): Piece {
  if (size(piece) <= 2 * least || piece.triangles.length < 8) return piece
  const axes = principalAxes(gather(triangles, piece.triangles))
  const boxVolume = (list: number[]) => {
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const t of list) {
      for (let c = 0; c < 3; c++) {
        const p = triangles.subarray(9 * t + 3 * c, 9 * t + 3 * c + 3)
        for (let k = 0; k < 3; k++) {
          const d = p[0]! * axes[k]![0] + p[1]! * axes[k]![1] + p[2]! * axes[k]![2]
          lo[k] = Math.min(lo[k]!, d)
          hi[k] = Math.max(hi[k]!, d)
        }
      }
    }
    return [0, 1, 2].reduce((s, k) => s * Math.max(hi[k]! - lo[k]!, 0.005), 1)
  }
  const list = [...piece.triangles]
  const whole = boxVolume(list)
  let best: { cost: number; halves: [number[], number[]] } | undefined
  for (const axis of axes) {
    const along = new Map(
      list.map((t) => {
        let s = 0
        for (let c = 0; c < 3; c++) {
          const p = triangles.subarray(9 * t + 3 * c, 9 * t + 3 * c + 3)
          s += p[0]! * axis[0] + p[1]! * axis[1] + p[2]! * axis[2]
        }
        return [t, s] as const
      }),
    )
    const sorted = [...list].sort((a, b) => along.get(a)! - along.get(b)!)
    for (let q = 1; q < 8; q++) {
      const at = Math.round((q / 8) * sorted.length)
      const halves: [number[], number[]] = [sorted.slice(0, at), sorted.slice(at)]
      if (!halves[0].length || !halves[1].length) continue
      const cost = boxVolume(halves[0]) + boxVolume(halves[1])
      if (!best || cost < best.cost) best = { cost, halves }
    }
  }
  if (!best || best.cost > 0.75 * whole) return piece
  const children = best.halves.map((h) =>
    split(triangles, pieceOf(triangles, piece.part, h), least),
  ) as [Piece, Piece]
  for (const c of children) c.parent = piece
  piece.children = children
  return piece
}

/** A binary min-heap of pairs by cost. */
class PairHeap {
  private items: { cost: number; a: Piece; b: Piece }[] = []
  push(cost: number, a: Piece, b: Piece): void {
    const items = this.items
    items.push({ cost, a, b })
    for (let i = items.length - 1; i > 0;) {
      const up = (i - 1) >> 1
      if (items[up]!.cost <= items[i]!.cost) break
      ;[items[up], items[i]] = [items[i]!, items[up]!]
      i = up
    }
  }
  pop(): [Piece, Piece] | undefined {
    const items = this.items
    const top = items[0]
    if (!top) return undefined
    const last = items.pop()!
    if (items.length) {
      items[0] = last
      for (let i = 0; ;) {
        const [l, r] = [2 * i + 1, 2 * i + 2]
        let m = i
        if (l < items.length && items[l]!.cost < items[m]!.cost) m = l
        if (r < items.length && items[r]!.cost < items[m]!.cost) m = r
        if (m === i) break
        ;[items[m], items[i]] = [items[i]!, items[m]!]
        i = m
      }
    }
    return [top.a, top.b]
  }
}

/**
 * The primitives offered for a piece (in its part's frame), best first: the one with the best
 * volume overlap less `price` per triangle, and the best box when that is another; none for a
 * piece too small for a sound one.
 */
function offered(
  part: GhostPart,
  piece: Piece,
  extent: { lo: Vec3; hi: Vec3 },
  options: GhostFitOptions,
): Variant[] {
  const own = gather(part.triangles, piece.triangles)
  const points: Vec3[] = []
  for (let i = 0; i < own.length; i += 3) points.push([own[i]!, own[i + 1]!, own[i + 2]!])
  const directions: Vec3[] = []
  const unit: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (const w of [...principalAxes(own), ...unit]) {
    if (!directions.some((d) => Math.abs(dot(d, w)) > 0.999)) directions.push(w)
  }
  const variants: Variant[] = []
  const consider = (kind: string, planes: Plane[]) => {
    const variant = cutBack(kind, planes, extent, options.tolerance)
    if (variant) variants.push(variant)
  }
  for (const w of directions) {
    const helper: Vec3 = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const u = normalize(cross(helper, w))
    const frame: Frame = { u, v: cross(w, u), w }
    const along = points.map((p) => dot(p, w))
    const [from, to] = thick(Math.min(...along), Math.max(...along))
    const outline = hull(points.map((p): Vec2 => [dot(p, frame.u), dot(p, frame.v)]))
    if (outline.length < 3) continue
    // The least rectangle, found in a frame turned to its sides.
    const angle = leastRectangle(outline)
    const [c, s] = [Math.cos(angle), Math.sin(angle)]
    const turned = outline.map((p): Vec2 => [c * p[0] + s * p[1], -s * p[0] + c * p[1]])
    const [lu, hu] = thick(
      Math.min(...turned.map((p) => p[0])),
      Math.max(...turned.map((p) => p[0])),
    )
    const [lv, hv] = thick(
      Math.min(...turned.map((p) => p[1])),
      Math.max(...turned.map((p) => p[1])),
    )
    const rectangle = (
      [
        [lu, lv],
        [hu, lv],
        [hu, hv],
        [lu, hv],
      ] as Vec2[]
    ).map(([x, y]): Vec2 => [c * x - s * y, s * x + c * y])
    consider('box', prism(frame, rectangle, from, to))
    const tried = new Set<number>()
    for (const corners of options.sides) {
      const reduced = corners >= outline.length ? outline : reduceOutline(outline, corners)
      if (reduced.length <= 4 || tried.has(reduced.length)) continue
      tried.add(reduced.length)
      consider(`prism ${reduced.length}`, prism(frame, reduced, from, to))
    }
    // The circle fitted to the outline's edge, sampled evenly along it.
    const perimeter = outline.reduce((sum, a, k) => {
      const b = outline[(k + 1) % outline.length]!
      return sum + Math.hypot(b[0] - a[0], b[1] - a[1])
    }, 0)
    const edge = outline.flatMap((a, k) => {
      const b = outline[(k + 1) % outline.length]!
      const steps = Math.max(1, Math.round((64 * Math.hypot(b[0] - a[0], b[1] - a[1])) / perimeter))
      return Array.from({ length: steps }, (_, i): Vec2 => [
        a[0] + ((b[0] - a[0]) * i) / steps,
        a[1] + ((b[1] - a[1]) * i) / steps,
      ])
    })
    const circle = fitCircle(edge)
    if (circle) {
      for (const sides of options.sides) {
        if (sides < 6) continue
        const ring = polygon(circle.centre, equalArea(circle.radius, sides), sides)
        consider(`cylinder ${sides}`, prism(frame, ring, from, to))
      }
    }
  }
  // A piece too small for any: it goes, or merges into a larger one's.
  if (!variants.length) return []

  // Volume overlap with the piece, on a grid of cubes spanning it and every primitive.
  const span = variants.reduce(
    (b, v) => ({
      lo: [0, 1, 2].map((k) => Math.min(b.lo[k]!, v.lo[k]!)) as Vec3,
      hi: [0, 1, 2].map((k) => Math.max(b.hi[k]!, v.hi[k]!)) as Vec3,
    }),
    { lo: piece.lo, hi: piece.hi },
  )
  const longest = Math.max(...[0, 1, 2].map((k) => span.hi[k]! - span.lo[k]!))
  const grid = voxelsOver(span.lo, span.hi, Math.max(longest / LOCAL_CUBES, 0.004), 1)
  const solid = solidOf(own, grid)
  const filled = solid.reduce((s, x) => s + x, 0)
  const scored = variants.map((v) => {
    const cells = cellsOf(grid, v.primitive.planes, v.primitive.hole, v)
    let both = 0
    for (const i of cells) both += solid[i]!
    return { v, iou: both / (filled + cells.length - both) }
  })
  const boxes = scored.filter((s) => s.v.kind === 'box')
  const best = scored.reduce((a, b) =>
    b.iou - options.price * b.v.triangles > a.iou - options.price * a.v.triangles ? b : a,
  )
  if (!boxes.length) return [best.v]
  const box = boxes.reduce((a, b) => (b.iou > a.iou ? b : a))
  return best.v === box.v ? [best.v] : [best.v, box.v]
}

/**
 * A span at least {@link MIN_THICKNESS} across, widened about its middle: a flat piece (a plate,
 * a sheet of foil) is drawn as a thin slab.
 */
function thick(lo: number, hi: number): [number, number] {
  const pad = Math.max(0, (MIN_THICKNESS - (hi - lo)) / 2)
  return [lo - pad, hi + pad]
}

/**
 * A prism's solid, cut back to the part's extent on each side it reaches more than `tolerance`
 * past; nothing if the result is not a closed solid wound outward with every triangle at least
 * {@link MIN_AREA}.
 */
function cutBack(
  kind: string,
  planes: Plane[],
  extent: { lo: Vec3; hi: Vec3 },
  tolerance: number,
): Variant | undefined {
  let solid = convex(planes)
  if (!solid) return undefined
  const reach = boundsOf(trianglesOf(solid))
  const cuts: Plane[] = []
  for (let k = 0; k < 3; k++) {
    const n: Vec3 = [0, 0, 0]
    n[k] = 1
    if (reach.hi[k]! > extent.hi[k]! + tolerance) cuts.push({ n, d: extent.hi[k]! })
    if (reach.lo[k]! < extent.lo[k]! - tolerance) cuts.push({ n: scale(n, -1), d: -extent.lo[k]! })
  }
  const all = [...planes, ...cuts]
  if (cuts.length) solid = convex(all)
  if (!solid) return undefined
  if (!isSound(solid)) return undefined
  const { lo, hi } = boundsOf(trianglesOf(solid))
  return { kind, primitive: { solid, planes: all }, triangles: triangleCount(solid), lo, hi }
}

/**
 * Whether a solid is closed, wound outward, draws no triangle under {@link MIN_AREA} and has no
 * edge under {@link MIN_EDGE}.
 */
function isSound(solid: Solid): boolean {
  const health = surfaceHealth(trianglesOf(solid))
  const short = solid.faces.some((face) =>
    face.some((v, k) => {
      const [a, b] = [solid.vertices[v]!, solid.vertices[face[(k + 1) % face.length]!]!]
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < MIN_EDGE
    }),
  )
  return !health.open && health.least > 0 && health.smallest >= MIN_AREA && !short
}

// ---------------------------------------------------------------------------------------------
// Cubes

/**
 * A grid of cubes of `cell` over a box, `margin` cubes more all round; with `snap`, its cubes
 * are some of that grid's.
 */
function voxelsOver(lo: Vec3, hi: Vec3, cell: number, margin: number, snap?: Voxels): Voxels {
  const base = snap?.origin ?? [0, 0, 0]
  const origin = [0, 1, 2].map(
    (k) => base[k]! + (Math.floor((lo[k]! - base[k]!) / cell) - margin) * cell,
  ) as Vec3
  const n = [0, 1, 2].map((k) => Math.ceil((hi[k]! - origin[k]!) / cell) + margin) as [
    number,
    number,
    number,
  ]
  return { origin, cell, n }
}

function forCells(grid: Voxels, visit: (i: number, x: number, y: number, z: number) => void) {
  const [nx, ny, nz] = grid.n
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) visit(x + nx * (y + ny * z), x, y, z)
    }
  }
}

/** The index in `outer` of cube (x, y, z) of `inner`, a grid snapped to it. */
function indexIn(outer: Voxels, inner: Voxels, x: number, y: number, z: number): number {
  const at = [x, y, z].map((q, k) =>
    Math.round((inner.origin[k]! - outer.origin[k]!) / outer.cell + q),
  )
  return at[0]! + outer.n[0] * (at[1]! + outer.n[1] * at[2]!)
}

/**
 * The cubes flat triangles fill: those a triangle passes through, and those with a triangle
 * along at least five of the six axis directions from them (inside, or in a hollow open on one
 * side only, as a box open underneath).
 */
function solidOf(triangles: ArrayLike<number>, grid: Voxels): Uint8Array {
  const [nx, ny, nz] = grid.n
  const marked = new Uint8Array(nx * ny * nz)
  const [ox, oy, oz] = grid.origin
  const mark = (px: number, py: number, pz: number) => {
    const x = Math.floor((px - ox) / grid.cell)
    const y = Math.floor((py - oy) / grid.cell)
    const z = Math.floor((pz - oz) / grid.cell)
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return
    marked[x + nx * (y + ny * z)] = 1
  }
  for (let t = 0; t < triangles.length; t += 9) {
    const a = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!]
    const b = [triangles[t + 3]!, triangles[t + 4]!, triangles[t + 5]!]
    const c = [triangles[t + 6]!, triangles[t + 7]!, triangles[t + 8]!]
    const edge = Math.max(
      Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!),
      Math.hypot(c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!),
      Math.hypot(c[0]! - b[0]!, c[1]! - b[1]!, c[2]! - b[2]!),
    )
    // Samples closer than half a cube: no cube a triangle crosses is missed.
    const n = Math.max(1, Math.ceil((2 * edge) / grid.cell))
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const [s, r] = [i / n, j / n]
        mark(
          a[0]! + s * (b[0]! - a[0]!) + r * (c[0]! - a[0]!),
          a[1]! + s * (b[1]! - a[1]!) + r * (c[1]! - a[1]!),
          a[2]! + s * (b[2]! - a[2]!) + r * (c[2]! - a[2]!),
        )
      }
    }
  }
  // Per cube, how many of the six directions from it meet a marked cube.
  const blocked = new Uint8Array(marked.length)
  const strides = [1, nx, nx * ny]
  for (let axis = 0; axis < 3; axis++) {
    const stride = strides[axis]!
    const length = grid.n[axis]!
    // Each line along the axis, from its first cube: the other two axes' cubes.
    const [a, b] = [0, 1, 2].filter((k) => k !== axis) as [number, number]
    for (let j = 0; j < grid.n[b]!; j++) {
      for (let i = 0; i < grid.n[a]!; i++) {
        const start = i * strides[a]! + j * strides[b]!
        let seen = 0
        for (let q = 0; q < length; q++) {
          const c = start + q * stride
          blocked[c]! += seen
          if (marked[c]) seen = 1
        }
        seen = 0
        for (let q = length - 1; q >= 0; q--) {
          const c = start + q * stride
          blocked[c]! += seen
          if (marked[c]) seen = 1
        }
      }
    }
  }
  const solid = new Uint8Array(marked.length)
  for (let i = 0; i < solid.length; i++) solid[i] = marked[i] || blocked[i]! >= 5 ? 1 : 0
  return solid
}

/**
 * The cubes a region touches, within `bounds`: those whose centre lies inside every plane pushed
 * out by half a cube, and not inside the hole pulled in by as much.
 */
function cellsOf(
  grid: Voxels,
  planes: Plane[],
  hole: Plane[] | undefined,
  bounds: { lo: Vec3; hi: Vec3 },
): Int32Array {
  const h = grid.cell / 2
  const slack = (n: Vec3) => h * (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]))
  const outer = planes.map((p) => ({ n: p.n, d: p.d + slack(p.n) }))
  const inner = hole?.map((p) => ({ n: p.n, d: p.d - slack(p.n) }))
  const [nx, ny] = grid.n
  const range = [0, 1, 2].map((k) => [
    Math.max(0, Math.floor((bounds.lo[k]! - grid.origin[k]!) / grid.cell) - 1),
    Math.min(grid.n[k]! - 1, Math.floor((bounds.hi[k]! - grid.origin[k]!) / grid.cell) + 1),
  ])
  const cells: number[] = []
  // Along each row of cubes, the planes bound x to one interval: the cubes are those within it,
  // less those within the hole's.
  const across = (list: Plane[], py: number, pz: number, strict: boolean) => {
    let [lo, hi] = [-Infinity, Infinity]
    for (const { n, d } of list) {
      const rest = d - n[1] * py - n[2] * pz
      if (Math.abs(n[0]) < 1e-12) {
        if (strict ? rest <= 0 : rest < 0) return undefined
        continue
      }
      const at = (rest / n[0] - grid.origin[0]) / grid.cell - 0.5
      if (n[0] > 0) hi = Math.min(hi, strict ? Math.ceil(at) - 1 : Math.floor(at))
      else lo = Math.max(lo, strict ? Math.floor(at) + 1 : Math.ceil(at))
    }
    return lo <= hi ? [lo, hi] : undefined
  }
  for (let z = range[2]![0]!; z <= range[2]![1]!; z++) {
    const pz = grid.origin[2] + (z + 0.5) * grid.cell
    for (let y = range[1]![0]!; y <= range[1]![1]!; y++) {
      const py = grid.origin[1] + (y + 0.5) * grid.cell
      const span = across(outer, py, pz, false)
      if (!span) continue
      const hole = inner && across(inner, py, pz, true)
      const from = Math.max(span[0]!, range[0]![0]!)
      const to = Math.min(span[1]!, range[0]![1]!)
      for (let x = from; x <= to; x++) {
        if (hole && x >= hole[0]! && x <= hole[1]!) continue
        cells.push(x + nx * (y + ny * z))
      }
    }
  }
  return Int32Array.from(cells)
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** The pixels flat triangles cover in a grid, each once. */
function pixelsOf(triangles: Float32Array, grid: Grid): Int32Array {
  const seen = new Set<number>()
  for (let t = 0; t < triangles.length; t += 9) {
    const corners = [0, 3, 6].map((k) => toPixels(grid, triangles.subarray(t + k, t + k + 3)))
    forPixels(grid, corners, (i) => seen.add(i))
  }
  return Int32Array.from(seen)
}

function boundsOf(values: ArrayLike<number>): { lo: Vec3; hi: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity]
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < values.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, values[i + k]!)
      hi[k] = Math.max(hi[k]!, values[i + k]!)
    }
  }
  return { lo, hi }
}

function movedTriangles(triangles: Float32Array, pose: { r: number[]; t: Vec3 }): Float32Array {
  const { r, t } = pose
  const out = new Float32Array(triangles.length)
  for (let i = 0; i < triangles.length; i += 3) {
    const [x, y, z] = [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!]
    out[i] = r[0]! * x + r[1]! * y + r[2]! * z + t[0]
    out[i + 1] = r[3]! * x + r[4]! * y + r[5]! * z + t[1]
    out[i + 2] = r[6]! * x + r[7]! * y + r[8]! * z + t[2]
  }
  return out
}

/** The listed triangles, flat. */
function gather(triangles: Float32Array, list: Int32Array): Float32Array {
  const out = new Float32Array(9 * list.length)
  list.forEach((t, k) => out.set(triangles.subarray(9 * t, 9 * t + 9), 9 * k))
  return out
}

function concatInt(a: Int32Array, b: Int32Array): Int32Array {
  const out = new Int32Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a))
