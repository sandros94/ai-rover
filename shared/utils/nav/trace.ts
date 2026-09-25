/**
 * Walks the straight segment between two grid vertices through every vertex cell it crosses,
 * cells being the unit squares centred on vertices. `visit(k, weight)` receives the vertex index
 * and the fraction of the segment inside its cell; returning false stops the walk.
 *
 * Where the segment passes exactly through a cell corner, the two side cells it only touches are
 * visited with weight 0, so a line never slips diagonally between two vertices. Crossing order is
 * decided in integer arithmetic, so the walk is exact and identical on every platform.
 *
 * Returns false when `visit` stopped the walk, else true.
 */
export function traceSegment(
  width: number,
  a: number,
  b: number,
  visit: (k: number, weight: number) => boolean,
): boolean {
  const ai = a % width
  const aj = (a - ai) / width
  const bi = b % width
  const bj = (b - bi) / width
  const nx = Math.abs(bi - ai)
  const ny = Math.abs(bj - aj)
  const sx = bi > ai ? 1 : -1
  const sy = bj > aj ? width : -width
  let k = a
  let kx = 0
  let ky = 0
  let t = 0
  while (kx < nx || ky < ny) {
    // The m-th boundary crossing along x happens at t = (2m + 1) / 2nx, likewise along y.
    const order = kx >= nx ? 1 : ky >= ny ? -1 : (2 * kx + 1) * ny - (2 * ky + 1) * nx
    let next: number
    if (order < 0) {
      next = (2 * kx + 1) / (2 * nx)
      if (!visit(k, next - t)) return false
      k += sx
      kx++
    } else if (order > 0) {
      next = (2 * ky + 1) / (2 * ny)
      if (!visit(k, next - t)) return false
      k += sy
      ky++
    } else {
      next = (2 * kx + 1) / (2 * nx)
      if (!visit(k, next - t) || !visit(k + sx, 0) || !visit(k + sy, 0)) return false
      k += sx + sy
      kx++
      ky++
    }
    t = next
  }
  return visit(k, 1 - t)
}
