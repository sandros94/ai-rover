import type { Document, Material, Node as GltfNode } from '@gltf-transform/core'
import type { Clearcoat, Transmission } from '@gltf-transform/extensions'
import type { Mat3, Vec3 } from './urdf'

/**
 * NASA's Blender export is y up with the rover facing +z and its left towards +x; the app's body
 * frame is x forward, y left, z up. A proper rotation: app = (z, x, y).
 */
export const NASA_AXES: Mat3 = [0, 0, 1, 1, 0, 0, 0, 1, 0]

/**
 * Poses the animated nodes at `time` seconds, as a player would: linear keys interpolated
 * (rotations renormalised), step keys held. With `only`, the channels of other nodes are left.
 */
export function sampleAnimations(doc: Document, time: number, only?: Set<GltfNode>): void {
  for (const animation of doc.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const node = channel.getTargetNode()
      const sampler = channel.getSampler()
      const path = channel.getTargetPath()
      if (!node || !sampler || !path || (only && !only.has(node))) continue
      const times = sampler.getInput()!.getArray()!
      const output = sampler.getOutput()!
      const size = output.getElementSize()
      const values = output.getArray()!
      let k = 0
      while (k < times.length - 1 && times[k + 1]! <= time) k++
      const next = Math.min(k + 1, times.length - 1)
      const f =
        next === k || sampler.getInterpolation() === 'STEP'
          ? 0
          : Math.min(1, Math.max(0, (time - times[k]!) / (times[next]! - times[k]!)))
      const v = Array.from(
        { length: size },
        (_, i) => values[k * size + i]! * (1 - f) + values[next * size + i]! * f,
      )
      if (path === 'rotation') {
        const n = Math.hypot(...v)
        node.setRotation(v.map((x) => x / n) as [number, number, number, number])
      } else if (path === 'translation') node.setTranslation(v as Vec3)
      else if (path === 'scale') node.setScale(v as Vec3)
    }
  }
}

/** Every key time of the document's animations, ascending, without repeats. */
export function keyTimes(doc: Document): number[] {
  const times = new Set<number>()
  for (const animation of doc.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      for (const t of channel.getSampler()?.getInput()?.getArray() ?? []) times.add(t)
    }
  }
  return [...times].sort((a, b) => a - b)
}

/**
 * The middle of the longest stretch of the animations during which `node` holds still at its
 * highest (its world origin's y, NASA's up): the remote sensing mast deployed, in the export's
 * deploy-and-stow loop. Only the channels of `animated` are played.
 */
export function highestHold(doc: Document, node: GltfNode, animated: Set<GltfNode>): number {
  const times = keyTimes(doc)
  const frames = times.map((time) => {
    sampleAnimations(doc, time, animated)
    return Array.from(node.getWorldMatrix())
  })
  const top = Math.max(...frames.map((m) => m[13]!))
  const still = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-5)
  let best = { from: 0, to: -1, length: -1 }
  for (let i = 0; i < frames.length;) {
    if (top - frames[i]![13]! > 1e-3) {
      i++
      continue
    }
    let j = i
    while (j + 1 < frames.length && still(frames[j + 1]!, frames[i]!)) j++
    if (times[j]! - times[i]! > best.length)
      best = { from: i, to: j, length: times[j]! - times[i]! }
    i = j + 1
  }
  if (best.to < 0) throw new Error('highestHold: the node never reaches a still top.')
  return (times[best.from]! + times[best.to]!) / 2
}

/**
 * Glass drawn by blending instead of transmission. three.js renders transmission with a second
 * pass of the whole opaque scene into a texture each frame, the terrain included; on a phone that
 * doubles the frame's cost for a few lenses. A clear, glossy, mostly see-through surface over what
 * lies behind it reads the same at the sizes the lenses are drawn.
 */
export function glassAsBlend(material: Material, opacity: number): boolean {
  const transmission = material.getExtension<Transmission>('KHR_materials_transmission')
  if (!transmission) return false
  const [r, g, b, a] = material.getBaseColorFactor()
  // Full transmission is `opacity`; none keeps the colour's own alpha.
  const alpha = a * (1 - transmission.getTransmissionFactor() * (1 - opacity))
  material
    .setBaseColorFactor([r, g, b, alpha])
    .setAlphaMode('BLEND')
    .setExtension('KHR_materials_transmission', null)
  // A clearcoat of weight 0 changes nothing but still selects the heavier shader.
  const clearcoat = material.getExtension<Clearcoat>('KHR_materials_clearcoat')
  if (clearcoat && clearcoat.getClearcoatFactor() === 0) {
    material.setExtension('KHR_materials_clearcoat', null)
  }
  return true
}

// ---------------------------------------------------------------------------------------------
// Assigning geometry to links

/** Point clouds by name, indexed on a uniform grid for nearest-point queries. */
export class PointIndex {
  private readonly cells = new Map<string, { cloud: number; p: Vec3 }[]>()

  constructor(
    readonly names: readonly string[],
    clouds: readonly (readonly Vec3[])[],
    private readonly cell: number,
  ) {
    clouds.forEach((points, cloud) => {
      for (const p of points) {
        const key = this.key(p)
        let bucket = this.cells.get(key)
        if (!bucket) this.cells.set(key, (bucket = []))
        bucket.push({ cloud, p })
      }
    })
  }

  private key(p: Vec3): string {
    return `${Math.floor(p[0] / this.cell)},${Math.floor(p[1] / this.cell)},${Math.floor(p[2] / this.cell)}`
  }

  /** The cloud with a point nearest `p`, within `reach` (at most two cells), or −1. */
  nearest(p: Vec3, reach: number): number {
    const span = Math.ceil(reach / this.cell)
    const c = p.map((x) => Math.floor(x / this.cell))
    let best = { cloud: -1, d: reach }
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        for (let dz = -span; dz <= span; dz++) {
          for (const q of this.cells.get(`${c[0]! + dx},${c[1]! + dy},${c[2]! + dz}`) ?? []) {
            const d = Math.hypot(p[0] - q.p[0], p[1] - q.p[1], p[2] - q.p[2])
            if (d < best.d) best = { cloud: q.cloud, d }
          }
        }
      }
    }
    return best.cloud
  }
}

/**
 * Connected pieces of an indexed triangle list: triangles sharing a vertex, or a vertex position
 * (the export splits vertices along UV and normal seams), belong to one piece. Returns each
 * triangle's piece, numbered from 0 in order of first appearance.
 */
export function pieces(positions: ArrayLike<number>, indices: ArrayLike<number>): Uint32Array {
  const count = positions.length / 3
  const parent = Int32Array.from({ length: count }, (_, i) => i)
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!
    return a
  }
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)]
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const byPosition = new Map<string, number>()
  for (let v = 0; v < count; v++) {
    const key = `${positions[3 * v]},${positions[3 * v + 1]},${positions[3 * v + 2]}`
    const first = byPosition.get(key)
    if (first === undefined) byPosition.set(key, v)
    else union(v, first)
  }
  for (let t = 0; t < indices.length; t += 3) {
    union(indices[t]!, indices[t + 1]!)
    union(indices[t]!, indices[t + 2]!)
  }
  const numbering = new Map<number, number>()
  const out = new Uint32Array(indices.length / 3)
  for (let t = 0; t < out.length; t++) {
    const root = find(indices[3 * t]!)
    let id = numbering.get(root)
    if (id === undefined) numbering.set(root, (id = numbering.size))
    out[t] = id
  }
  return out
}

/**
 * Each piece's link: the cloud most of its vertices lie within `reach` of, or −1 when fewer than
 * `quorum` of them lie near any. A piece moves as one, so it is never split between links.
 */
export function assignPieces(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  piece: Uint32Array,
  index: PointIndex,
  options: { reach: number; quorum: number },
): Int32Array {
  const pieceCount = piece.reduce((m, p) => Math.max(m, p + 1), 0)
  const votes = Array.from({ length: pieceCount }, () => new Map<number, number>())
  const seen = Array.from({ length: pieceCount }, () => new Set<number>())
  for (let t = 0; t < piece.length; t++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[3 * t + k]!
      if (seen[piece[t]!]!.has(v)) continue
      seen[piece[t]!]!.add(v)
      const cloud = index.nearest(
        [positions[3 * v]!, positions[3 * v + 1]!, positions[3 * v + 2]!],
        options.reach,
      )
      const tally = votes[piece[t]!]!
      tally.set(cloud, (tally.get(cloud) ?? 0) + 1)
    }
  }
  return Int32Array.from(votes, (tally, p) => {
    const total = seen[p]!.size
    let best = { cloud: -1, n: 0 }
    for (const [cloud, n] of tally) if (cloud >= 0 && n > best.n) best = { cloud, n }
    return best.n >= options.quorum * total ? best.cloud : -1
  })
}

/**
 * Which moving part a piece of the differential's linkage belongs to, from its centre and the
 * rocker pivot on its side (app frame): the rod runs aft from the crank's top to the bar's end,
 * high above the pivot; everything else (the crank, its bolts and pins, the hub's outer
 * fittings) turns with the rocker.
 */
export function linkagePart(centre: Vec3, pivot: Vec3): 'rod' | 'rocker' {
  const high = centre[2] - pivot[2] > LINKAGE.rodAbovePivot
  const aft = centre[0] < pivot[0] - LINKAGE.crankHalfWidth
  return high && aft ? 'rod' : 'rocker'
}

/**
 * The linkage's layout in NASA's model: the rod's pieces lie 24 to 31 cm above the rocker pivot
 * and centred at least 2.5 cm aft of it; the crank's top fittings are centred within 1 cm of it.
 */
const LINKAGE = { rodAbovePivot: 0.2, crankHalfWidth: 0.02 }
