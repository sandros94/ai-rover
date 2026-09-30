import { describe, expect, it } from 'vitest'
import { Document } from '@gltf-transform/core'
import { KHRMaterialsClearcoat, KHRMaterialsTransmission } from '@gltf-transform/extensions'
import { fitRigid } from '~~/scripts/rover-model/fit'
import {
  assignPieces,
  glassAsBlend,
  highestHold,
  linkagePart,
  pieces,
  PointIndex,
  sampleAnimations,
} from '~~/scripts/rover-model/nasa'
import type { Vec3 } from '~~/scripts/rover-model/urdf'
import { aboutAxis, apply } from '~~/scripts/rover-model/urdf'

describe('fitRigid', () => {
  it('recovers a rotation and translation from matching points, with no residual', () => {
    const from: Vec3[] = [
      [1.1, 1.06, 0.26],
      [1.1, -1.06, 0.26],
      [-0.09, 1.18, 0.26],
      [-0.09, -1.18, 0.26],
      [-1.17, 1.06, 0.26],
      [-1.17, -1.06, 0.26],
      [0.8, -0.5, 1.9],
    ]
    const r = aboutAxis([0.2, 0.3, 0.93].map((x) => x / Math.hypot(0.2, 0.3, 0.93)) as Vec3, 0.4)
    const t: Vec3 = [0.09, -0.02, 0.001]
    const to = from.map((p) => apply(r, p).map((x, k) => x + t[k]!) as Vec3)
    const fit = fitRigid(from, to)
    fit.r.forEach((x, k) => expect(x).toBeCloseTo(r[k]!, 9))
    fit.t.forEach((x, k) => expect(x).toBeCloseTo(t[k]!, 9))
    expect(Math.max(...fit.residuals)).toBeLessThan(1e-9)
  })

  it('reports each pair it cannot match as a residual', () => {
    const from: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    const to = from.map((p, k) => (k === 3 ? ([0, 0, 1.004] as Vec3) : p))
    const { residuals } = fitRigid(from, to)
    expect(Math.max(...residuals)).toBeGreaterThan(1e-3)
    expect(Math.max(...residuals)).toBeLessThan(4e-3)
  })

  it('refuses fewer than three pairs', () => {
    expect(() => fitRigid([[0, 0, 0]], [[0, 0, 0]])).toThrow(/3 or more pairs/)
  })
})

describe('pieces', () => {
  it('joins triangles sharing a vertex or a vertex position, and nothing else', () => {
    // Triangles 0 and 1 share vertex 1; triangle 2 repeats vertex 2's position (a UV seam);
    // triangle 3 stands apart.
    const positions = [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 2, 2, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5,
    ]
    const indices = [0, 1, 2, 1, 3, 2, 4, 5, 3, 6, 7, 8]
    expect([...pieces(positions, indices)]).toEqual([0, 0, 0, 1])
  })
})

describe('assignPieces', () => {
  const index = new PointIndex(
    ['near', 'far'],
    [
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      [[10, 0, 0]],
    ],
    0.5,
  )

  it('gives a piece the cloud most of its vertices lie on, or none without a quorum', () => {
    const positions = [0, 0, 0.1, 1, 0, 0.1, 0.5, 3, 0, 10, 0.1, 0, 10, 0.2, 0, 13, 0, 0]
    const indices = [0, 1, 2, 3, 4, 5]
    const piece = pieces(positions, indices)
    const reach = { reach: 0.5, quorum: 0.6 }
    expect([...assignPieces(positions, indices, piece, index, reach)]).toEqual([0, 1])
    const strict = { reach: 0.5, quorum: 0.7 }
    expect([...assignPieces(positions, indices, piece, index, strict)]).toEqual([-1, -1])
  })
})

describe('linkagePart', () => {
  const pivot: Vec3 = [0.304, 0.8, 0.893]

  it('puts the rod, high and aft of the pivot, on its own node', () => {
    expect(linkagePart([0.2, 0.64, 1.17], pivot)).toBe('rod')
    expect(linkagePart([0.02, 0.64, 1.165], pivot)).toBe('rod')
  })

  it('leaves the crank, its top fittings and its bolts on the rocker', () => {
    expect(linkagePart([0.304, 0.64, 1.06], pivot)).toBe('rocker')
    expect(linkagePart([0.31, 0.64, 1.16], pivot)).toBe('rocker')
    expect(linkagePart([0.304, 0.66, 1.0], pivot)).toBe('rocker')
  })
})

describe('glassAsBlend', () => {
  it('draws transmissive glass blended at the given opacity, without the transmission pass', () => {
    const doc = new Document()
    const transmission = doc.createExtension(KHRMaterialsTransmission)
    const clearcoat = doc.createExtension(KHRMaterialsClearcoat)
    const lens = doc
      .createMaterial('glass lens')
      .setBaseColorFactor([0.455, 0.672, 0.502, 1])
      .setExtension(
        'KHR_materials_transmission',
        transmission.createTransmission().setTransmissionFactor(1),
      )
      .setExtension('KHR_materials_clearcoat', clearcoat.createClearcoat().setClearcoatFactor(0))
    expect(glassAsBlend(lens, 0.3)).toBe(true)
    expect(lens.getAlphaMode()).toBe('BLEND')
    expect(lens.getBaseColorFactor()).toEqual([0.455, 0.672, 0.502, expect.closeTo(0.3, 9)])
    expect(lens.getExtension('KHR_materials_transmission')).toBeNull()
    expect(lens.getExtension('KHR_materials_clearcoat')).toBeNull()
  })

  it('leaves opaque materials alone', () => {
    const doc = new Document()
    const paint = doc.createMaterial('paint').setBaseColorFactor([0.65, 0.65, 0.69, 1])
    expect(glassAsBlend(paint, 0.3)).toBe(false)
    expect(paint.getAlphaMode()).toBe('OPAQUE')
  })
})

describe('the export animations', () => {
  /** A mast that rises over 2 s, holds from 2 s to 6 s, and folds back by 8 s. */
  function mastDocument() {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const mast = doc.createNode('mast')
    const head = doc.createNode('head').setTranslation([0, 1, 0])
    mast.addChild(head)
    const arm = doc.createNode('arm')
    doc.createScene().addChild(mast).addChild(arm)
    const times = doc
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Float32Array([0, 2, 6, 8]))
      .setBuffer(buffer)
    const s = Math.SQRT1_2
    // Lying along +z (a quarter turn about x), then upright; the arm slides along x meanwhile.
    const tracks = [
      {
        node: mast,
        path: 'rotation',
        type: 'VEC4',
        values: [s, 0, 0, s, 0, 0, 0, 1, 0, 0, 0, 1, s, 0, 0, s],
      },
      {
        node: arm,
        path: 'translation',
        type: 'VEC3',
        values: [0, 0, 0, 1, 0, 0, 3, 0, 0, 5, 0, 0],
      },
    ] as const
    const animation = doc.createAnimation('deploy')
    for (const { node, path, type, values } of tracks) {
      const output = doc
        .createAccessor()
        .setType(type)
        .setArray(new Float32Array(values))
        .setBuffer(buffer)
      const sampler = doc
        .createAnimationSampler()
        .setInput(times)
        .setOutput(output)
        .setInterpolation('LINEAR')
      const channel = doc
        .createAnimationChannel()
        .setTargetNode(node)
        .setTargetPath(path)
        .setSampler(sampler)
      animation.addSampler(sampler).addChannel(channel)
    }
    return { doc, mast, head, arm }
  }

  it('poses nodes between keys, only the listed ones when asked', () => {
    const { doc, mast, arm } = mastDocument()
    sampleAnimations(doc, 1)
    expect(arm.getTranslation()[0]).toBeCloseTo(0.5, 6)
    sampleAnimations(doc, 4, new Set([mast]))
    expect(arm.getTranslation()[0]).toBeCloseTo(0.5, 6)
    expect(mast.getRotation()).toEqual([0, 0, 0, 1])
  })

  it('finds the middle of the stretch the head holds still at its top', () => {
    const { doc, mast, head } = mastDocument()
    expect(highestHold(doc, head, new Set([mast, head]))).toBe(4)
  })
})
