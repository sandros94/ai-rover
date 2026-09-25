import type { GridCell } from '../terrain/grid'
import { NavError } from './errors'
import { traceSegment } from './trace'

/**
 * Why a route was not found. Closed set: callers may match on it exhaustively, so adding a
 * reason is a breaking change.
 */
export type RouteFailureReason =
  | 'goal-unreachable'
  | 'expansion-cap'
  | 'start-blocked'
  | 'goal-blocked'

export interface RouteOptions {
  /** Most vertices the search may expand before giving up. Default: the grid's vertex count. */
  maxExpansions?: number
}

export interface RouteResult {
  reached: boolean
  /** Set exactly when `reached` is false. */
  failureReason?: RouteFailureReason
  /** Grid vertices from start to goal, each in line of sight of the next; empty when not reached. */
  waypoints: GridCell[]
  expansions: number
}

/**
 * Any-angle route over a cost grid by Theta*: A* on the 8-connected vertex grid where a vertex
 * may take its grandparent as parent when the straight segment between them is cheaper.
 *
 * A segment costs its length (in cells) times the length-weighted mean cost of the vertex cells
 * it crosses, and is blocked if it crosses or touches an `Infinity` cell. Every finite cost must
 * be at least 1, which keeps the euclidean heuristic admissible. Ties break on (f, h, index), so
 * equal inputs give equal routes.
 */
export function findRoute(
  costMap: Float32Array,
  options: { width: number; height: number; start: GridCell; goal: GridCell } & RouteOptions,
): RouteResult {
  const { width, height, start, goal } = options
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new NavError(
      'INVALID_INPUT',
      `findRoute: grid size is ${width}×${height}; pass positive integer width and height.`,
    )
  }
  const size = width * height
  if (costMap.length !== size) {
    throw new NavError(
      'INVALID_INPUT',
      `findRoute: costMap holds ${costMap.length} values but the grid is ${width}×${height} (${size}); pass one cost per vertex.`,
    )
  }
  for (let k = 0; k < size; k++) {
    if (!(costMap[k]! >= 1)) {
      throw new NavError(
        'INVALID_INPUT',
        `findRoute: costMap[${k}] is ${costMap[k]}; pass costs of at least 1, or Infinity for impassable.`,
      )
    }
  }
  assertCell(start, width, height, 'start')
  assertCell(goal, width, height, 'goal')
  const maxExpansions = options.maxExpansions ?? size
  if (!Number.isInteger(maxExpansions) || maxExpansions < 1) {
    throw new NavError(
      'INVALID_INPUT',
      `findRoute: maxExpansions is ${maxExpansions}; pass a positive integer.`,
    )
  }

  const s = start.j * width + start.i
  const t = goal.j * width + goal.i
  if (costMap[s] === Infinity) return failure('start-blocked', 0)
  if (costMap[t] === Infinity) return failure('goal-blocked', 0)

  const g = new Float64Array(size).fill(Infinity)
  const parent = new Int32Array(size).fill(-1)
  const closed = new Uint8Array(size)
  const open = new OpenSet()
  const heuristic = (k: number): number => {
    const i = k % width
    return Math.hypot(i - goal.i, (k - i) / width - goal.j)
  }
  const segmentCost = (a: number, b: number): number => {
    let sum = 0
    const clear = traceSegment(width, a, b, (k, weight) => {
      const cost = costMap[k]!
      if (cost === Infinity) return false
      sum += cost * weight
      return true
    })
    if (!clear) return Infinity
    const ai = a % width
    const bi = b % width
    return sum * Math.hypot(bi - ai, (b - bi) / width - (a - ai) / width)
  }

  g[s] = 0
  parent[s] = s
  open.push(heuristic(s), heuristic(s), s)
  let expansions = 0
  while (open.size > 0) {
    const k = open.pop()
    if (closed[k]) continue
    if (k === t) return { reached: true, waypoints: waypointsTo(parent, t, width), expansions }
    if (expansions === maxExpansions) return failure('expansion-cap', expansions)
    closed[k] = 1
    expansions++
    const i = k % width
    const j = (k - i) / width
    const up = parent[k]!
    for (let dj = -1; dj <= 1; dj++) {
      const nj = j + dj
      if (nj < 0 || nj >= height) continue
      for (let di = -1; di <= 1; di++) {
        const ni = i + di
        if ((di === 0 && dj === 0) || ni < 0 || ni >= width) continue
        const n = nj * width + ni
        if (closed[n] || costMap[n] === Infinity) continue
        let best = g[k]! + segmentCost(k, n)
        let from = k
        if (up !== k) {
          const shortcut = g[up]! + segmentCost(up, n)
          if (shortcut <= best) {
            best = shortcut
            from = up
          }
        }
        if (best < g[n]!) {
          g[n] = best
          parent[n] = from
          const h = heuristic(n)
          open.push(best + h, h, n)
        }
      }
    }
  }
  return failure('goal-unreachable', expansions)
}

function failure(reason: RouteFailureReason, expansions: number): RouteResult {
  return { reached: false, failureReason: reason, waypoints: [], expansions }
}

function waypointsTo(parent: Int32Array, goal: number, width: number): GridCell[] {
  const out: GridCell[] = []
  let k = goal
  for (;;) {
    const i = k % width
    out.push({ i, j: (k - i) / width })
    const up = parent[k]!
    if (up === k) break
    k = up
  }
  return out.reverse()
}

function assertCell(cell: GridCell, width: number, height: number, name: string): void {
  const { i, j } = cell
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= width || j >= height) {
    throw new NavError(
      'INVALID_INPUT',
      `findRoute: ${name} (${i}, ${j}) is outside the ${width}×${height} grid; pass integers with 0 ≤ i < ${width} and 0 ≤ j < ${height}.`,
    )
  }
}

/**
 * Binary min-heap of vertex indices keyed by (f, h, index). Stale entries are left in place and
 * skipped by the caller once the vertex is closed.
 */
class OpenSet {
  size = 0
  private f = new Float64Array(1024)
  private h = new Float64Array(1024)
  private k = new Int32Array(1024)

  push(f: number, h: number, k: number): void {
    if (this.size === this.k.length) this.grow()
    let at = this.size++
    while (at > 0) {
      const up = (at - 1) >> 1
      if (!before(f, h, k, this.f[up]!, this.h[up]!, this.k[up]!)) break
      this.move(up, at)
      at = up
    }
    this.f[at] = f
    this.h[at] = h
    this.k[at] = k
  }

  pop(): number {
    const top = this.k[0]!
    const last = --this.size
    if (last > 0) {
      const f = this.f[last]!
      const h = this.h[last]!
      const k = this.k[last]!
      let at = 0
      for (;;) {
        let child = 2 * at + 1
        if (child >= last) break
        const right = child + 1
        if (
          right < last &&
          before(
            this.f[right]!,
            this.h[right]!,
            this.k[right]!,
            this.f[child]!,
            this.h[child]!,
            this.k[child]!,
          )
        )
          child = right
        if (!before(this.f[child]!, this.h[child]!, this.k[child]!, f, h, k)) break
        this.move(child, at)
        at = child
      }
      this.f[at] = f
      this.h[at] = h
      this.k[at] = k
    }
    return top
  }

  private move(from: number, to: number): void {
    this.f[to] = this.f[from]!
    this.h[to] = this.h[from]!
    this.k[to] = this.k[from]!
  }

  private grow(): void {
    const f = new Float64Array(this.k.length * 2)
    const h = new Float64Array(this.k.length * 2)
    const k = new Int32Array(this.k.length * 2)
    f.set(this.f)
    h.set(this.h)
    k.set(this.k)
    this.f = f
    this.h = h
    this.k = k
  }
}

function before(f: number, h: number, k: number, f2: number, h2: number, k2: number): boolean {
  return f < f2 || (f === f2 && (h < h2 || (h === h2 && k < k2)))
}
