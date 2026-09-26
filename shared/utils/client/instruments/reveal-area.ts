/** A reveal group as records and slices carry it: newly seen vertices at sim time `t`. */
export interface RevealGroup {
  t: number
  vertices: { length: number }
}

/** Square metres newly seen up to sim time `t`: one cell of `cellSize` per vertex. */
export function revealedAreaM2(
  reveals: readonly RevealGroup[],
  t: number,
  cellSize: number,
): number {
  let vertices = 0
  for (const group of reveals) if (group.t <= t) vertices += group.vertices.length
  return vertices * cellSize * cellSize
}

/**
 * Square metres revealed per minute in consecutive bins of `binS` sim seconds from 0, the last
 * bin ending at `t` (partial); at least one bin.
 */
export function revealRate(
  reveals: readonly RevealGroup[],
  t: number,
  cellSize: number,
  options: { binS?: number } = {},
): number[] {
  const { binS = 60 } = options
  const bins = Array.from({ length: Math.max(1, Math.ceil(t / binS)) }, () => 0)
  const perMinute = (cellSize * cellSize * 60) / binS
  for (const group of reveals) {
    if (group.t > t) continue
    const k = Math.min(bins.length - 1, Math.floor(group.t / binS))
    bins[k]! += group.vertices.length * perMinute
  }
  return bins
}
