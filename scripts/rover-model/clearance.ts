import type { Document, Node as GltfNode } from '@gltf-transform/core'

/**
 * Clearance between parts of the built rover model, measured on bounding volumes of its own
 * geometry: each node's triangles are bucketed into cubes of {@link CELL} metres in the node's
 * frame, and each bucket's vertices bound a box. Posed, a box's corners bound it again along the
 * body axes, so measured gaps are never larger than the true ones, and at most a cell's diagonal
 * smaller.
 */
export const CELL = 0.05

type Vec3 = [number, number, number]

/** A box along the body frame's axes. */
export interface Box {
  min: Vec3
  max: Vec3
}

/** Each node's boxes in its own frame, by node name: the joint node its mesh child hangs from. */
export function boundingVolumes(doc: Document): Map<string, Box[]> {
  const out = new Map<string, Box[]>()
  for (const meshNode of doc.getRoot().listNodes()) {
    const mesh = meshNode.getMesh()
    const owner = meshNode.getParentNode()
    if (!mesh || !owner) continue
    // The mesh child's own transform (quantization's scale and offset) into the owner's frame.
    const local = meshNode.getMatrix()
    const cells = new Map<string, Box>()
    const v: number[] = [0, 0, 0]
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION')!
      const indices = primitive.getIndices()!
      for (let i = 0; i < indices.getCount(); i += 3) {
        const corners = [0, 1, 2].map((k) => {
          position.getElement(indices.getScalar(i + k), v)
          return transform(local, v as Vec3)
        })
        const centre = [0, 1, 2].map(
          (a) => (corners[0]![a]! + corners[1]![a]! + corners[2]![a]!) / 3,
        )
        const key = centre.map((c) => Math.floor(c / CELL)).join(',')
        let box = cells.get(key)
        if (!box) cells.set(key, (box = { min: [...corners[0]!], max: [...corners[0]!] }))
        for (const p of corners) grow(box, p)
      }
    }
    out.set(owner.getName(), [...(out.get(owner.getName()) ?? []), ...cells.values()])
  }
  return out
}

/** Joint nodes' rest rotations, kept the first time each is posed. */
const rests = new WeakMap<GltfNode, [number, number, number, number]>()

/**
 * Turns the model's joint nodes to `values` (radians by node name, the URDF joint value), each
 * about its `extras.axis` from the rest its `extras.baked` value sits at; others stay at rest.
 */
export function poseModel(doc: Document, values: Readonly<Record<string, number>>): void {
  for (const node of doc.getRoot().listNodes()) {
    const extras = node.getExtras() as { joint?: string; axis?: Vec3; baked?: number }
    if (!extras.joint || !extras.axis) continue
    let rest = rests.get(node)
    if (!rest) rests.set(node, (rest = node.getRotation()))
    const value = values[node.getName()]
    const turn = value === undefined ? 0 : value - (extras.baked ?? 0)
    node.setRotation(multiply(rest, axisAngle(extras.axis, turn)))
  }
}

/** A node's boxes in the body frame (the model's root), at the model's current pose. */
export function posedBoxes(doc: Document, volumes: Map<string, Box[]>, name: string): Box[] {
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === name)
  if (!node) throw new Error(`clearance: the model has no node ${name}.`)
  const m = bodyMatrix(node)
  return (volumes.get(name) ?? []).map(({ min, max }) => {
    const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    for (let c = 0; c < 8; c++) {
      grow(
        box,
        transform(m, [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]]),
      )
    }
    return box
  })
}

/** The smallest gap between any box of `a` and any of `b`, metres; 0 where they touch. */
export function gap(a: Box[], b: Box[]): number {
  let best = Infinity
  for (const p of a) {
    for (const q of b) {
      const d = Math.hypot(
        ...[0, 1, 2].map((k) => Math.max(0, p.min[k]! - q.max[k]!, q.min[k]! - p.max[k]!)),
      )
      if (d < best) best = d
    }
  }
  return best
}

/** A point of `node`'s frame, and a direction, in the body frame at the current pose. */
export function bodyPoint(node: GltfNode, point: Vec3, direction?: Vec3) {
  const m = bodyMatrix(node)
  const at = transform(m, point)
  if (!direction) return { at }
  const tip = transform(m, [
    point[0] + direction[0],
    point[1] + direction[1],
    point[2] + direction[2],
  ])
  return { at, direction: [tip[0] - at[0], tip[1] - at[1], tip[2] - at[2]] as Vec3 }
}

/** The node's matrix into the body frame: the model's root, the chassis, sits at the origin. */
function bodyMatrix(node: GltfNode): ArrayLike<number> {
  return node.getWorldMatrix()
}

function transform(m: ArrayLike<number>, [x, y, z]: Vec3): Vec3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ]
}

function grow(box: Box, p: Vec3): void {
  for (let k = 0; k < 3; k++) {
    box.min[k] = Math.min(box.min[k]!, p[k]!)
    box.max[k] = Math.max(box.max[k]!, p[k]!)
  }
}

function axisAngle([x, y, z]: Vec3, angle: number): [number, number, number, number] {
  const l = Math.hypot(x, y, z)
  const s = Math.sin(angle / 2) / l
  return [x * s, y * s, z * s, Math.cos(angle / 2)]
}

function multiply(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

/**
 * Boxes on a uniform grid of `cell` metres, for the gap from other boxes up to `reach`: gaps
 * beyond it are reported as `reach`.
 */
export class BoxIndex {
  private readonly cells = new Map<string, Box[]>()

  constructor(
    boxes: Box[],
    private readonly cell = 0.1,
  ) {
    for (const box of boxes) {
      const lo = box.min.map((c) => Math.floor(c / cell))
      const hi = box.max.map((c) => Math.floor(c / cell))
      for (let x = lo[0]!; x <= hi[0]!; x++) {
        for (let y = lo[1]!; y <= hi[1]!; y++) {
          for (let z = lo[2]!; z <= hi[2]!; z++) {
            const key = `${x},${y},${z}`
            let list = this.cells.get(key)
            if (!list) this.cells.set(key, (list = []))
            list.push(box)
          }
        }
      }
    }
  }

  /** The smallest gap between `boxes` and the indexed ones, at most `reach`. */
  gap(boxes: Box[], reach: number): number {
    let best = reach
    for (const box of boxes) {
      const lo = box.min.map((c) => Math.floor((c - reach) / this.cell))
      const hi = box.max.map((c) => Math.floor((c + reach) / this.cell))
      for (let x = lo[0]!; x <= hi[0]!; x++) {
        for (let y = lo[1]!; y <= hi[1]!; y++) {
          for (let z = lo[2]!; z <= hi[2]!; z++) {
            const near = this.cells.get(`${x},${y},${z}`)
            if (near) best = Math.min(best, gap([box], near))
          }
        }
      }
    }
    return best
  }
}
