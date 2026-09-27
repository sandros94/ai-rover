import type { HeightGrid } from '../terrain/grid'
import { ClientError } from './errors'

/**
 * The fog over a stop disk: which vertices the rover has revealed, when, and what each view
 * draws in place of ground not yet revealed. Vertex `k` of a grid `width` wide is (i, j) with
 * `k = j · width + i`.
 */

/** A rectangle of grid vertices, `i0 ≤ i < i1`, `j0 ≤ j < j1`. */
export interface GridRect {
  i0: number
  j0: number
  i1: number
  j1: number
}

/** How long freshly revealed ground takes to fade in, milliseconds. */
export const REVEAL_FADE_MS = 600
/** Width, in cells, of the soft band where fog meets revealed ground. */
export const FOG_EDGE_CELLS = 2
/** The 3D fog surface follows the revealed ground within this distance, metres. */
export const FOG_HEIGHT_RADIUS_M = 24

export interface FogState {
  /** One byte per vertex, 1 where revealed. */
  seen: Uint8Array
  /**
   * When each vertex was revealed, milliseconds on the clock of `now`: -Infinity long ago, NaN
   * not revealed (see {@link revealTimes}). Absent means every seen vertex is settled.
   */
  revealedAt?: Float64Array
  now?: number
}

/** Reveal times for `seen` with nothing fading: -Infinity where seen, NaN elsewhere. */
export function revealTimes(seen: Uint8Array): Float64Array {
  const times = new Float64Array(seen.length)
  for (let k = 0; k < seen.length; k++) times[k] = seen[k] ? -Infinity : Number.NaN
  return times
}

/**
 * Brings `times` in line with `seen`, in place: vertices newly revealed are stamped `now`,
 * vertices no longer seen (a seek back) are fogged again at once. Returns the rectangle holding
 * every change, or undefined when nothing changed.
 */
export function updateRevealTimes(
  times: Float64Array,
  seen: Uint8Array,
  now: number,
  width: number,
): GridRect | undefined {
  if (times.length !== seen.length) {
    throw new ClientError(
      'INVALID_INPUT',
      `updateRevealTimes: ${times.length} times for ${seen.length} seen flags; pass one per vertex.`,
    )
  }
  let rect: GridRect | undefined
  for (let k = 0; k < seen.length; k++) {
    const shown = !Number.isNaN(times[k]!)
    if (shown === !!seen[k]) continue
    times[k] = shown ? Number.NaN : now
    const i = k % width
    const j = (k - i) / width
    if (!rect) rect = { i0: i, j0: j, i1: i + 1, j1: j + 1 }
    else {
      rect.i0 = Math.min(rect.i0, i)
      rect.i1 = Math.max(rect.i1, i + 1)
      rect.j1 = j + 1
    }
  }
  return rect
}

/** The smallest rectangle holding both; `b` alone when `a` is absent. */
export function unionRect(a: GridRect | undefined, b: GridRect): GridRect {
  if (!a) return { ...b }
  return {
    i0: Math.min(a.i0, b.i0),
    j0: Math.min(a.j0, b.j0),
    i1: Math.max(a.i1, b.i1),
    j1: Math.max(a.j1, b.j1),
  }
}

/** `rect` grown by `by` vertices each way, clamped to a `width` × `height` grid. */
export function expandRect(
  rect: GridRect,
  by: number,
  size: { width: number; height: number },
): GridRect {
  return {
    i0: Math.max(0, rect.i0 - by),
    j0: Math.max(0, rect.j0 - by),
    i1: Math.min(size.width, rect.i1 + by),
    j1: Math.min(size.height, rect.j1 + by),
  }
}

/** Share of the fade vertex `k` has completed: 0 unseen or just revealed, 1 settled. */
export function revealProgress(fog: FogState, k: number, fadeMs = REVEAL_FADE_MS): number {
  if (!fog.seen[k]) return 0
  const at = fog.revealedAt?.[k]
  if (at === undefined || at === -Infinity || Number.isNaN(at)) return 1
  return Math.min(1, Math.max(0, ((fog.now ?? Infinity) - at) / fadeMs))
}

/**
 * How much fog covers each vertex of `rect` (default the whole grid), 0 clear to 1 hidden, as a
 * rect-sized array row by row: 1 where unseen; on seen ground the larger of the fade still to
 * run and a soft edge falling to 0 over {@link FOG_EDGE_CELLS} cells from the nearest unseen
 * vertex. The edge lies on the revealed side, so no unseen vertex is ever partly shown.
 *
 * With `inside` (one byte per vertex, 1 within the survey), vertices beyond the survey are no
 * ground at all: they carry no fog (0) and seen ground beside them has no soft edge.
 */
export function fogCover(
  fog: FogState,
  size: { width: number; height: number },
  options: { rect?: GridRect; edgeCells?: number; fadeMs?: number; inside?: Uint8Array } = {},
): Float32Array {
  const { width, height } = size
  checkSeen(fog.seen, width, height, 'fogCover')
  const { edgeCells = FOG_EDGE_CELLS, fadeMs = REVEAL_FADE_MS, inside } = options
  if (inside) checkSeen(inside, width, height, 'fogCover')
  const rect = options.rect ?? { i0: 0, j0: 0, i1: width, j1: height }
  const reach = edgeCells + 1
  const outer = expandRect(rect, reach, size)
  const distance = distanceTo(fog.seen, width, outer, reach, 0, inside)
  const outerWidth = outer.i1 - outer.i0
  const rectWidth = rect.i1 - rect.i0
  const cover = new Float32Array(rectWidth * (rect.j1 - rect.j0))
  for (let j = rect.j0; j < rect.j1; j++) {
    for (let i = rect.i0; i < rect.i1; i++) {
      const k = j * width + i
      const o = (j - rect.j0) * rectWidth + (i - rect.i0)
      if (inside && !inside[k]) continue
      if (!fog.seen[k]) {
        cover[o] = 1
        continue
      }
      const d = distance[(j - outer.j0) * outerWidth + (i - outer.i0)]!
      const edge = 1 - smoothstep(0, reach, d)
      cover[o] = Math.max(edge, 1 - revealProgress(fog, k, fadeMs))
    }
  }
  return cover
}

/** What the 3D scene draws per disk vertex. */
export interface FogSurface {
  /** Height drawn: the true height where revealed, the fog surface elsewhere, eased between during a reveal. */
  heights: Float32Array
  /** Fog colour share, 0 relief to 1 fog. */
  amount: Float32Array
}

/**
 * The surface the 3D scene draws for a disk. Revealed vertices sit at their true height in the
 * relief colours. Unseen vertices take the fog colour at the mean height of revealed vertices
 * within `radiusM` (a square window; `fallback`, default the mean of every revealed vertex, where
 * the window holds none), and within {@link FOG_EDGE_CELLS} cells of revealed ground ease from
 * the mean of the revealed vertices next to them towards it, so the frontier has no cliff and
 * never shows an unseen height. A vertex still fading in is drawn that share of the way from its
 * fog height to its true one.
 *
 * With `changed` and `into`, only the vertices a change inside `changed` can move are rewritten,
 * in place; `rect` in the result says which.
 */
export function fogSurface(
  grid: HeightGrid,
  fog: FogState,
  options: {
    radiusM?: number
    edgeCells?: number
    fadeMs?: number
    fallback?: number
    changed?: GridRect
    into?: FogSurface
  } = {},
): FogSurface & { rect: GridRect } {
  const { width, height, heights, cellSize } = grid
  checkSeen(fog.seen, width, height, 'fogSurface')
  const {
    radiusM = FOG_HEIGHT_RADIUS_M,
    edgeCells = FOG_EDGE_CELLS,
    fadeMs = REVEAL_FADE_MS,
    into,
  } = options
  const size = { width, height }
  const radius = Math.max(1, Math.round(radiusM / cellSize))
  const band = edgeCells + 1
  const full = { i0: 0, j0: 0, i1: width, j1: height }
  const rect = options.changed ? expandRect(options.changed, Math.max(radius, band), size) : full
  const fallback = options.fallback ?? revealedMean(heights, fog.seen)
  const out = into ?? {
    heights: new Float32Array(width * height),
    amount: new Float32Array(width * height),
  }

  const windowRect = expandRect(rect, Math.max(radius, band), size)
  const sums = windowSums(heights, fog.seen, width, windowRect)
  const bandRect = expandRect(rect, band, size)
  const distance = distanceTo(fog.seen, width, bandRect, band, 1)
  const bandWidth = bandRect.i1 - bandRect.i0
  const meanAround = (i: number, j: number, r: number): number | undefined =>
    sums.mean(
      Math.max(i - r, 0),
      Math.max(j - r, 0),
      Math.min(i + r + 1, width),
      Math.min(j + r + 1, height),
    )

  for (let j = rect.j0; j < rect.j1; j++) {
    for (let i = rect.i0; i < rect.i1; i++) {
      const k = j * width + i
      const h = heights[k]!
      if (Number.isNaN(h)) {
        out.heights[k] = h
        out.amount[k] = 0
        continue
      }
      const progress = revealProgress(fog, k, fadeMs)
      if (progress >= 1) {
        out.heights[k] = h
        out.amount[k] = 0
        continue
      }
      const fogHeight = meanAround(i, j, radius) ?? fallback
      if (fog.seen[k]) {
        out.heights[k] = fogHeight + (h - fogHeight) * progress
        out.amount[k] = 1 - progress
        continue
      }
      const d = distance[(j - bandRect.j0) * bandWidth + (i - bandRect.i0)]!
      const w = smoothstep(0, band, d)
      const near = w < 1 ? meanAround(i, j, band) : undefined
      out.heights[k] = near === undefined ? fogHeight : near + (fogHeight - near) * w
      out.amount[k] = 1
    }
  }
  return { heights: out.heights, amount: out.amount, rect }
}

function checkSeen(seen: Uint8Array, width: number, height: number, caller: string): void {
  if (seen.length !== width * height) {
    throw new ClientError(
      'INVALID_INPUT',
      `${caller}: seen holds ${seen.length} values but the grid is ${width}×${height} (${width * height}); pass one byte per vertex.`,
    )
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function revealedMean(heights: Float32Array, seen: Uint8Array): number {
  let sum = 0
  let count = 0
  for (let k = 0; k < heights.length; k++) {
    const h = heights[k]!
    if (seen[k] && !Number.isNaN(h)) {
      sum += h
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

/**
 * Summed-area tables of revealed heights and their count over `rect`; `mean` answers for any
 * sub-rectangle [i0, i1) × [j0, j1) inside it, undefined when it holds no revealed vertex.
 */
function windowSums(heights: Float32Array, seen: Uint8Array, width: number, rect: GridRect) {
  const w = rect.i1 - rect.i0 + 1
  const h = rect.j1 - rect.j0 + 1
  const sum = new Float64Array(w * h)
  const count = new Float64Array(w * h)
  for (let j = rect.j0; j < rect.j1; j++) {
    let rowSum = 0
    let rowCount = 0
    const row = (j - rect.j0 + 1) * w
    for (let i = rect.i0; i < rect.i1; i++) {
      const k = j * width + i
      const v = heights[k]!
      if (seen[k] && !Number.isNaN(v)) {
        rowSum += v
        rowCount++
      }
      const o = row + (i - rect.i0 + 1)
      sum[o] = sum[o - w]! + rowSum
      count[o] = count[o - w]! + rowCount
    }
  }
  const at = (table: Float64Array, i: number, j: number) =>
    table[(j - rect.j0) * w + (i - rect.i0)]!
  const box = (table: Float64Array, i0: number, j0: number, i1: number, j1: number) =>
    at(table, i1, j1) - at(table, i0, j1) - at(table, i1, j0) + at(table, i0, j0)
  return {
    mean(i0: number, j0: number, i1: number, j1: number): number | undefined {
      const n = box(count, i0, j0, i1, j1)
      return n > 0.5 ? box(sum, i0, j0, i1, j1) / n : undefined
    },
  }
}

/**
 * Chamfer distance, in cells, from each vertex of `rect` to the nearest vertex whose seen flag
 * equals `target`, capped at `cap`; rect-sized, row by row. Vertices outside `rect` count as
 * not being targets, so pad `rect` by `cap` around the area whose distances matter. With
 * `inside`, a vertex beyond the survey counts as seen.
 */
function distanceTo(
  seen: Uint8Array,
  width: number,
  rect: GridRect,
  cap: number,
  target: 0 | 1,
  inside?: Uint8Array,
): Float32Array {
  const w = rect.i1 - rect.i0
  const h = rect.j1 - rect.j0
  const d = new Float32Array(w * h)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = (rect.j0 + j) * width + rect.i0 + i
      const flag = seen[k] || (inside && !inside[k]) ? 1 : 0
      d[j * w + i] = flag === target ? 0 : cap
    }
  }
  const diagonal = Math.SQRT2
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = j * w + i
      let v = d[o]!
      if (v === 0) continue
      if (i > 0) v = Math.min(v, d[o - 1]! + 1)
      if (j > 0) {
        v = Math.min(v, d[o - w]! + 1)
        if (i > 0) v = Math.min(v, d[o - w - 1]! + diagonal)
        if (i < w - 1) v = Math.min(v, d[o - w + 1]! + diagonal)
      }
      d[o] = v
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const o = j * w + i
      let v = d[o]!
      if (v === 0) continue
      if (i < w - 1) v = Math.min(v, d[o + 1]! + 1)
      if (j < h - 1) {
        v = Math.min(v, d[o + w]! + 1)
        if (i < w - 1) v = Math.min(v, d[o + w + 1]! + diagonal)
        if (i > 0) v = Math.min(v, d[o + w - 1]! + diagonal)
      }
      d[o] = Math.min(v, cap)
    }
  }
  return d
}

/**
 * Bilinear height of a disk-grid height field at world point (x, y): what overlays that cross
 * fogged ground are draped on, so they follow the surface drawn rather than the ground hidden.
 * Undefined off the grid or where a corner has no height.
 */
export function gridHeightAt(
  heights: Float32Array,
  grid: { width: number; height: number; cellSize: number; origin: { i: number; j: number } },
  x: number,
  y: number,
): number | undefined {
  const { width, height, cellSize, origin } = grid
  const fi = x / cellSize - origin.i
  const fj = y / cellSize - origin.j
  if (!(fi >= 0 && fj >= 0 && fi <= width - 1 && fj <= height - 1)) return undefined
  const i = Math.min(Math.floor(fi), width - 2)
  const j = Math.min(Math.floor(fj), height - 2)
  const u = fi - i
  const v = fj - j
  const k = j * width + i
  let h = 0
  // A corner with no weight is skipped, so a missing height there does not spoil the rest.
  for (const [corner, weight] of [
    [k, (1 - u) * (1 - v)],
    [k + 1, u * (1 - v)],
    [k + width, (1 - u) * v],
    [k + width + 1, u * v],
  ] as const) {
    if (weight > 0) h += heights[corner]! * weight
  }
  return Number.isNaN(h) ? undefined : h
}
