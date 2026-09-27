/**
 * Builds the articulated rover models under `public/models/rover/` from NASA/JPL's
 * `m2020-urdf-models` (pinned commit): the chassis, the remote sensing mast and its head, the
 * rockers, bogies, differential, steering links and wheels, one node per URDF joint, with
 * meshopt-compressed geometry. `rover.glb` is the rover itself, at full resolution (vertices
 * welded only where bitwise identical) with the 2k atlas as WebP; `rover-ghost.glb` is the
 * death markers' silhouette, decimated to about 9k triangles with no texture, since ghosts are
 * drawn in a flat tint. Deterministic for a given source commit; re-running overwrites both.
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
 *
 * Pose. Every joint sits at zero except the mast's, which are baked deployed (`deployedMast`):
 * at zero the head hangs face down and turned aft. The arm is left out: the URDF carries its
 * joint limits but not the pose JPL stows it in for driving.
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

/** The source atlas: `1k`, `2k`, `4k` or `8k`, re-encoded as WebP at its own size. */
const ATLAS = '2k'
/**
 * Meshopt quantization bits. Positions are quantized over each mesh's bounds: 14 bits over the
 * 3.0 m chassis is a 0.18 mm step, 0.09 mm error at most. Texture coordinates get 14 bits, an
 * eighth of a texel on the 2k atlas.
 */
const QUANTIZE = { position: 14, texcoord: 14 }

/**
 * A model built from the kept links: at full resolution with the atlas, or decimated to a
 * per-mesh triangle budget with positions alone.
 */
type Variant =
  | { file: string; kind: 'full' }
  | {
      file: string
      kind: 'silhouette'
      /** Target triangles per source mesh. */
      triangles: (stem: string) => number
      /** Simplifier error ceiling, as a fraction of each mesh's extent. */
      error: number
    }

type MeshKind = 'chassis' | 'mast' | 'head' | 'steerFront' | 'steerRear' | 'wheel' | 'link' | 'diff'

/**
 * The ghost's budget, about 9k triangles: the chassis keeps its deck outline, wheels and links
 * their shape; a flat translucent tint shows nothing finer.
 */
const GHOST_BUDGET: Record<MeshKind, number> = {
  chassis: 3_400,
  mast: 200,
  head: 600,
  steerFront: 300,
  steerRear: 220,
  wheel: 360,
  link: 360,
  diff: 120,
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

const VARIANTS: Variant[] = [
  { file: 'rover.glb', kind: 'full' },
  {
    file: 'rover-ghost.glb',
    kind: 'silhouette',
    triangles: (stem) => GHOST_BUDGET[kindOf(stem)],
    error: 0.08,
  },
]

/** A kept URDF link and the app node it becomes. */
interface KeptLink {
  link: string
  node: string
}

const KEPT: KeptLink[] = [
  { link: 'Body_Chassis', node: 'chassis' },
  { link: 'Body_RSM_AZ', node: 'mast_azimuth' },
  { link: 'Body_RSM_EL', node: 'mast_elevation' },
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
  /** Lower and upper joint limits, radians, for revolute joints. */
  limit?: [number, number]
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
    const limit = /<limit lower="([^"]+)" upper="([^"]+)"/.exec(body!)
    joints.push({
      name: name!,
      type: type!,
      parent: /<parent link="([^"]+)"/.exec(body!)![1]!,
      child: /<child link="([^"]+)"/.exec(body!)![1]!,
      origin: originOf(body!),
      axis: axis ? vec(axis) : [0, 0, 0],
      ...(limit && { limit: [Number(limit[1]), Number(limit[2])] as [number, number] }),
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

/** Rotation by `angle` radians about the unit `axis` (Rodrigues). */
function aboutAxis([x, y, z]: Vec3, angle: number): Mat3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const k = 1 - c
  return [
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
  ]
}

type LinkPoses = Map<string, { pose: Rigid; joint?: UrdfJoint }>

/** Each link's pose in the rover frame, joints at `values` (radians, by joint name) or zero. */
function linkPoses(joints: UrdfJoint[], values: Map<string, number>): LinkPoses {
  const byChild = new Map(joints.map((j) => [j.child, j]))
  const poses: LinkPoses = new Map()
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
    const pose = compose(resolve(joint.parent), jointTransform(joint, values.get(joint.name) ?? 0))
    poses.set(link, { pose, joint })
    return pose
  }
  for (const joint of joints) resolve(joint.child)
  return poses
}

/** A joint's child frame in its parent's, the joint turned to `value`. */
const jointTransform = (joint: UrdfJoint, value: number): Rigid =>
  value === 0
    ? joint.origin
    : { r: mulMat(joint.origin.r, aboutAxis(joint.axis, value)), t: joint.origin.t }

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/**
 * The value of revolute `joint` that turns `from` (a direction in its child frame) onto `to` (a
 * direction in its parent frame, perpendicular to the axis), within the joint's limits.
 */
function aim(joint: UrdfJoint, from: Vec3, to: Vec3): number {
  // `to` in the joint's own frame, before it turns; both directions projected off the axis.
  const target = apply(transpose(joint.origin.r), to)
  const flat = (v: Vec3): Vec3 => sub(v, scale(joint.axis, dot(joint.axis, v)))
  const [f, t] = [flat(from), flat(target)]
  let angle = Math.atan2(dot(joint.axis, cross(f, t)), dot(f, t))
  const [lower, upper] = joint.limit ?? [-Infinity, Infinity]
  while (angle < lower) angle += 2 * Math.PI
  while (angle > upper) angle -= 2 * Math.PI
  if (angle < lower) throw new Error(`rover-model: ${joint.name} cannot reach the wanted pose.`)
  return angle
}

/**
 * The remote sensing mast deployed, as it drives on Mars: the mast is upright in the chassis
 * mesh; the head's elevation joint levels the Navcam boresight (the left Navcam frame towards its
 * field-of-view frame) and the azimuth joint turns it forward. At zero both joints leave the head
 * facing the deck and turned aft (the azimuth joint's origin carries a 179° yaw).
 */
function deployedMast(joints: UrdfJoint[]): Map<string, number> {
  const byName = (name: string) => {
    const joint = joints.find((j) => j.name === name)
    if (!joint) throw new Error(`rover-model: joint ${name} is not in the URDF.`)
    return joint
  }
  const azimuth = byName('RSM_AZ_ENC')
  const elevation = byName('RSM_EL_ENC')
  const camera = byName('Joint_for_Frame_NCL').origin.t
  const boresight = sub(byName('Joint_for_Frame_NCL_FOV').origin.t, camera)
  const forward: Vec3 = [1, 0, 0]
  // Level within the azimuth link, whose z axis is the rover's: the boresight onto its +x ...
  const el = aim(elevation, boresight, forward)
  // ... and the azimuth link's +x onto the rover's (the chassis is the rover frame).
  const az = aim(azimuth, forward, forward)
  return new Map([
    [azimuth.name, az],
    [elevation.name, el],
  ])
}

// ---------------------------------------------------------------------------------------------
// Sources

async function ensureSources(dir: string, stems: string[]): Promise<void> {
  mkdirSync(join(dir, 'meshes', 'Textures'), { recursive: true })
  const files = [
    ['README.md', 'README.md'],
    ['rover/m2020.urdf', 'm2020.urdf'],
    [
      `rover/meshes/Textures/M2020_Rover_Texture_${ATLAS}.jpg`,
      `meshes/Textures/M2020_Rover_Texture_${ATLAS}.jpg`,
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
  writeFileSync(
    join(dir, 'meshes', 'Textures', 'M2020_Rover_Texture.jpg'),
    readFileSync(join(dir, 'meshes', 'Textures', `M2020_Rover_Texture_${ATLAS}.jpg`)),
  )
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

/** The link's mesh at full resolution, its bitwise identical vertices welded by the CLI. */
async function welded(io: NodeIO, src: string, work: string, stem: string): Promise<MeshData> {
  const out = join(work, `${stem}-welded.glb`)
  if (!existsSync(out)) cli('weld', join(src, 'meshes', `${stem}.gltf`), out)
  const doc = await io.read(out)
  const primitive = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!
  return {
    positions: Float32Array.from(primitive.getAttribute('POSITION')!.getArray()!),
    uvs: Float32Array.from(primitive.getAttribute('TEXCOORD_0')!.getArray()!),
    indices: Uint32Array.from(primitive.getIndices()!.getArray()!),
  }
}

/**
 * The link's mesh decimated to about `target` triangles, positions only: vertices sharing a
 * position are merged first (the atlas seams would otherwise pin the simplifier), then meshopt
 * simplifies within `error` of the mesh's extent.
 */
async function silhouette(
  io: NodeIO,
  src: string,
  work: string,
  stem: string,
  options: { target: number; error: number },
): Promise<Omit<MeshData, 'uvs'>> {
  const full = await welded(io, src, work, stem)
  const byPosition = new Map<string, number>()
  const positions: number[] = []
  const remap = new Uint32Array(full.positions.length / 3)
  for (let v = 0; v < remap.length; v++) {
    const p = full.positions.subarray(3 * v, 3 * v + 3)
    const key = `${p[0]},${p[1]},${p[2]}`
    let kept = byPosition.get(key)
    if (kept === undefined) {
      kept = positions.length / 3
      byPosition.set(key, kept)
      positions.push(p[0]!, p[1]!, p[2]!)
    }
    remap[v] = kept
  }
  const merged = Float32Array.from(positions)
  let indices: Uint32Array = full.indices.map((v) => remap[v]!)
  if (options.target * 3 < indices.length) {
    await MeshoptSimplifier.ready
    ;[indices] = MeshoptSimplifier.simplify(indices, merged, 3, options.target * 3, options.error, [
      'Prune',
    ])
  }
  return compact(merged, indices)
}

/** Only the vertices `indices` uses, renumbered in first-use order. */
function compact(
  positions: Float32Array,
  indices: Uint32Array,
): { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const remap = new Int32Array(positions.length / 3).fill(-1)
  const kept: number[] = []
  const out = new Uint32Array(indices.length)
  indices.forEach((vertex, k) => {
    if (remap[vertex] === -1) {
      remap[vertex] = kept.length / 3
      kept.push(...positions.subarray(3 * vertex, 3 * vertex + 3))
    }
    out[k] = remap[vertex]!
  })
  return { positions: Float32Array.from(kept), indices: out }
}

interface Built {
  triangles: number
  /** Joint values baked into the node transforms, radians, by URDF joint name. */
  baked: Map<string, number>
  /** File sizes in bytes: the shipped file, and the same before meshopt compression. */
  bytes: { meshopt: number; plain: number }
}

async function build(src: string, work: string, variant: Variant): Promise<Built> {
  const io = new NodeIO()
  const urdf = parseUrdf(readFileSync(join(src, 'm2020.urdf'), 'utf8'))
  const baked = deployedMast(urdf.joints)
  const poses = linkPoses(urdf.joints, baked)
  const textured = variant.kind === 'full'

  const doc = new Document()
  const buffer = doc.createBuffer()
  const material: Material = doc.createMaterial('rover').setRoughnessFactor(1).setMetallicFactor(0)
  if (textured) {
    material.setBaseColorTexture(
      doc
        .createTexture('atlas')
        .setMimeType('image/jpeg')
        .setImage(
          readFileSync(join(src, 'meshes', 'Textures', `M2020_Rover_Texture_${ATLAS}.jpg`)),
        ),
    )
  }
  const scene = doc.createScene('rover')
  const nodes = new Map<string, GltfNode>()
  let triangles = 0

  for (const kept of KEPT) {
    const entry = poses.get(kept.link)
    if (!entry) throw new Error(`rover-model: link ${kept.link} is not in the URDF.`)
    const node = doc.createNode(kept.node)
    const joint = entry.joint
    // Local transform: the joint (at its baked value) relative to the nearest kept ancestor, in
    // app axes.
    const parentKept = joint ? keptAncestor(joint.parent, poses) : undefined
    const parentPose = parentKept ? poses.get(parentKept.link)!.pose : undefined
    const local = toApp(parentPose ? compose(invert(parentPose), entry.pose) : entry.pose)
    node.setTranslation(round(local.t)).setRotation(quatOf(local.r))
    if (joint) {
      const value = baked.get(joint.name)
      node.setExtras({
        joint: joint.name,
        axis: round(apply(C, apply(joint.origin.r, joint.axis))),
        ...(value !== undefined && { baked: Math.round(value * 1e6) / 1e6 }),
      })
    }
    if (parentKept) nodes.get(parentKept.node)!.addChild(node)
    else scene.addChild(node)
    nodes.set(kept.node, node)

    const visual = urdf.links.get(kept.link)?.visual
    if (!visual) continue
    // Mesh vertices into the node's frame: the visual origin, then app axes.
    const toNode = toApp(visual.origin)
    const data: Omit<MeshData, 'uvs'> & { uvs?: MeshData['uvs'] } =
      variant.kind === 'full'
        ? await welded(io, src, work, visual.stem)
        : await silhouette(io, src, work, visual.stem, {
            target: variant.triangles(visual.stem),
            error: variant.error,
          })
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
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(data.indices).setBuffer(buffer))
    if (data.uvs) {
      primitive.setAttribute(
        'TEXCOORD_0',
        doc.createAccessor().setType('VEC2').setArray(data.uvs).setBuffer(buffer),
      )
    }
    // Mesh on a child node: quantization rescales mesh nodes, the joint node stays exact.
    const meshNode = doc
      .createNode(`${kept.node}:${visual.stem}`)
      .setMesh(doc.createMesh(visual.stem).addPrimitive(primitive))
    node.addChild(meshNode)
  }
  doc.getRoot().setDefaultScene(scene)
  doc.getRoot().getAsset().extras = {
    credit: 'NASA/JPL-Caltech',
    source: `github.com/${REPO}@${COMMIT}`,
  }

  const assembled = join(work, `assembled-${variant.file}`)
  await io.write(assembled, doc)
  let plain = assembled
  if (textured) {
    plain = join(work, `webp-${variant.file}`)
    cli('webp', assembled, plain, '--quality', '82')
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, variant.file)
  cli(
    'meshopt',
    plain,
    out,
    '--level',
    'medium',
    '--quantize-position',
    String(QUANTIZE.position),
    '--quantize-texcoord',
    String(QUANTIZE.texcoord),
  )
  return { triangles, baked, bytes: { meshopt: statSync(out).size, plain: statSync(plain).size } }
}

function keptAncestor(link: string, poses: LinkPoses): KeptLink | undefined {
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

const src = process.argv[2] ?? join(tmpdir(), `ai-rover-urdf-${COMMIT.slice(0, 7)}`)
mkdirSync(src, { recursive: true })
const work = mkdtempSync(join(src, 'build-'))
await ensureSources(src, [])
const urdf = parseUrdf(readFileSync(join(src, 'm2020.urdf'), 'utf8'))
const meshStems = KEPT.map((k) => urdf.links.get(k.link)?.visual?.stem).filter(
  (stem): stem is string => Boolean(stem),
)
await ensureSources(src, meshStems)

for (const variant of VARIANTS) {
  const { triangles, baked, bytes } = await build(src, work, variant)
  if (variant.kind === 'full') {
    for (const [joint, value] of baked) {
      console.log(
        `baked ${joint} = ${value.toFixed(6)} rad (${((value * 180) / Math.PI).toFixed(3)}°)`,
      )
    }
  }
  console.log(
    `${variant.file}: ${triangles} triangles, ${bytes.meshopt} bytes (${bytes.plain} before meshopt)`,
  )
}
