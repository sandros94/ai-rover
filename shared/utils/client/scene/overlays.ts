import type { Point3 } from '../../rover/kinematics'

/** A mesh placed at `origin`, its positions relative to it for float32 precision. */
export interface OverlayMesh {
  origin: Point3
  positions: Float32Array
  indices: Uint32Array
}

/**
 * The polyline set on the ground: points added so none lies more than `spacingM` from the
 * next, each at `heightAt`. Where the ground is not loaded the last known height carries on
 * (0 before any is known).
 */
export function drapePath(
  points: readonly { x: number; y: number }[],
  heightAt: (x: number, y: number) => number | undefined,
  options: { spacingM: number },
): Point3[] {
  const out: Point3[] = []
  let z = 0
  const push = (x: number, y: number) => {
    z = heightAt(x, y) ?? z
    out.push({ x, y, z })
  }
  for (let k = 0; k < points.length; k++) {
    const b = points[k]!
    if (k === 0) {
      push(b.x, b.y)
      continue
    }
    const a = points[k - 1]!
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / options.spacingM))
    for (let s = 1; s <= steps; s++) {
      push(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps)
    }
  }
  return out
}

/**
 * A flat strip `widthM` wide along the path, `liftM` above it: a vertex pair per point (left,
 * then right of the direction of travel, averaged over the two neighbouring segments), two
 * triangles per segment in path order, so drawing the first `6k` indices shows the first `k`
 * segments.
 */
export function ribbonMesh(
  points: readonly Point3[],
  options: { widthM: number; liftM: number },
): OverlayMesh {
  const origin = points[0] ?? { x: 0, y: 0, z: 0 }
  const n = points.length
  const positions = new Float32Array(n * 2 * 3)
  const indices = new Uint32Array(Math.max(0, n - 1) * 6)
  const half = options.widthM / 2
  for (let k = 0; k < n; k++) {
    const p = points[k]!
    const before = points[Math.max(0, k - 1)]!
    const after = points[Math.min(n - 1, k + 1)]!
    let dx = after.x - before.x
    let dy = after.y - before.y
    const length = Math.hypot(dx, dy)
    if (length > 0) {
      dx /= length
      dy /= length
    } else {
      dx = 1
      dy = 0
    }
    const x = p.x - origin.x
    const y = p.y - origin.y
    const z = p.z - origin.z + options.liftM
    positions.set([x - dy * half, y + dx * half, z, x + dy * half, y - dx * half, z], k * 6)
  }
  for (let k = 0; k < n - 1; k++) {
    const l0 = 2 * k
    const r0 = l0 + 1
    const l1 = l0 + 2
    const r1 = l0 + 3
    indices.set([l0, r0, r1, l0, r1, l1], k * 6)
  }
  return { origin, positions, indices }
}

/** A disc of `radiusM` around `center` draped on the ground: a fan from the centre, `liftM` above it. */
export function groundDisc(
  center: { x: number; y: number },
  heightAt: (x: number, y: number) => number | undefined,
  options: { radiusM: number; segments: number; liftM: number },
): OverlayMesh {
  const { radiusM, segments, liftM } = options
  const z0 = heightAt(center.x, center.y) ?? 0
  const origin = { x: center.x, y: center.y, z: z0 }
  const positions = new Float32Array((segments + 1) * 3)
  const indices = new Uint32Array(segments * 3)
  positions[2] = liftM
  for (let k = 0; k < segments; k++) {
    const angle = (2 * Math.PI * k) / segments
    const x = radiusM * Math.cos(angle)
    const y = radiusM * Math.sin(angle)
    const z = (heightAt(center.x + x, center.y + y) ?? z0) - z0 + liftM
    positions.set([x, y, z], (k + 1) * 3)
    indices.set([0, k + 1, ((k + 1) % segments) + 1], k * 3)
  }
  return { origin, positions, indices }
}
