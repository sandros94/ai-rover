/**
 * Builds the articulated rover models under `public/models/rover/` from NASA/JPL's
 * `m2020-urdf-models` (pinned commit): the chassis with its mast, the rockers, bogies,
 * differential, steering links and wheels, one node per URDF joint, decimated, with the 1k atlas
 * as WebP and meshopt-compressed geometry. `rover.glb` is the hero model, `rover-low.glb` the
 * phone model. Deterministic for a given source commit; re-running overwrites both files.
 *
 * Run from the repository root (sources are downloaded to the directory given, or to a temporary
 * directory, never into the repository):
 *
 *   pnpm exec jiti scripts/rover-model.ts [source-dir]
 *
 * Frames. The URDF's rover frame (RNAV) has x forward, y right, z down, its origin on the ground
 * between the middle wheels; the app's body frame is x forward, y left, z up with the same origin,
 * so every URDF point p becomes C·p with C = diag(1, −1, −1), a half turn about x. Node names and
 * joint axes (in the app frame) are recorded in each joint node's `extras`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Material, Node as GltfNode } from '@gltf-transform/core'
import { Document, NodeIO } from '@gltf-transform/core'
import { MeshoptSimplifier } from 'meshoptimizer'

const REPO = 'nasa-jpl/m2020-urdf-models'
const COMMIT = 'c422fc6d96f2684521fb64049448d611e670f140'
const RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}`
const OUT_DIR = fileURLToPath(new URL('../public/models/rover/', import.meta.url))

/** A kept URDF link: the app node it becomes, and further links whose meshes ride on it. */
interface KeptLink {
  link: string
  node: string
  /** Rigid URDF links merged into this node (the mast rides on the chassis). */
  riders?: string[]
}

const KEPT: KeptLink[] = [
  { link: 'Body_Chassis', node: 'chassis', riders: ['Body_RSM_AZ', 'Body_RSM_EL'] },
  { link: 'Body_Differential', node: 'differential' },
  { link: 'Body_RockerLeft', node: 'left_rocker' },
  { link: 'Body_RockerRight', node: 'right_rocker' },
  { link: 'Body_BogieLeft', node: 'left_bogie' },
  { link: 'Body_BogieRight', node: 'right_bogie' },
  { link: 'Body_SteerLeftFront', node: 'steer_lf' },
  { link: 'Body_SteerRightFront', node: 'steer_rf' },
  { link: 'Body_SteerLeftRear', node: 'steer_lr' },
  { link: 'Body_SteerRightRear', node: 'steer_rr' },
  { link: 'Body_WheelLeftFront', node: 'wheel_lf' },
  { link: 'Body_WheelRightFront', node: 'wheel_rf' },
  { link: 'Body_WheelLeftMiddle', node: 'wheel_lm' },
  { link: 'Body_WheelRightMiddle', node: 'wheel_rm' },
  { link: 'Body_WheelLeftRear', node: 'wheel_lr' },
  { link: 'Body_WheelRightRear', node: 'wheel_rr' },
]

interface Variant {
  file: string
  /** Atlas edge in pixels. */
  texture: number
  /** Target triangles per source mesh, by mesh file stem. */
  triangles: (stem: string) => number
  /** Simplifier error ceiling, as a fraction of each mesh's extent. */
  error: number
}

/** Budgets: ~30k triangles for the hero, ~8k for phones; wheels and links keep their outline. */
const VARIANTS: Variant[] = [
  {
    file: 'rover.glb',
    texture: 1024,
    triangles: (stem) => BUDGET_HERO[kindOf(stem)],
    error: 0.05,
  },
  {
    file: 'rover-low.glb',
    texture: 512,
    triangles: (stem) => BUDGET_LOW[kindOf(stem)],
    error: 0.08,
  },
]

type MeshKind = 'chassis' | 'mast' | 'head' | 'steerFront' | 'steerRear' | 'wheel' | 'link' | 'diff'
const BUDGET_HERO: Record<MeshKind, number> = {
  chassis: 14_000,
  mast: 500,
  head: 2_000,
  steerFront: 1_000,
  steerRear: 700,
  wheel: 900,
  link: 1_100,
  diff: 400,
}
const BUDGET_LOW: Record<MeshKind, number> = {
  chassis: 2_900,
  mast: 150,
  head: 500,
  steerFront: 250,
  steerRear: 180,
  wheel: 300,
  link: 300,
  diff: 100,
}

function kindOf(stem: string): MeshKind {
  if (stem === 'CHASSIS') return 'chassis'
  if (stem === 'RSM') return 'mast'
  if (stem === 'RSM_Head') return 'head'
  if (stem === 'CenterDifferential') return 'diff'
  if (stem.startsWith('Wheel_')) return 'wheel'
  if (stem.startsWith('Steer_')) return stem.endsWith('Front') ? 'steerFront' : 'steerRear'
  return 'link'
}

// ---------------------------------------------------------------------------------------------
// URDF

type Vec3 = [number, number, number]
/** Row-major 3×3. */
type Mat3 = [number, number, number, number, number, number, number, number, number]
interface Rigid {
  r: Mat3
  t: Vec3
}

interface UrdfJoint {
  name: string
  type: string
  parent: string
  child: string
  origin: Rigid
  axis: Vec3
}

interface UrdfLink {
  name: string
  /** The visual mesh stem (file name without `.gltf`) and its origin, when the link has one. */
  visual?: { stem: string; origin: Rigid }
}

function parseUrdf(xml: string): { links: Map<string, UrdfLink>; joints: UrdfJoint[] } {
  // Hidden visuals are commented out in the file; drop comments before matching.
  const text = xml.replace(/<!--[\s\S]*?-->/g, '')
  const links = new Map<string, UrdfLink>()
  for (const match of text.matchAll(/<link name="([^"]+)">([\s\S]*?)<\/link>/g)) {
    const [, name, body] = match
    const visual = /<visual[^>]*>([\s\S]*?)<\/visual>/.exec(body!)?.[1]
    const link: UrdfLink = { name: name! }
    if (visual) {
      const mesh = /<mesh filename="\.\/meshes\/([^"]+)\.gltf"/.exec(visual)
      if (mesh) link.visual = { stem: mesh[1]!, origin: originOf(visual) }
    }
    links.set(name!, link)
  }
  const joints: UrdfJoint[] = []
  for (const match of text.matchAll(/<joint name="([^"]+)" type="([^"]+)">([\s\S]*?)<\/joint>/g)) {
    const [, name, type, body] = match
    const axis = /<axis xyz="([^"]+)"/.exec(body!)?.[1]
    joints.push({
      name: name!,
      type: type!,
      parent: /<parent link="([^"]+)"/.exec(body!)![1]!,
      child: /<child link="([^"]+)"/.exec(body!)![1]!,
      origin: originOf(body!),
      axis: axis ? vec(axis) : [0, 0, 0],
    })
  }
  return { links, joints }
}

function originOf(xml: string): Rigid {
  const match = /<origin xyz="([^"]+)" rpy="([^"]+)"/.exec(xml)
  if (!match) return { r: rpy([0, 0, 0]), t: [0, 0, 0] }
  return { r: rpy(vec(match[2]!)), t: vec(match[1]!) }
}

const vec = (s: string): Vec3 => s.trim().split(/\s+/).map(Number) as Vec3

/** URDF roll-pitch-yaw: fixed-axis x, then y, then z, i.e. Rz(yaw)·Ry(pitch)·Rx(roll). */
function rpy([roll, pitch, yaw]: Vec3): Mat3 {
  const [cr, sr, cp, sp, cy, sy] = [
    Math.cos(roll),
    Math.sin(roll),
    Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw),
    Math.sin(yaw),
  ]
  return [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    -sp,
    cp * sr,
    cp * cr,
  ]
}

function mulMat(a: Mat3, b: Mat3): Mat3 {
  const out = Array.from({ length: 9 }, () => 0) as Mat3
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0
      for (let k = 0; k < 3; k++) sum += a[3 * i + k]! * b[3 * k + j]!
      out[3 * i + j] = sum
    }
  }
  return out
}

const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]

function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

const compose = (a: Rigid, b: Rigid): Rigid => ({
  r: mulMat(a.r, b.r),
  t: add(apply(a.r, b.t), a.t),
})
const invert = (a: Rigid): Rigid => {
  const rt = transpose(a.r)
  const t = apply(rt, a.t)
  return { r: rt, t: [-t[0], -t[1], -t[2]] }
}
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const transformPoint = (a: Rigid, p: Vec3): Vec3 => add(apply(a.r, p), a.t)

/** URDF (x forward, y right, z down) to app (x forward, y left, z up). */
const C: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1]
const toApp = (a: Rigid): Rigid => ({ r: mulMat(mulMat(C, a.r), C), t: apply(C, a.t) })

/** Each link's pose in the rover frame with every joint at zero. */
function linkPoses(joints: UrdfJoint[]): Map<string, { pose: Rigid; joint?: UrdfJoint }> {
  const byChild = new Map(joints.map((j) => [j.child, j]))
  const poses = new Map<string, { pose: Rigid; joint?: UrdfJoint }>()
  const resolve = (link: string): Rigid => {
    const known = poses.get(link)
    if (known) return known.pose
    const joint = byChild.get(link)
    // The chassis hangs off `ground` by a floating joint at the identity: it is the rover frame.
    if (!joint || joint.type === 'floating') {
      const pose = { r: rpy([0, 0, 0]), t: [0, 0, 0] as Vec3 }
      poses.set(link, { pose })
      return pose
    }
    const pose = compose(resolve(joint.parent), joint.origin)
    poses.set(link, { pose, joint })
    return pose
  }
  for (const joint of joints) resolve(joint.child)
  return poses
}

// ---------------------------------------------------------------------------------------------
// Sources

async function ensureSources(dir: string, stems: string[]): Promise<void> {
  mkdirSync(join(dir, 'meshes', 'Textures'), { recursive: true })
  const files = [
    ['README.md', 'README.md'],
    ['rover/m2020.urdf', 'm2020.urdf'],
    [
      'rover/meshes/Textures/M2020_Rover_Texture_1k.jpg',
      'meshes/Textures/M2020_Rover_Texture_1k.jpg',
    ],
    ...stems.flatMap((stem) => [
      [`rover/meshes/${stem}.gltf`, `meshes/${stem}.gltf`],
      [`rover/meshes/${stem}.bin`, `meshes/${stem}.bin`],
    ]),
  ]
  for (const [remote, local] of files) {
    const path = join(dir, local!)
    if (existsSync(path)) continue
    const response = await fetch(`${RAW}/${remote}`)
    if (!response.ok) throw new Error(`rover-model: GET ${remote} answered ${response.status}.`)
    writeFileSync(path, new Uint8Array(await response.arrayBuffer()))
  }
  // The meshes reference `Textures/M2020_Rover_Texture.jpg`; the repository's README says to
  // copy the wanted resolution to that name.
  const alias = join(dir, 'meshes', 'Textures', 'M2020_Rover_Texture.jpg')
  if (!existsSync(alias)) {
    writeFileSync(
      alias,
      readFileSync(join(dir, 'meshes', 'Textures', 'M2020_Rover_Texture_1k.jpg')),
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Build

function cli(...args: string[]): void {
  execFileSync('pnpm', ['exec', 'gltf-transform', ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

interface MeshData {
  positions: Float32Array<ArrayBuffer>
  uvs: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
}

/**
 * The link's mesh, welded by the CLI and decimated to about `target` triangles. The JPL meshes are
 * many small parts cut by texture seams, so the simplifier may drop tiny parts (`Prune`) and
 * collapse across seams (`Permissive`), with texture coordinates weighted into the error.
 */
async function simplified(
  io: NodeIO,
  src: string,
  work: string,
  stem: string,
  target: number,
  error: number,
): Promise<MeshData> {
  const welded = join(work, `${stem}-welded.glb`)
  if (!existsSync(welded)) cli('weld', join(src, 'meshes', `${stem}.gltf`), welded)
  const doc = await io.read(welded)
  const primitive = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!
  const positions = Float32Array.from(primitive.getAttribute('POSITION')!.getArray()!)
  const uvs = Float32Array.from(primitive.getAttribute('TEXCOORD_0')!.getArray()!)
  let indices: Uint32Array = Uint32Array.from(primitive.getIndices()!.getArray()!)
  if (target * 3 < indices.length) {
    await MeshoptSimplifier.ready
    ;[indices] = MeshoptSimplifier.simplifyWithAttributes(
      indices,
      positions,
      3,
      uvs,
      2,
      [0.5, 0.5],
      null,
      target * 3,
      error,
      ['Prune', 'Permissive'],
    )
  }
  return compact(positions, uvs, indices)
}

/** Drops the vertices no triangle uses, keeping first-use order. */
function compact(positions: Float32Array, uvs: Float32Array, indices: Uint32Array): MeshData {
  const remap = new Int32Array(positions.length / 3).fill(-1)
  const keptPositions: number[] = []
  const keptUvs: number[] = []
  const out = new Uint32Array(indices.length)
  indices.forEach((vertex, k) => {
    if (remap[vertex] === -1) {
      remap[vertex] = keptPositions.length / 3
      keptPositions.push(...positions.subarray(3 * vertex, 3 * vertex + 3))
      keptUvs.push(...uvs.subarray(2 * vertex, 2 * vertex + 2))
    }
    out[k] = remap[vertex]!
  })
  return {
    positions: Float32Array.from(keptPositions),
    uvs: Float32Array.from(keptUvs),
    indices: out,
  }
}

async function build(src: string, work: string, variant: Variant): Promise<{ triangles: number }> {
  const io = new NodeIO()
  const urdf = parseUrdf(readFileSync(join(src, 'm2020.urdf'), 'utf8'))
  const poses = linkPoses(urdf.joints)

  const doc = new Document()
  const buffer = doc.createBuffer()
  const atlas = doc
    .createTexture('atlas')
    .setMimeType('image/jpeg')
    .setImage(readFileSync(join(src, 'meshes', 'Textures', 'M2020_Rover_Texture_1k.jpg')))
  const material: Material = doc
    .createMaterial('rover')
    .setBaseColorTexture(atlas)
    .setRoughnessFactor(1)
    .setMetallicFactor(0)
  const scene = doc.createScene('rover')
  const nodes = new Map<string, GltfNode>()
  let triangles = 0

  for (const kept of KEPT) {
    const entry = poses.get(kept.link)
    if (!entry) throw new Error(`rover-model: link ${kept.link} is not in the URDF.`)
    const node = doc.createNode(kept.node)
    const joint = entry.joint
    // Local transform: the joint origin relative to the nearest kept ancestor, in app axes.
    const parentKept = joint ? keptAncestor(joint.parent, poses) : undefined
    const parentPose = parentKept ? poses.get(parentKept.link)!.pose : undefined
    const local = toApp(parentPose ? compose(invert(parentPose), entry.pose) : entry.pose)
    node.setTranslation(round(local.t)).setRotation(quatOf(local.r))
    if (joint) {
      node.setExtras({
        joint: joint.name,
        axis: round(apply(C, apply(joint.origin.r, joint.axis))),
      })
    }
    if (parentKept) nodes.get(parentKept.node)!.addChild(node)
    else scene.addChild(node)
    nodes.set(kept.node, node)

    for (const link of [kept.link, ...(kept.riders ?? [])]) {
      const visual = urdf.links.get(link)?.visual
      if (!visual) continue
      const pose = poses.get(link)!.pose
      // Mesh vertices into the node's frame: node⁻¹ · link · visual, then app axes.
      const toNode = toApp(compose(invert(entry.pose), compose(pose, visual.origin)))
      const data = await simplified(
        io,
        src,
        work,
        visual.stem,
        variant.triangles(visual.stem),
        variant.error,
      )
      console.log(`  ${variant.file} ${visual.stem}: ${data.indices.length / 3} triangles`)
      for (let k = 0; k < data.positions.length; k += 3) {
        const p = transformPoint(
          toNode,
          apply(C, [data.positions[k]!, data.positions[k + 1]!, data.positions[k + 2]!]),
        )
        data.positions.set(p, k)
      }
      triangles += data.indices.length / 3
      const primitive = doc
        .createPrimitive()
        .setMaterial(material)
        .setAttribute(
          'POSITION',
          doc.createAccessor().setType('VEC3').setArray(data.positions).setBuffer(buffer),
        )
        .setAttribute(
          'TEXCOORD_0',
          doc.createAccessor().setType('VEC2').setArray(data.uvs).setBuffer(buffer),
        )
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(data.indices).setBuffer(buffer))
      // Mesh on a child node: quantization rescales mesh nodes, the joint node stays exact.
      const meshNode = doc
        .createNode(`${kept.node}:${visual.stem}`)
        .setMesh(doc.createMesh(visual.stem).addPrimitive(primitive))
      node.addChild(meshNode)
    }
  }
  doc.getRoot().setDefaultScene(scene)
  doc.getRoot().getAsset().extras = {
    credit: 'NASA/JPL-Caltech',
    source: `github.com/${REPO}@${COMMIT}`,
  }

  const assembled = join(work, `assembled-${variant.file}`)
  await io.write(assembled, doc)
  const resized = join(work, `resized-${variant.file}`)
  if (variant.texture < 1024) {
    cli(
      'resize',
      assembled,
      resized,
      '--width',
      String(variant.texture),
      '--height',
      String(variant.texture),
    )
  } else {
    cli('copy', assembled, resized)
  }
  const webp = join(work, `webp-${variant.file}`)
  cli('webp', resized, webp, '--quality', '82')
  mkdirSync(OUT_DIR, { recursive: true })
  cli('meshopt', webp, join(OUT_DIR, variant.file), '--level', 'medium')
  return { triangles }
}

function keptAncestor(
  link: string,
  poses: Map<string, { pose: Rigid; joint?: UrdfJoint }>,
): KeptLink | undefined {
  for (let current: string | undefined = link; current;) {
    const kept = KEPT.find((k) => k.link === current)
    if (kept) return kept
    current = poses.get(current)?.joint?.parent
  }
  return undefined
}

function quatOf(m: Mat3): [number, number, number, number] {
  const trace = m[0] + m[4] + m[8]
  let q: [number, number, number, number]
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = [(m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s, s / 4]
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2
    q = [s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s]
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2
    q = [(m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s, (m[2] - m[6]) / s]
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2
    q = [(m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4, (m[3] - m[1]) / s]
  }
  return q.map((v) => Math.round(v * 1e9) / 1e9) as [number, number, number, number]
}

/** Micrometre rounding: the URDF gives joint origins to 10 µm; this drops float noise. */
const round = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1e6) / 1e6 + 0) as Vec3

// ---------------------------------------------------------------------------------------------

const src = process.argv[2] ?? join(tmpdir(), `jev-rover-urdf-${COMMIT.slice(0, 7)}`)
mkdirSync(src, { recursive: true })
const work = mkdtempSync(join(src, 'build-'))
await ensureSources(src, [])
const urdf = parseUrdf(readFileSync(join(src, 'm2020.urdf'), 'utf8'))
const meshStems = KEPT.flatMap((k) => [k.link, ...(k.riders ?? [])])
  .map((link) => urdf.links.get(link)?.visual?.stem)
  .filter((stem): stem is string => Boolean(stem))
await ensureSources(src, meshStems)

for (const variant of VARIANTS) {
  const { triangles } = await build(src, work, variant)
  const bytes = statSync(join(OUT_DIR, variant.file)).size
  console.log(`${variant.file}: ${triangles} triangles, ${bytes} bytes`)
}
