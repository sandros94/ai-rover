import { beforeAll, describe, expect, it } from 'vitest'
import type { Document, Node as GltfNode } from '@gltf-transform/core'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import { surfaceHealth } from '~~/scripts/rover-model/ghost'
import {
  boundsDelta,
  boundsOf,
  partTriangles,
  SILHOUETTE_VIEWS,
  silhouetteIoU,
} from '~~/scripts/rover-model/silhouette'

/** Tests run from the repository root. */
const MODELS = {
  full: 'public/models/rover/rover.glb',
  ghost: 'public/models/rover/rover-ghost.glb',
}

let full: Document
let ghost: Document

beforeAll(async () => {
  await MeshoptDecoder.ready
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  ;[full, ghost] = await Promise.all([io.read(MODELS.full), io.read(MODELS.ghost)])
})

/** The model's named nodes that are not a mesh's holder: its joints, rods and anchors. */
const rigNodes = (doc: Document) =>
  doc
    .getRoot()
    .listNodes()
    .filter((n) => !n.getMesh())

const concat = (parts: Map<string, Float32Array>) => {
  const all = [...parts.values()]
  const out = new Float32Array(all.reduce((s, a) => s + a.length, 0))
  let offset = 0
  for (const a of all) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

describe('the ghost model', () => {
  it("carries the full model's joint nodes: names, parents, extras and transforms within 1 mm", () => {
    const ghostNodes = new Map(rigNodes(ghost).map((n) => [n.getName(), n]))
    const nodes = rigNodes(full)
    expect([...ghostNodes.keys()].sort()).toEqual(nodes.map((n) => n.getName()).sort())
    const summary = (node: GltfNode) => ({
      name: node.getName(),
      parent: node.getParentNode()?.getName(),
      extras: node.getExtras(),
    })
    expect(nodes.map((n) => summary(ghostNodes.get(n.getName())!))).toEqual(nodes.map(summary))
    // Each node's placement in the body frame: rotation entries within a thousandth, the origin
    // within a millimetre.
    const apart = nodes.flatMap((node) => {
      const [a, b] = [node.getWorldMatrix(), ghostNodes.get(node.getName())!.getWorldMatrix()]
      const off = Math.max(...Array.from(a, (x, k) => Math.abs(x - b[k]!)))
      return off < 1e-3 ? [] : [{ node: node.getName(), off }]
    })
    expect(apart).toEqual([])
  })

  it('draws 2 000 triangles at most, in one untextured material', () => {
    const triangles = [...partTriangles(ghost).values()].reduce((s, t) => s + t.length / 9, 0)
    expect(triangles).toBeLessThanOrEqual(2_000)
    const materials = ghost.getRoot().listMaterials()
    expect(materials.map((m) => m.getName())).toEqual(['ghost'])
    expect(materials[0]!.getBaseColorTexture()).toBeNull()
  })

  it("matches the full model's silhouette to an IoU of 0.85 from each of six views", () => {
    const [a, b] = [concat(partTriangles(full)), concat(partTriangles(ghost))]
    const below = SILHOUETTE_VIEWS.flatMap(({ name, look }) => {
      const iou = silhouetteIoU(a, b, look)
      return iou >= 0.85 ? [] : [{ name, iou }]
    })
    expect(below).toEqual([])
  })

  it("keeps each part within 2 cm of the full part's extent, in the part's own frame", () => {
    const ghostParts = partTriangles(ghost, 'part')
    const fullParts = partTriangles(full, 'part')
    expect([...ghostParts.keys()].sort()).toEqual([...fullParts.keys()].sort())
    const off = [...fullParts].flatMap(([name, triangles]) => {
      const delta = boundsDelta(boundsOf(triangles), boundsOf(ghostParts.get(name)!))
      return delta < 0.02 ? [] : [{ name, delta }]
    })
    expect(off).toEqual([])
  })
  it('draws every part as closed surfaces wound outward, none of its triangles under 1 mm²', () => {
    const unsound = [...partTriangles(ghost)].flatMap(([name, triangles]) => {
      const { open, least, smallest } = surfaceHealth(triangles)
      return !open && least > 0 && smallest >= 1e-6 ? [] : [{ name, open, least, smallest }]
    })
    expect(unsound).toEqual([])
  })

  it("carries flat normals: each vertex its triangle's, facing the way it is wound", () => {
    const off = ghost
      .getRoot()
      .listMeshes()
      .flatMap((mesh) =>
        mesh.listPrimitives().flatMap((primitive): { mesh: string; worst?: number }[] => {
          const position = primitive.getAttribute('POSITION')!
          const normal = primitive.getAttribute('NORMAL')
          if (!normal) return [{ mesh: mesh.getName() }]
          const indices = primitive.getIndices()!
          const [a, b, c, n]: [number[], number[], number[], number[]] = [[], [], [], []]
          let worst = 1
          for (let t = 0; t < indices.getCount(); t += 3) {
            const corners = [0, 1, 2].map((k) => indices.getScalar(t + k))
            position.getElement(corners[0]!, a)
            position.getElement(corners[1]!, b)
            position.getElement(corners[2]!, c)
            const e = [0, 1, 2].map((k) => b[k]! - a[k]!)
            const f = [0, 1, 2].map((k) => c[k]! - a[k]!)
            const face = [
              e[1]! * f[2]! - e[2]! * f[1]!,
              e[2]! * f[0]! - e[0]! * f[2]!,
              e[0]! * f[1]! - e[1]! * f[0]!,
            ]
            const length = Math.hypot(...face)
            for (const v of corners) {
              normal.getElement(v, n)
              const cosine = (face[0]! * n[0]! + face[1]! * n[1]! + face[2]! * n[2]!) / length
              worst = Math.min(worst, cosine / Math.hypot(...n))
            }
          }
          return worst > 0.99 ? [] : [{ mesh: mesh.getName(), worst }]
        }),
      )
    expect(off).toEqual([])
  })
})
