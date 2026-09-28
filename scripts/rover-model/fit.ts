import type { Mat3, Rigid, Vec3 } from './urdf'
import { add, apply, sub } from './urdf'

/**
 * The rigid motion (rotation and translation, no scale) that carries `from` onto `to` with the
 * least squared error, and each pair's residual distance after it. Horn's closed form: the
 * rotation is the eigenvector of the largest eigenvalue of a 4×4 symmetric matrix built from the
 * centred point sets, read as a unit quaternion.
 */
export function fitRigid(from: Vec3[], to: Vec3[]): Rigid & { residuals: number[] } {
  if (from.length !== to.length || from.length < 3) {
    throw new Error(
      `fitRigid: ${from.length} and ${to.length} points; pass two lists of 3 or more pairs.`,
    )
  }
  const mean = (points: Vec3[]): Vec3 => {
    const sum = points.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3)
    return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length]
  }
  const [ca, cb] = [mean(from), mean(to)]
  // Cross-covariance S[i][j] = Σ a_i b_j over the centred pairs.
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  from.forEach((p, k) => {
    const a = sub(p, ca)
    const b = sub(to[k]!, cb)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[3 * i + j]! += a[i]! * b[j]!
  })
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S as Mat3
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]
  const [w, x, y, z] = largestEigenvector(N)
  const r: Mat3 = [
    w * w + x * x - y * y - z * z,
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    w * w - x * x + y * y - z * z,
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    w * w - x * x - y * y + z * z,
  ]
  const t = sub(cb, apply(r, ca))
  const residuals = from.map((p, k) => {
    const d = sub(add(apply(r, p), t), to[k]!)
    return Math.hypot(d[0], d[1], d[2])
  })
  return { r, t, residuals }
}

/** The unit eigenvector of the largest eigenvalue of a symmetric 4×4 matrix (cyclic Jacobi). */
function largestEigenvector(input: number[][]): [number, number, number, number] {
  const a = input.map((row) => [...row])
  const v: number[][] = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p]![q]! ** 2
    if (off < 1e-30) break
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p]![q]!) < 1e-300) continue
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < 4; k++) {
          const [akp, akq] = [a[k]![p]!, a[k]![q]!]
          a[k]![p] = c * akp - s * akq
          a[k]![q] = s * akp + c * akq
        }
        for (let k = 0; k < 4; k++) {
          const [apk, aqk] = [a[p]![k]!, a[q]![k]!]
          a[p]![k] = c * apk - s * aqk
          a[q]![k] = s * apk + c * aqk
        }
        for (let k = 0; k < 4; k++) {
          const [vkp, vkq] = [v[k]![p]!, v[k]![q]!]
          v[k]![p] = c * vkp - s * vkq
          v[k]![q] = s * vkp + c * vkq
        }
      }
    }
  }
  let best = 0
  for (let i = 1; i < 4; i++) if (a[i]![i]! > a[best]![best]!) best = i
  const e = [v[0]![best]!, v[1]![best]!, v[2]![best]!, v[3]![best]!]
  const n = Math.hypot(...e)
  // One sign of the quaternion, so the result is deterministic.
  const sign = e[0]! < 0 ? -1 : 1
  return e.map((x) => (sign * x) / n) as [number, number, number, number]
}
