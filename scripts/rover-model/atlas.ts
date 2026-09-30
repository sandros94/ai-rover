import type { Document, Material, Texture, TextureInfo } from '@gltf-transform/core'
import type { IOR, Specular } from '@gltf-transform/extensions'
import { KHRMaterialsIOR, KHRMaterialsSpecular } from '@gltf-transform/extensions'
import sharp from 'sharp'

/**
 * Bakes a group of nodes' materials into as few as the renderer must draw separately: every
 * opaque material into atlas pages (one material per page), the blended glass into one material
 * of its own, since blending needs its own draw. A node then draws one primitive per page it
 * uses, plus one for its glass.
 *
 * Opaque materials. A material with textures keeps its texels: the parts of its textures its
 * triangles cover (the islands, each with a margin of the texels around it, taken with the source's
 * repeat wrapping) are copied texel for texel into a page, and its UVs moved by whole texels, so
 * nothing is resampled. Islands and pages are placed on an 8-texel grid congruent with the
 * source's, so the first three mip levels average the same texels as the source's did. A material
 * with factors only becomes a 16×16 block of a palette on every page; its UVs point at the block's
 * centre (constant UVs have no derivatives, so they sample the full-size level at any distance).
 * An island holds what its material would sample there: base colour times its factor, roughness
 * and metalness times theirs, and its normal map with its scale baked in, or a flat normal; the
 * scale is applied before mip filtering rather than after, which only shows on minified surfaces
 * with a strong scale. What cannot be
 * carried per texel is dropped, and printed: the specular and IOR extensions of opaque materials
 * (a few dielectrics with a weaker highlight) would put every page on the physical shader.
 */
export interface Surface {
  /** The app node the triangles belong to. */
  node: string
  material: Material
  positions: Float32Array<ArrayBuffer>
  normals: Float32Array<ArrayBuffer>
  uvs?: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
}

/** A node's triangles under one baked material. */
export interface BakedSurface {
  node: string
  material: Material
  positions: Float32Array<ArrayBuffer>
  normals: Float32Array<ArrayBuffer>
  uvs: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
}

export interface AtlasOptions {
  /** Largest page side, texels. */
  size: number
  /** Texels kept around each island: the bilinear footprint of the first mip levels. */
  margin: number
}

export const ATLAS_OPTIONS: AtlasOptions = { size: 2048, margin: 8 }

/** Placement grid, texels: islands keep their source position modulo this. */
const GRID = 8
/**
 * A palette block's side, texels: one WebP macroblock, so lossy coding never mixes two blocks'
 * colours (its chroma is coded over 8×8 texels).
 */
const BLOCK = 16
/** Distance from a texel centre within which a triangle covers the texel: half its diagonal. */
const COVER = Math.SQRT1_2

export interface AtlasReport {
  pages: { width: number; height: number; islands: number }[]
  /** Opaque material features that cannot be carried per texel, by material. */
  dropped: string[]
}

type Pixels = { data: Uint8Array; width: number; height: number }

/** One opaque material's look, as a function of the texel it samples. */
interface Look {
  material: Material
  /** The texture grid its UVs index, when it has textures. */
  grid?: { key: string; width: number; height: number }
  base?: Pixels
  baseFactor: number[]
  mr?: Pixels
  metal: number
  rough: number
  normal?: Pixels
  normalScale: number
}

/**
 * A rectangle of one look's texture plane (its textures unwrapped by repetition), in texels,
 * placed on a page.
 */
interface Island {
  look: number
  x: number
  y: number
  width: number
  height: number
  page: number
  /** Top-left on the page, texels. */
  at: [number, number]
}

export async function bakeAtlases(
  doc: Document,
  group: string,
  surfaces: Surface[],
  options: AtlasOptions = ATLAS_OPTIONS,
): Promise<{ baked: BakedSurface[]; report: AtlasReport }> {
  const images = new ImageCache()
  const report: AtlasReport = { pages: [], dropped: [] }
  const glass = surfaces.filter((s) => s.material.getAlphaMode() === 'BLEND')
  const opaque = surfaces.filter((s) => s.material.getAlphaMode() !== 'BLEND')
  const baked: BakedSurface[] = []
  if (opaque.length) baked.push(...(await bakeOpaque(doc, group, opaque, images, options, report)))
  if (glass.length) baked.push(...(await bakeGlass(doc, group, glass, images)))
  return { baked, report }
}

// ---------------------------------------------------------------------------------------------
// Opaque pages

async function bakeOpaque(
  doc: Document,
  group: string,
  surfaces: Surface[],
  images: ImageCache,
  options: AtlasOptions,
  report: AtlasReport,
): Promise<BakedSurface[]> {
  // Looks, deduplicated: materials alike in every factor and texture share one.
  const looks: Look[] = []
  const lookOf = new Map<Material, number>()
  const signatures = new Map<string, number>()
  for (const { material } of surfaces) {
    if (lookOf.has(material)) continue
    const look = await describe(material, images, report)
    const signature = JSON.stringify([
      look.grid?.key,
      images.keyOf(look.base),
      look.baseFactor,
      images.keyOf(look.mr),
      look.metal,
      look.rough,
      images.keyOf(look.normal),
      look.normalScale,
    ])
    let index = signatures.get(signature)
    if (index === undefined) {
      index = looks.push(look) - 1
      signatures.set(signature, index)
    }
    lookOf.set(material, index)
  }
  const doubleSided = surfaces.some((s) => s.material.getDoubleSided())

  // Every textured triangle in texels of its grid's plane, moved by whole tiles so its lowest
  // corner falls in the first tile.
  interface Placed {
    surface: Surface
    look: number
    /** Per triangle corner: texel coordinates, or undefined on the palette. */
    texels?: Float64Array
  }
  // Triangles whose three UVs coincide sample one point of their textures: they draw that
  // point's colour, roughness and metalness, and no normal map (their tangent frame is zero, and
  // a frame from interpolation noise would scatter the map's normal over the surface). Each such
  // point becomes a look on the palette.
  const pointLooks = new Map<string, number>()
  const pointLook = (look: number, u: number, v: number) => {
    const point = sampleLook(looks[look]!, u, v)
    const signature = JSON.stringify([point.baseFactor, point.metal, point.rough])
    let index = pointLooks.get(signature)
    if (index === undefined) {
      index = looks.push(point) - 1
      pointLooks.set(signature, index)
    }
    return index
  }
  const placed: Placed[] = []
  for (const surface of surfaces) {
    const look = lookOf.get(surface.material)!
    const grid = looks[look]!.grid
    if (!grid) {
      placed.push({ surface, look })
      continue
    }
    if (!surface.uvs) {
      throw new Error(
        `atlas: ${surface.material.getName()} has textures but ${surface.node} no UVs.`,
      )
    }
    const { indices, uvs } = surface
    const regular: number[] = []
    const points = new Map<string, number[]>()
    for (let t = 0; t < indices.length; t += 3) {
      const corners = [0, 1, 2].map((k) => indices[t + k]!)
      const [a, b, c] = corners.map((i) => `${uvs[2 * i]},${uvs[2 * i + 1]}`)
      if (a === b && b === c) points.set(a!, [...(points.get(a!) ?? []), ...corners])
      else regular.push(...corners)
    }
    for (const [key, list] of points) {
      const [u, v] = key.split(',').map(Number) as [number, number]
      placed.push({
        surface: { ...surface, indices: Uint32Array.from(list) },
        look: pointLook(look, u, v),
      })
    }
    if (!regular.length) continue
    const kept = { ...surface, indices: Uint32Array.from(regular) }
    const texels = new Float64Array(regular.length * 2)
    for (let t = 0; t < regular.length; t += 3) {
      const u = [0, 1, 2].map((k) => uvs[2 * regular[t + k]!]!)
      const v = [0, 1, 2].map((k) => uvs[2 * regular[t + k]! + 1]!)
      const [du, dv] = [Math.floor(Math.min(...u)), Math.floor(Math.min(...v))]
      for (let k = 0; k < 3; k++) {
        texels[2 * (t + k)] = (u[k]! - du) * grid.width
        texels[2 * (t + k) + 1] = (v[k]! - dv) * grid.height
      }
    }
    placed.push({ surface: kept, look, texels })
  }

  // Islands per look: its covered texels, grown by the margin, in connected rectangles. Looks
  // sharing a texture each get their own islands: where their triangles overlap in the texture,
  // each keeps its own metalness, roughness and normals.
  const islands: Island[] = []
  /** Per placed surface, each triangle's island. */
  const islandOf = new Map<Placed, Int32Array>()
  const planes = new Map<number, Placed[]>()
  for (const p of placed) {
    if (p.texels) planes.set(p.look, [...(planes.get(p.look) ?? []), p])
  }
  for (const [look, members] of planes) {
    let [maxX, maxY] = [0, 0]
    for (const { texels } of members) {
      for (let i = 0; i < texels!.length; i += 2) {
        maxX = Math.max(maxX, texels![i]!)
        maxY = Math.max(maxY, texels![i + 1]!)
      }
    }
    // The plane's origin sits `off` texels in, a multiple of the grid, so margins stay inside.
    const off = Math.ceil(options.margin / GRID) * GRID
    const width = Math.ceil((maxX + off + options.margin + 1) / GRID) * GRID
    const height = Math.ceil((maxY + off + options.margin + 1) / GRID) * GRID
    const covered = new Uint8Array(width * height)
    for (const p of members) {
      const { indices } = p.surface
      const texels = p.texels!
      for (let t = 0; t < indices.length; t += 3) {
        const corners = [0, 1, 2].map(
          (k) => [texels[2 * (t + k)]! + off, texels[2 * (t + k) + 1]! + off] as const,
        )
        cover(corners, width, height, (i) => (covered[i] = 1))
      }
    }
    const grown = grow(covered, width, height, options.margin)
    const labels = components(grown, width, height)
    const boxes = new Map<number, [number, number, number, number]>()
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const label = labels[y * width + x]!
        if (label < 0) continue
        const box = boxes.get(label)
        if (!box) boxes.set(label, [x, y, x + 1, y + 1])
        else {
          box[0] = Math.min(box[0], x)
          box[1] = Math.min(box[1], y)
          box[2] = Math.max(box[2], x + 1)
          box[3] = Math.max(box[3], y + 1)
        }
      }
    }
    // On the grid, then merged until no two overlap.
    let rects = [...boxes].map(([label, [x0, y0, x1, y1]]) => ({
      labels: [label],
      box: [
        Math.floor(x0 / GRID) * GRID,
        Math.floor(y0 / GRID) * GRID,
        Math.ceil(x1 / GRID) * GRID,
        Math.ceil(y1 / GRID) * GRID,
      ] as [number, number, number, number],
    }))
    for (let merged = true; merged;) {
      merged = false
      outer: for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
          const [p, q] = [rects[a]!.box, rects[b]!.box]
          if (p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3]) {
            rects[a] = {
              labels: [...rects[a]!.labels, ...rects[b]!.labels],
              box: [
                Math.min(p[0], q[0]),
                Math.min(p[1], q[1]),
                Math.max(p[2], q[2]),
                Math.max(p[3], q[3]),
              ],
            }
            rects = rects.filter((_, i) => i !== b)
            merged = true
            break outer
          }
        }
      }
    }
    const rectOfLabel = new Map<number, number>()
    for (const { labels: members, box } of rects) {
      const [x0, y0, x1, y1] = box
      const island: Island = {
        look,
        // Back in the plane's own texels.
        x: x0 - off,
        y: y0 - off,
        width: x1 - x0,
        height: y1 - y0,
        page: -1,
        at: [0, 0],
      }
      for (const label of members) rectOfLabel.set(label, islands.length)
      islands.push(island)
    }
    for (const p of members) {
      const { indices } = p.surface
      const texels = p.texels!
      const of = new Int32Array(indices.length / 3)
      for (let t = 0; t < indices.length; t += 3) {
        const cx = (texels[2 * t]! + texels[2 * t + 2]! + texels[2 * t + 4]!) / 3 + off
        const cy = (texels[2 * t + 1]! + texels[2 * t + 3]! + texels[2 * t + 5]!) / 3 + off
        const label = labels[Math.floor(cy) * width + Math.floor(cx)]!
        of[t / 3] = rectOfLabel.get(label)!
      }
      islandOf.set(p, of)
    }
  }

  // Pages: every palette block on each, then the islands, tallest first.
  const paletteLooks = looks.flatMap((look, i) => (look.grid ? [] : [i]))
  const perRow = Math.floor(options.size / BLOCK)
  const palette = {
    width: Math.min(paletteLooks.length, perRow) * BLOCK,
    height: Math.ceil(paletteLooks.length / perRow) * BLOCK,
  }
  const order = islands
    .map((_, i) => i)
    .sort(
      (a, b) => islands[b]!.height - islands[a]!.height || islands[b]!.width - islands[a]!.width,
    )
  const pages: Skyline[] = []
  for (const i of order) {
    const island = islands[i]!
    if (island.width > options.size || island.height > options.size) {
      const name = looks[island.look]!.material.getName()
      throw new Error(`atlas: an island of ${name} is ${island.width}×${island.height} texels.`)
    }
    for (let p = 0; ; p++) {
      if (!pages[p]) {
        pages[p] = new Skyline(options.size / GRID, options.size / GRID)
        if (palette.width) {
          pages[p]!.place(Math.ceil(palette.width / GRID), Math.ceil(palette.height / GRID))
        }
      }
      const at = pages[p]!.place(island.width / GRID, island.height / GRID)
      if (at) {
        island.page = p
        island.at = [at[0] * GRID, at[1] * GRID]
        break
      }
    }
  }
  if (!pages.length) {
    pages.push(new Skyline(options.size / GRID, options.size / GRID))
    pages[0]!.place(Math.ceil(palette.width / GRID), Math.ceil(palette.height / GRID))
  }

  // Each page's texels.
  const materials: Material[] = []
  for (let p = 0; p < pages.length; p++) {
    const [width, height] = pages[p]!.extent().map((n) => n * GRID) as [number, number]
    const base = new Uint8Array(width * height * 4)
    const mr = new Uint8Array(width * height * 4)
    const normal = new Uint8Array(width * height * 4)
    const write = (look: Look, x: number, y: number, target: number) => {
      texel(look, x, y, base, mr, normal, target)
    }
    paletteLooks.forEach((look, k) => {
      const [bx, by] = [(k % perRow) * BLOCK, Math.floor(k / perRow) * BLOCK]
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) write(looks[look]!, 0, 0, y * width + x)
      }
    })
    let count = 0
    for (const island of islands) {
      if (island.page !== p) continue
      count++
      const look = looks[island.look]!
      for (let y = 0; y < island.height; y++) {
        for (let x = 0; x < island.width; x++) {
          write(look, island.x + x, island.y + y, (island.at[1] + y) * width + island.at[0] + x)
        }
      }
    }
    report.pages.push({ width, height, islands: count })
    const name = pages.length > 1 ? `${group} ${p + 1}` : group
    const hasNormal = islands.some((i) => i.page === p && looks[i.look]!.normal)
    // Without a roughness-metalness texture among its looks, the page's roughness and metalness
    // are constant over every 2×2 texels (blocks and islands sit on even texels), so half the
    // resolution holds them exactly; UVs are fractions of the page, the same at any size.
    const half = !islands.some((i) => i.page === p && looks[i.look]!.mr)
    const material = doc
      .createMaterial(name)
      .setDoubleSided(doubleSided)
      .setBaseColorTexture(await encode(doc, `${name} base`, base, width, height, 'colour'))
      .setMetallicRoughnessTexture(
        half
          ? await encode(doc, `${name} mr`, halve(mr, width, height), width / 2, height / 2, 'data')
          : await encode(doc, `${name} mr`, mr, width, height, 'data'),
      )
    clamp(material.getBaseColorTextureInfo()!)
    clamp(material.getMetallicRoughnessTextureInfo()!)
    if (hasNormal) {
      material.setNormalTexture(
        await encode(doc, `${name} normal`, normal, width, height, 'normal'),
      )
      clamp(material.getNormalTextureInfo()!)
    }
    materials.push(material)
  }

  // Each node's triangles, one surface per page it uses.
  const out = new Map<string, Builder>()
  const builder = (node: string, page: number) => {
    const id = `${node}\u0000${page}`
    let b = out.get(id)
    if (!b) out.set(id, (b = new Builder(node, materials[page]!)))
    return b
  }
  const sizes = report.pages
  for (const p of placed) {
    const { surface } = p
    const of = islandOf.get(p)
    // A node's palette triangles go to the page most of its textured ones are on.
    let page = 0
    if (!of) {
      const tally = new Map<number, number>()
      for (const q of placed) {
        const qOf = islandOf.get(q)
        if (q.surface.node !== surface.node || !qOf) continue
        for (const i of qOf) tally.set(islands[i]!.page, (tally.get(islands[i]!.page) ?? 0) + 1)
      }
      page = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
    }
    const block = paletteLooks.indexOf(p.look)
    for (let t = 0; t < surface.indices.length; t += 3) {
      const island = of ? islands[of[t / 3]!]! : undefined
      const target = builder(surface.node, island ? island.page : page)
      const { width, height } = sizes[island ? island.page : page]!
      for (let k = 0; k < 3; k++) {
        const v = surface.indices[t + k]!
        let uv: [number, number]
        if (island) {
          const x = p.texels![2 * (t + k)]! - island.x + island.at[0]
          const y = p.texels![2 * (t + k) + 1]! - island.y + island.at[1]
          uv = [x / width, y / height]
        } else {
          const [bx, by] = [(block % perRow) * BLOCK, Math.floor(block / perRow) * BLOCK]
          uv = [(bx + BLOCK / 2) / width, (by + BLOCK / 2) / height]
        }
        target.vertex(surface, v, uv)
      }
    }
  }
  return [...out.values()].map((b) => b.build())
}

/**
 * What `look` samples at `u`, `v` (repeating), bilinearly and in linear light as the GPU filters
 * an sRGB texture, as a look of factors only.
 */
function sampleLook(look: Look, u: number, v: number): Look {
  const bilinear = (pixels: Pixels | undefined, channel: number, srgb: boolean) => {
    if (!pixels) return 1
    const [x, y] = [u * pixels.width - 0.5, v * pixels.height - 0.5]
    const [x0, y0] = [Math.floor(x), Math.floor(y)]
    const [fx, fy] = [x - x0, y - y0]
    const at = (px: number, py: number) => {
      const wx = ((px % pixels.width) + pixels.width) % pixels.width
      const wy = ((py % pixels.height) + pixels.height) % pixels.height
      const value = pixels.data[4 * (wy * pixels.width + wx) + channel]! / 255
      return srgb ? srgbToLinear(value) : value
    }
    return (
      (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
      (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
    )
  }
  return {
    material: look.material,
    baseFactor: look.baseFactor.map((f, c) => f * bilinear(look.base, c, c < 3)),
    metal: look.metal * bilinear(look.mr, 2, false),
    rough: look.rough * bilinear(look.mr, 1, false),
    normalScale: 1,
  }
}

/** One texel of `look` at `x`, `y` of its grid's plane into the three page buffers. */
function texel(
  look: Look,
  x: number,
  y: number,
  base: Uint8Array,
  mr: Uint8Array,
  normal: Uint8Array,
  target: number,
): void {
  const sample = (pixels: Pixels, out: number[]) => {
    const px = ((x % pixels.width) + pixels.width) % pixels.width
    const py = ((y % pixels.height) + pixels.height) % pixels.height
    const i = 4 * (py * pixels.width + px)
    for (let c = 0; c < 4; c++) out[c] = pixels.data[i + c]!
    return out
  }
  const px = [255, 255, 255, 255]
  const o = 4 * target
  if (look.base) sample(look.base, px)
  else px.fill(255)
  for (let c = 0; c < 3; c++) {
    const f = look.baseFactor[c]!
    base[o + c] = f === 1 ? px[c]! : toSrgb8(srgbToLinear(px[c]! / 255) * f)
  }
  base[o + 3] = Math.round(px[3]! * look.baseFactor[3]!)
  // glTF's channels: roughness in green, metalness in blue.
  if (look.mr) sample(look.mr, px)
  else px.fill(255)
  mr[o] = 255
  mr[o + 1] = Math.round(px[1]! * look.rough)
  mr[o + 2] = Math.round(px[2]! * look.metal)
  mr[o + 3] = 255
  if (look.normal) {
    sample(look.normal, px)
    if (look.normalScale === 1) for (let c = 0; c < 3; c++) normal[o + c] = px[c]!
    else {
      const n = [0, 1, 2].map((c) => (px[c]! / 255) * 2 - 1)
      n[0]! *= look.normalScale
      n[1]! *= look.normalScale
      const l = Math.hypot(...n) || 1
      for (let c = 0; c < 3; c++) normal[o + c] = Math.round(((n[c]! / l + 1) / 2) * 255)
    }
  } else normal.set([128, 128, 255], o)
  normal[o + 3] = 255
}

async function describe(material: Material, images: ImageCache, report: AtlasReport) {
  const name = material.getName()
  const refuse = (what: string) => {
    throw new Error(`atlas: material ${name} has ${what}, which the atlas does not carry.`)
  }
  if (material.getAlphaMode() === 'MASK') refuse('alpha masking')
  if (material.getEmissiveTexture() || material.getEmissiveFactor().some((c) => c > 0)) {
    refuse('emission')
  }
  if (material.getOcclusionTexture()) refuse('an occlusion texture')
  for (const extension of material.listExtensions()) {
    const kind = extension.extensionName
    if (kind === KHRMaterialsSpecular.EXTENSION_NAME || kind === KHRMaterialsIOR.EXTENSION_NAME) {
      const specular = material.getExtension<Specular>(KHRMaterialsSpecular.EXTENSION_NAME)
      const ior = material.getExtension<IOR>(KHRMaterialsIOR.EXTENSION_NAME)
      const plain =
        (!specular ||
          (specular.getSpecularFactor() === 1 &&
            specular.getSpecularColorFactor().every((c) => c === 1) &&
            !specular.getSpecularTexture() &&
            !specular.getSpecularColorTexture())) &&
        (!ior || ior.getIOR() === 1.5)
      const line = `${name}: ${kind}`
      if (!plain && material.getMetallicFactor() < 1 && !report.dropped.includes(line)) {
        report.dropped.push(line)
      }
    } else refuse(kind)
  }
  const textures: [Texture | null, TextureInfo | null][] = [
    [material.getBaseColorTexture(), material.getBaseColorTextureInfo()],
    [material.getMetallicRoughnessTexture(), material.getMetallicRoughnessTextureInfo()],
    [material.getNormalTexture(), material.getNormalTextureInfo()],
  ]
  let grid: Look['grid']
  const decoded: (Pixels | undefined)[] = []
  for (const [texture, info] of textures) {
    if (!texture) {
      decoded.push(undefined)
      continue
    }
    if (info && info.getTexCoord() !== 0) refuse('a second UV set')
    if (info?.getExtension('KHR_texture_transform')) refuse('a texture transform')
    const pixels = await images.decode(texture)
    decoded.push(pixels)
    if (!grid) grid = { key: images.keyOf(pixels)!, width: pixels.width, height: pixels.height }
    else if (grid.width !== pixels.width || grid.height !== pixels.height) {
      refuse('textures of different sizes')
    }
  }
  return {
    material,
    grid,
    base: decoded[0],
    baseFactor: material.getBaseColorFactor(),
    mr: decoded[1],
    metal: material.getMetallicFactor(),
    rough: material.getRoughnessFactor(),
    normal: decoded[2],
    normalScale: material.getNormalScale(),
  } satisfies Look
}

// ---------------------------------------------------------------------------------------------
// Glass

/**
 * The group's blended glass as one material: base colour with its opacity, roughness and the
 * specular colour on a palette, one block per material. Their IOR and specular strength are
 * scalars of the material, so they must agree.
 */
async function bakeGlass(
  doc: Document,
  group: string,
  surfaces: Surface[],
  images: ImageCache,
): Promise<BakedSurface[]> {
  const materials = [...new Set(surfaces.map((s) => s.material))]
  const iors = new Set(materials.map((m) => m.getExtension<IOR>('KHR_materials_ior')?.getIOR()))
  const strengths = new Set(
    materials.map(
      (m) => m.getExtension<Specular>('KHR_materials_specular')?.getSpecularFactor() ?? 1,
    ),
  )
  if (iors.size > 1 || strengths.size > 1) {
    throw new Error(`atlas: the ${group} glass differs in IOR or specular strength.`)
  }
  const width = materials.length * BLOCK
  const base = new Uint8Array(width * BLOCK * 4)
  const mr = new Uint8Array(width * BLOCK * 4)
  const tint = new Uint8Array(width * BLOCK * 4)
  for (const [k, m] of materials.entries()) {
    const name = m.getName()
    // Uniform glass only: a texture of one colour is that colour, anything else is refused.
    const one = async (texture: Texture | null, what: string) => {
      if (!texture) return undefined
      const pixels = await images.decode(texture)
      const first = pixels.data.subarray(0, 4)
      for (let i = 0; i < pixels.data.length; i += 4) {
        if ([0, 1, 2, 3].some((c) => pixels.data[i + c] !== first[c])) {
          throw new Error(`atlas: glass ${name} has a ${what} texture of many colours.`)
        }
      }
      return [...first]
    }
    if (m.getMetallicRoughnessTexture() || m.getNormalTexture()) {
      throw new Error(`atlas: glass ${name} has a surface texture; only uniform glass is baked.`)
    }
    const specular = m.getExtension<Specular>('KHR_materials_specular')
    if (specular?.getSpecularTexture()) throw new Error(`atlas: glass ${name} varies in strength.`)
    const tinted = await one(specular?.getSpecularColorTexture() ?? null, 'specular colour')
    const colour = (specular?.getSpecularColorFactor() ?? [1, 1, 1]).map(
      (f, c) => f * (tinted ? srgbToLinear(tinted[c]! / 255) : 1),
    )
    const texel = await one(m.getBaseColorTexture(), 'base colour')
    const [r, g, b, a] = m
      .getBaseColorFactor()
      .map((f, c) => f * (texel ? (c < 3 ? srgbToLinear(texel[c]! / 255) : texel[c]! / 255) : 1))
    for (let y = 0; y < BLOCK; y++) {
      for (let x = k * BLOCK; x < (k + 1) * BLOCK; x++) {
        const o = 4 * (y * width + x)
        base.set([toSrgb8(r!), toSrgb8(g!), toSrgb8(b!), Math.round(a! * 255)], o)
        mr.set(
          [
            255,
            Math.round(m.getRoughnessFactor() * 255),
            Math.round(m.getMetallicFactor() * 255),
            255,
          ],
          o,
        )
        tint.set([toSrgb8(colour[0]!), toSrgb8(colour[1]!), toSrgb8(colour[2]!), 255], o)
      }
    }
  }
  const name = `${group} glass`
  const material = doc
    .createMaterial(name)
    .setAlphaMode('BLEND')
    .setDoubleSided(materials.some((m) => m.getDoubleSided()))
    .setBaseColorTexture(await encode(doc, `${name} base`, base, width, BLOCK, 'data'))
    .setMetallicRoughnessTexture(await encode(doc, `${name} mr`, mr, width, BLOCK, 'data'))
  const [ior] = iors
  if (ior !== undefined) {
    material.setExtension(
      'KHR_materials_ior',
      doc.createExtension(KHRMaterialsIOR).createIOR().setIOR(ior),
    )
  }
  const [strength] = strengths
  material.setExtension(
    'KHR_materials_specular',
    doc
      .createExtension(KHRMaterialsSpecular)
      .createSpecular()
      .setSpecularFactor(strength!)
      .setSpecularColorTexture(await encode(doc, `${name} tint`, tint, width, BLOCK, 'data')),
  )
  const out = new Map<string, Builder>()
  for (const surface of surfaces) {
    const k = materials.indexOf(surface.material)
    let b = out.get(surface.node)
    if (!b) out.set(surface.node, (b = new Builder(surface.node, material)))
    const uv: [number, number] = [(k * BLOCK + BLOCK / 2) / width, 0.5]
    for (const v of surface.indices) b.vertex(surface, v, uv)
  }
  return [...out.values()].map((b) => b.build())
}

// ---------------------------------------------------------------------------------------------
// Pieces

/** A node's joined triangles, vertices shared where position, normal and new UV all agree. */
class Builder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly uvs: number[] = []
  private readonly indices: number[] = []
  private readonly seen = new Map<Surface, Map<string, number>>()

  constructor(
    readonly node: string,
    readonly material: Material,
  ) {}

  vertex(surface: Surface, v: number, uv: [number, number]): void {
    let map = this.seen.get(surface)
    if (!map) this.seen.set(surface, (map = new Map()))
    const key = `${v},${uv[0]},${uv[1]}`
    let index = map.get(key)
    if (index === undefined) {
      index = this.positions.length / 3
      map.set(key, index)
      for (let c = 0; c < 3; c++) {
        this.positions.push(surface.positions[3 * v + c]!)
        this.normals.push(surface.normals[3 * v + c]!)
      }
      this.uvs.push(...uv)
    }
    this.indices.push(index)
  }

  build(): BakedSurface {
    return {
      node: this.node,
      material: this.material,
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      uvs: Float32Array.from(this.uvs),
      indices: Uint32Array.from(this.indices),
    }
  }
}

/** Texture pixels decoded once, keyed by content so identical images share a grid. */
class ImageCache {
  private readonly byTexture = new Map<Texture, Pixels>()
  private readonly keys = new Map<Pixels, string>()
  private readonly byContent = new Map<string, Pixels>()

  async decode(texture: Texture): Promise<Pixels> {
    const known = this.byTexture.get(texture)
    if (known) return known
    const { data, info } = await sharp(texture.getImage()!)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const key = `${info.width}x${info.height}:${hash(data)}`
    let pixels = this.byContent.get(key)
    if (!pixels) {
      pixels = { data: new Uint8Array(data), width: info.width, height: info.height }
      this.byContent.set(key, pixels)
      this.keys.set(pixels, key)
    }
    this.byTexture.set(texture, pixels)
    return pixels
  }

  keyOf(pixels: Pixels | undefined): string | undefined {
    return pixels && this.keys.get(pixels)
  }
}

function hash(data: Uint8Array): string {
  // FNV-1a over every byte: enough to tell textures apart, not a security boundary.
  let h = 0x811c9dc5
  for (const byte of data) h = Math.imul(h ^ byte, 0x01000193)
  return (h >>> 0).toString(16)
}

/**
 * Pages as a skyline, in grid cells: each rectangle goes where it rests lowest, then leftmost.
 */
class Skyline {
  /** Height of the skyline at each column. */
  private readonly tops: Int32Array
  private used = [0, 0]

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.tops = new Int32Array(width)
  }

  place(w: number, h: number): [number, number] | undefined {
    let best: [number, number] | undefined
    for (let x = 0; x + w <= this.width; x++) {
      let y = 0
      for (let k = x; k < x + w; k++) y = Math.max(y, this.tops[k]!)
      if (y + h <= this.height && (!best || y < best[1])) best = [x, y]
    }
    if (!best) return undefined
    for (let k = best[0]; k < best[0] + w; k++) this.tops[k] = best[1] + h
    this.used = [Math.max(this.used[0]!, best[0] + w), Math.max(this.used[1]!, best[1] + h)]
    return best
  }

  /** The smallest width and height holding everything placed. */
  extent(): [number, number] {
    return [this.used[0]!, this.used[1]!]
  }
}

/** Calls `mark` with each texel index whose centre lies within {@link COVER} of the triangle. */
function cover(
  corners: (readonly [number, number])[],
  width: number,
  height: number,
  mark: (index: number) => void,
): void {
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - COVER))
  const x1 = Math.min(width - 1, Math.floor(Math.max(...xs) + COVER))
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - COVER))
  const y1 = Math.min(height - 1, Math.floor(Math.max(...ys) + COVER))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (distanceToTriangle(x + 0.5, y + 0.5, corners) <= COVER) mark(y * width + x)
    }
  }
}

function distanceToTriangle(px: number, py: number, c: (readonly [number, number])[]): number {
  const [a, b, d] = c as [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ]
  const side = (p: readonly [number, number], q: readonly [number, number]) =>
    (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0])
  const [s0, s1, s2] = [side(a, b), side(b, d), side(d, a)]
  const area = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])
  if (area !== 0 && ((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0))) {
    return 0
  }
  const segment = (p: readonly [number, number], q: readonly [number, number]) => {
    const [dx, dy] = [q[0] - p[0], q[1] - p[1]]
    const l = dx * dx + dy * dy
    const t = l ? Math.max(0, Math.min(1, ((px - p[0]) * dx + (py - p[1]) * dy) / l)) : 0
    return Math.hypot(px - p[0] - t * dx, py - p[1] - t * dy)
  }
  return Math.min(segment(a, b), segment(b, d), segment(d, a))
}

/** The set texels grown by `by` texels in every direction (a square neighbourhood). */
function grow(covered: Uint8Array, width: number, height: number, by: number): Uint8Array {
  const rows = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    // Two passes along the row: the nearest owned texel on either side.
    let next = Infinity
    const left = new Float64Array(width)
    let last = -Infinity
    for (let x = 0; x < width; x++) {
      if (covered[y * width + x]) last = x
      left[x] = x - last
    }
    for (let x = width - 1; x >= 0; x--) {
      if (covered[y * width + x]) next = x
      if (Math.min(left[x]!, next - x) <= by) rows[y * width + x] = 1
    }
  }
  const out = new Uint8Array(width * height)
  for (let x = 0; x < width; x++) {
    let last = -Infinity
    const up = new Float64Array(height)
    for (let y = 0; y < height; y++) {
      if (rows[y * width + x]) last = y
      up[y] = y - last
    }
    let next = Infinity
    for (let y = height - 1; y >= 0; y--) {
      if (rows[y * width + x]) next = y
      if (Math.min(up[y]!, next - y) <= by) out[y * width + x] = 1
    }
  }
  return out
}

/** 8-connected components of the set texels; −1 elsewhere. */
function components(mask: Uint8Array, width: number, height: number): Int32Array {
  const labels = new Int32Array(width * height).fill(-1)
  let next = 0
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]! >= 0) continue
    labels[start] = next
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()!
      const [x, y] = [i % width, Math.floor(i / width)]
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const [nx, ny] = [x + dx, y + dy]
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const j = ny * width + nx
          if (mask[j] && labels[j]! < 0) {
            labels[j] = next
            stack.push(j)
          }
        }
      }
    }
    next++
  }
  return labels
}

function clamp(info: TextureInfo): void {
  info.setWrapS(33071).setWrapT(33071)
}

/** Every other texel of every other row. */
function halve(data: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array((width / 2) * (height / 2) * 4)
  for (let y = 0; y < height / 2; y++) {
    for (let x = 0; x < width / 2; x++) {
      out.set(
        data.subarray(4 * (2 * y * width + 2 * x), 4 * (2 * y * width + 2 * x) + 4),
        4 * (y * (width / 2) + x),
      )
    }
  }
  return out
}

/**
 * A page image as WebP. NASA's textures are lossy WebP already; colour is re-encoded at quality 92,
 * within 1 % of the decoded source (53 dB). Normals go near-lossless, within 2 levels of 255 per
 * channel: lossy coding speckles the highlights of smooth metal. Roughness, metalness and the
 * glass palettes are flat blocks and go lossless.
 */
async function encode(
  doc: Document,
  name: string,
  data: Uint8Array,
  width: number,
  height: number,
  kind: 'colour' | 'normal' | 'data',
): Promise<Texture> {
  const opaque = data.every((v, i) => i % 4 !== 3 || v === 255)
  let image = sharp(data, { raw: { width, height, channels: 4 } })
  if (opaque) image = image.removeAlpha()
  const options = {
    colour: { quality: 92, smartSubsample: true },
    normal: { nearLossless: true, quality: 60 },
    data: { lossless: true },
  }[kind]
  const webp = await image.webp(options).toBuffer()
  return doc.createTexture(name).setImage(new Uint8Array(webp)).setMimeType('image/webp')
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb8 = (linear: number) => {
  const c = Math.min(1, Math.max(0, linear))
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
  return Math.round(s * 255)
}
