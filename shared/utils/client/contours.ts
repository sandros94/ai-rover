import type { HeightGrid } from '../terrain/grid'
import type { GridRect } from './fog'

/** Height between contour lines on the 2D map, metres. */
export const CONTOUR_INTERVAL_M = 1
/** Every this many lines one is drawn heavier, as an index contour. */
export const CONTOUR_MAJOR_EVERY = 5

/** The lines at one height: segments as x0, y0, x1, y1 in grid vertex units (i, j). */
export interface ContourLevel {
  height: number
  major: boolean
  segments: number[]
}

/**
 * Contour lines of the grid by marching squares, one {@link ContourLevel} per height that crosses
 * it, lowest first. A vertex at a level counts as above it; saddles are resolved by the mean of
 * the four corners. Cells are drawn only when all four corners have a height and, with `mask`,
 * are non-zero in it; `rect` limits the vertices considered. Neighbouring cells compute a shared
 * edge crossing identically, so a ring's segments meet end to end.
 */
export function contourLines(
  grid: HeightGrid,
  options: {
    interval?: number
    majorEvery?: number
    mask?: Uint8Array
    rect?: GridRect
  } = {},
): ContourLevel[] {
  const { width, height, heights } = grid
  const { interval = CONTOUR_INTERVAL_M, majorEvery = CONTOUR_MAJOR_EVERY, mask } = options
  const rect = options.rect ?? { i0: 0, j0: 0, i1: width, j1: height }
  const byLevel = new Map<number, number[]>()
  const out = (n: number) => {
    let list = byLevel.get(n)
    if (!list) byLevel.set(n, (list = []))
    return list
  }
  const i1 = Math.min(rect.i1, width) - 1
  const j1 = Math.min(rect.j1, height) - 1
  for (let j = Math.max(0, rect.j0); j < j1; j++) {
    for (let i = Math.max(0, rect.i0); i < i1; i++) {
      const k00 = j * width + i
      const k10 = k00 + 1
      const k01 = k00 + width
      const k11 = k01 + 1
      if (mask && !(mask[k00] && mask[k10] && mask[k01] && mask[k11])) continue
      const h00 = heights[k00]!
      const h10 = heights[k10]!
      const h01 = heights[k01]!
      const h11 = heights[k11]!
      const min = Math.min(h00, h10, h01, h11)
      const max = Math.max(h00, h10, h01, h11)
      if (Number.isNaN(min) || Number.isNaN(max)) continue
      for (let n = Math.ceil(min / interval); n * interval <= max; n++) {
        const level = n * interval
        const index =
          (h00 >= level ? 1 : 0) |
          (h10 >= level ? 2 : 0) |
          (h11 >= level ? 4 : 0) |
          (h01 >= level ? 8 : 0)
        if (index === 0 || index === 15) continue
        // Crossings on each edge, always interpolated from the lower-indexed vertex.
        const across = (from: number, to: number) => (level - from) / (to - from)
        const bottom = () => [i + across(h00, h10), j] as const
        const top = () => [i + across(h01, h11), j + 1] as const
        const left = () => [i, j + across(h00, h01)] as const
        const right = () => [i + 1, j + across(h10, h11)] as const
        const list = out(n)
        const line = (a: readonly [number, number], b: readonly [number, number]) =>
          list.push(a[0], a[1], b[0], b[1])
        const centreAbove = (h00 + h10 + h01 + h11) / 4 >= level
        switch (index) {
          case 1:
          case 14:
            line(left(), bottom())
            break
          case 2:
          case 13:
            line(bottom(), right())
            break
          case 3:
          case 12:
            line(left(), right())
            break
          case 4:
          case 11:
            line(right(), top())
            break
          case 6:
          case 9:
            line(bottom(), top())
            break
          case 7:
          case 8:
            line(left(), top())
            break
          case 5:
            if (centreAbove) {
              line(bottom(), right())
              line(top(), left())
            } else {
              line(left(), bottom())
              line(right(), top())
            }
            break
          case 10:
            if (centreAbove) {
              line(left(), bottom())
              line(right(), top())
            } else {
              line(bottom(), right())
              line(top(), left())
            }
            break
        }
      }
    }
  }
  return [...byLevel.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([n, segments]) => ({
      height: n * interval,
      major: n % majorEvery === 0,
      segments,
    }))
}
