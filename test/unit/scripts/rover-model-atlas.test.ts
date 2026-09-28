import { describe, expect, it } from 'vitest'
import type { Material, Texture } from '@gltf-transform/core'
import { Document } from '@gltf-transform/core'
import { KHRMaterialsIOR, KHRMaterialsSpecular } from '@gltf-transform/extensions'
import sharp from 'sharp'
import type { Surface } from '~~/scripts/rover-model/atlas'
import { bakeAtlases } from '~~/scripts/rover-model/atlas'

/** The colours of a 16×16 texture's four 8×8 quadrants, row by row. */
const QUADRANTS = [
  [200, 40, 40],
  [40, 200, 40],
  [40, 40, 200],
  [200, 200, 40],
]

/** A texture of {@link QUADRANTS}, as PNG: flat blocks, which lossy coding keeps. */
async function quadrants(doc: Document, name: string): Promise<Texture> {
  const data = new Uint8Array(16 * 16 * 3)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) data.set(QUADRANTS[2 * (y >> 3) + (x >> 3)]!, 3 * (16 * y + x))
  }
  const png = await sharp(data, { raw: { width: 16, height: 16, channels: 3 } })
    .png()
    .toBuffer()
  return doc.createTexture(name).setImage(new Uint8Array(png)).setMimeType('image/png')
}

/** One triangle of `node` under `material`, with the given UVs. */
function triangle(node: string, material: Material, uvs?: number[]): Surface {
  return {
    node,
    material,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    ...(uvs && { uvs: new Float32Array(uvs) }),
    indices: new Uint32Array([0, 1, 2]),
  }
}

async function pixels(texture: Texture) {
  const { data, info } = await sharp(texture.getImage()!)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    width: info.width,
    height: info.height,
    at: (u: number, v: number) => {
      const i = 4 * (Math.floor(v * info.height) * info.width + Math.floor(u * info.width))
      return [...data.subarray(i, i + 4)]
    },
  }
}

describe('bakeAtlases', () => {
  it("draws a node's opaque materials as one, texels copied and factors on a palette", async () => {
    const doc = new Document()
    const textured = doc
      .createMaterial('decal')
      .setBaseColorTexture(await quadrants(doc, 'decal'))
      .setNormalTexture(await quadrants(doc, 'decal bumps'))
      .setMetallicFactor(0)
      .setRoughnessFactor(0.5)
    const metal = doc
      .createMaterial('metal')
      .setBaseColorFactor([1, 0, 0, 1])
      .setMetallicFactor(1)
      .setRoughnessFactor(0.2)
    const uvs = [0.25, 0.25, 0.5, 0.25, 0.25, 0.5]
    const { baked, report } = await bakeAtlases(doc, 'part', [
      triangle('a', textured, uvs),
      triangle('a', metal),
    ])
    expect(baked).toHaveLength(1)
    expect(report.pages).toHaveLength(1)
    const [surface] = baked
    expect(surface!.indices).toHaveLength(6)
    const material = surface!.material
    const base = await pixels(material.getBaseColorTexture()!)
    const mr = await pixels(material.getMetallicRoughnessTexture()!)
    // The decal's corner at UV (0.25, 0.25) samples its texel (4, 4), in the first quadrant.
    const [u, v] = [surface!.uvs[0]!, surface!.uvs[1]!]
    const decal = base.at(u + 0.5 / base.width, v + 0.5 / base.height)
    // Colour is coded lossy; normals near-lossless, within 2 levels, so they show the texel moved.
    decal.slice(0, 3).forEach((c, k) => expect(Math.abs(c - QUADRANTS[0]![k]!)).toBeLessThan(16))
    const normal = await pixels(material.getNormalTexture()!)
    const bump = normal.at(u + 0.5 / base.width, v + 0.5 / base.height)
    bump
      .slice(0, 3)
      .forEach((c, k) => expect(Math.abs(c - QUADRANTS[0]![k]!)).toBeLessThanOrEqual(2))
    // Roughness in green, metalness in blue, at half resolution without a texture to carry.
    expect(mr.width).toBe(base.width / 2)
    expect(mr.at(u, v).slice(1, 3)).toEqual([128, 0])
    // The factor-only triangle: all three corners on one palette block.
    const [pu, pv] = [surface!.uvs[6]!, surface!.uvs[7]!]
    expect([surface!.uvs[8], surface!.uvs[9], surface!.uvs[10], surface!.uvs[11]]).toEqual([
      pu,
      pv,
      pu,
      pv,
    ])
    const red = base.at(pu, pv)
    expect(red[0]).toBeGreaterThan(250)
    expect(red[1]).toBeLessThan(6)
    expect(mr.at(pu, pv).slice(1, 3)).toEqual([51, 255])
  })

  it('draws a triangle whose UVs meet at one point in that point’s colour, from the palette', async () => {
    const doc = new Document()
    const decal = doc.createMaterial('decal').setBaseColorTexture(await quadrants(doc, 'decal'))
    // Texel (12, 12)'s centre, in the last quadrant.
    const point = [12.5 / 16, 12.5 / 16]
    const { baked } = await bakeAtlases(doc, 'part', [
      triangle('a', decal, [...point, ...point, ...point]),
    ])
    const base = await pixels(baked[0]!.material.getBaseColorTexture()!)
    const colour = base.at(baked[0]!.uvs[0]!, baked[0]!.uvs[1]!)
    colour.slice(0, 3).forEach((c, k) => expect(Math.abs(c - QUADRANTS[3]![k]!)).toBeLessThan(16))
  })

  it('keeps blended glass as its own material, one per node, its opacity per texel', async () => {
    const doc = new Document()
    const ior = doc.createExtension(KHRMaterialsIOR)
    const specular = doc.createExtension(KHRMaterialsSpecular)
    const glass = (name: string, alpha: number) =>
      doc
        .createMaterial(name)
        .setAlphaMode('BLEND')
        .setBaseColorFactor([1, 1, 1, alpha])
        .setRoughnessFactor(0)
        .setExtension('KHR_materials_ior', ior.createIOR().setIOR(1.39))
        .setExtension('KHR_materials_specular', specular.createSpecular())
    const paint = doc.createMaterial('paint')
    const { baked } = await bakeAtlases(doc, 'part', [
      triangle('a', paint),
      triangle('a', glass('lens', 0.3)),
      triangle('a', glass('cover', 0.05)),
      triangle('b', glass('lens', 0.3)),
    ])
    const panes = baked.filter((s) => s.material.getAlphaMode() === 'BLEND')
    expect(panes.map((s) => s.node).sort()).toEqual(['a', 'b'])
    expect(new Set(panes.map((s) => s.material)).size).toBe(1)
    const base = await pixels(panes[0]!.material.getBaseColorTexture()!)
    const a = panes.find((s) => s.node === 'a')!
    const alphas = [0, 3].map((k) => base.at(a.uvs[2 * k]!, a.uvs[2 * k + 1]!)[3])
    expect(alphas).toEqual([Math.round(0.3 * 255), Math.round(0.05 * 255)])
    expect(panes[0]!.material.getExtension('KHR_materials_ior')).not.toBeNull()
  })
})
