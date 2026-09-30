/**
 * Builds the articulated rover models under `public/models/rover/` from two NASA/JPL sources that
 * describe the same vehicle: NASA's Perseverance glTF (`NASA-3D-Resources`, pinned commit) gives
 * every part the rover shows, with its materials, textures and glass; JPL's `m2020-urdf-models`
 * (pinned commit) gives the joints the mobility system turns about. `rover.<hash>.glb` is the rover
 * at full resolution; `rover-low.<hash>.glb` the same parts on the same nodes in at most 2 000
 * triangles, each part a few primitives fitted to its geometry (`rover-model/ghost-fit.ts`),
 * untextured, drawn in a look (the stand-in, or a ghost). Each file is named by the first 8 hex
 * of its content's SHA-256, and `app/utils/rover-model-files.json` lists them for the app.
 * Deterministic for the pinned sources: re-running replaces both, and says whether each is
 * byte-identical to the build it replaces.
 *
 * Why both. The URDF's meshes carry one plain material over a baked texture atlas, no glass, no
 * normals, and no link for the differential's cross-links; NASA's model has 47 physically based
 * materials (metals, glass, gold foil, normal maps), the arm stowed and the antennas, but its
 * wheels are one mesh and its suspension another, with no joints. So the geometry is NASA's, cut
 * into the URDF's links: each wheel by its URDF wheel centre, each piece of the suspension by the
 * URDF link whose mesh it lies on, and posed about the URDF's joints.
 *
 * Run from the repository root (sources are downloaded to the directory given, or to a temporary
 * directory, never into the repository):
 *
 *   pnpm dlx jiti@2 scripts/rover-model.ts [source-dir]
 *
 * Frames. The URDF's rover frame (RNAV) has x forward, y right, z down, its origin on the ground
 * between the middle wheels; the app's body frame is x forward, y left, z up with the same origin,
 * so every URDF point p becomes C·p with C = diag(1, −1, −1). NASA's export is y up with the rover
 * facing +z; after that axis swap it is fitted onto the URDF by its six wheel centres (the fit and
 * its residuals are printed). Each joint node's `extras` records its URDF joint, its axis (app
 * axes, in the node's own frame), its limits when the URDF gives any, and the value baked into its
 * rest rotation.
 *
 * Pose. The mobility joints sit at zero; the mast's are baked deployed (`deployedMast`), and NASA's
 * mast is taken at the frame of its deploy animation where the head stands highest. The arm's
 * five joints are baked at the stowed pose the rover reported (`ARM_STOWED`), which NASA's arm
 * rests in at its first frame to about 2 cm at the WATSON camera; NASA animates the arm about
 * five pivots lying on the URDF's joint axes, so each pivot's geometry is that joint's link.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Document, Material, Node as GltfNode, Primitive } from '@gltf-transform/core'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { prune } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import type { Surface } from './rover-model/atlas'
import { bakeAtlases } from './rover-model/atlas'
import { fitRigid } from './rover-model/fit'
import type { Solid } from './rover-model/ghost'
import { meshOf, moved, trianglesOf, wheel } from './rover-model/ghost'
import type { GhostFitOptions, GhostPart } from './rover-model/ghost-fit'
import { fitGhost } from './rover-model/ghost-fit'
import { boundsDelta, boundsOf, SILHOUETTE_VIEWS, silhouetteIoU } from './rover-model/silhouette'
import { ARM_JOINTS, ARM_STOWED } from '../shared/utils/rover/arm'
import {
  assignPieces,
  glassAsBlend,
  highestHold,
  linkagePart,
  sampleAnimations,
  NASA_AXES,
  pieces,
  PointIndex,
} from './rover-model/nasa'
import type { LinkPoses, Mat3, Rigid, UrdfJoint, Vec3 } from './rover-model/urdf'
import {
  apply,
  C,
  compose,
  deployedMast,
  invert,
  linkPoses,
  parseUrdf,
  sub,
  toApp,
  transformPoint,
  transpose,
} from './rover-model/urdf'

const URDF = {
  repo: 'nasa-jpl/m2020-urdf-models',
  commit: 'c422fc6d96f2684521fb64049448d611e670f140',
}
const NASA = {
  repo: 'nasa/NASA-3D-Resources',
  commit: '751bf23ccddba9f52bf06f4085e9a1fc59d5e747',
  path: '3D Models/Mars 2020 Perseverance Rover/Mars 2020 Perseverance Rover.glb',
}
const OUT_DIR = fileURLToPath(new URL('../public/models/rover/', import.meta.url))
/** Where `OUT_DIR` is served, relative to the app's base URL. */
const MODELS_URL = 'models/rover/'
/** The app's list of the model files, by `RoverModelFile`; written by this script. */
const FILES_LIST = fileURLToPath(new URL('../app/utils/rover-model-files.json', import.meta.url))

/**
 * Meshopt quantization bits. Positions are quantized over each mesh's bounds: 14 bits over the
 * 3.0 m chassis is a 0.18 mm step, 0.09 mm error at most. Texture coordinates get 14 bits: an
 * atlas page is at most 2048 texels, so a step is an eighth of a texel and an island's texels
 * stay where its UVs were moved to. The low-poly model's flat normals take 8 bits: a face is
 * turned by half a degree at most.
 */
const QUANTIZE = { position: 14, texcoord: 14, flatNormal: 8 }
/** Opacity of NASA's transmissive glass (the camera lenses, the name plate's cover). */
const GLASS_OPACITY = 0.3

/**
 * A model built: `name` is its file's stem, `file` its key in the app's list of model files
 * (`RoverModelFile`).
 */
type Variant =
  | { name: string; file: 'full'; kind: 'full' }
  | { name: string; file: 'low-poly'; kind: 'ghost'; fit: GhostFitOptions }

/** A URDF link kept as an app node, and the joint it turns about. */
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
  { link: 'Body_RA_Link1', node: 'arm_1' },
  { link: 'Body_RA_Link2', node: 'arm_2' },
  { link: 'Body_RA_Link3', node: 'arm_3' },
  { link: 'Body_RA_Link4', node: 'arm_4' },
  { link: 'Body_RA_Link5', node: 'arm_5' },
]
/**
 * NASA's arm pivots, from the shoulder out, and the arm link each carries: each pivot turns about
 * its URDF joint's axis (to within 4 mm), so everything under it goes with that link.
 */
const ARM_PIVOTS: [nasa: string, node: string][] = [
  ['arm.003', 'arm_1'],
  ['arm.002', 'arm_2'],
  ['arm', 'arm_3'],
  ['arm.004', 'arm_4'],
  ['turret_obj', 'arm_5'],
]
/**
 * The nodes whose materials bake into shared atlas pages: parts cut from the same NASA meshes use
 * the same textures, so sharing pages keeps each texel once in memory. Draw calls stay per node.
 */
function atlasGroup(node: string): string {
  if (node === 'chassis') return 'chassis'
  if (node.startsWith('mast_')) return 'mast'
  if (node.startsWith('wheel_')) return 'wheels'
  if (node.startsWith('arm_')) return 'arm'
  return 'suspension'
}

function atlasGroups(surfaces: Surface[]): Map<string, Surface[]> {
  const groups = new Map<string, Surface[]>()
  for (const surface of surfaces) {
    const group = atlasGroup(surface.node)
    groups.set(group, [...(groups.get(group) ?? []), surface])
  }
  return groups
}

const WHEELS = KEPT.filter((k) => k.node.startsWith('wheel_'))
/** The suspension links NASA's `suspension` mesh is cut into, by the URDF mesh each piece lies on. */
const SUSPENSION = KEPT.filter((k) =>
  /^(differential|left_rocker|right_rocker|left_bogie|right_bogie|steer_)/.test(k.node),
)

/**
 * The low-poly rover: the stand-in, the far level of detail, the shadow caster and the death
 * markers' ghost. Pieces are grouped up to 25 cm before the fit merges them; the volumes are
 * compared on 1.5 cm cubes, weighted like one of the six views the silhouettes are compared from;
 * a primitive costs what 0.3 % of a view's silhouette does, so pieces merge where the silhouettes
 * lose less, which draws fewer, larger primitives for about the same overlap.
 */
const GHOST: GhostFitOptions = {
  looks: SILHOUETTE_VIEWS.map((v) => v.look),
  resolution: 512,
  budget: 2_000,
  cell: 0.015,
  volume: 1,
  tolerance: 0.01,
  piece: 0.25,
  sides: [5, 6, 8],
  price: 0.004,
  primitive: 0.003,
}
/**
 * The wheels' closed prisms: a tread and rim of 10 sides and a hub of 6, 100 triangles a wheel.
 */
const GHOST_WHEEL = { segments: 10, hubSegments: 6 }

const VARIANTS: Variant[] = [
  { name: 'rover', file: 'full', kind: 'full' },
  { name: 'rover-low', file: 'low-poly', kind: 'ghost', fit: GHOST },
]

// ---------------------------------------------------------------------------------------------
// Sources

async function download(url: string, path: string): Promise<void> {
  if (existsSync(path)) return
  const response = await fetch(url)
  if (!response.ok) throw new Error(`rover-model: GET ${url} answered ${response.status}.`)
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()))
}

async function ensureSources(dir: string): Promise<void> {
  mkdirSync(join(dir, 'meshes'), { recursive: true })
  const raw = `https://raw.githubusercontent.com/${URDF.repo}/${URDF.commit}`
  await download(`${raw}/README.md`, join(dir, 'README.md'))
  await download(`${raw}/rover/m2020.urdf`, join(dir, 'm2020.urdf'))
  const urdf = parseUrdf(readFileSync(join(dir, 'm2020.urdf'), 'utf8'))
  for (const kept of [...SUSPENSION, ...WHEELS]) {
    const stem = urdf.links.get(kept.link)?.visual?.stem
    if (!stem) throw new Error(`rover-model: link ${kept.link} has no mesh in the URDF.`)
    // Only the geometry is used (the pieces are matched against it, it is never drawn), but the
    // glTF reader loads every file the mesh names: its buffer and its texture.
    const gltf = join(dir, 'meshes', `${stem}.gltf`)
    await download(`${raw}/rover/meshes/${stem}.gltf`, gltf)
    const { buffers = [], images = [] } = JSON.parse(readFileSync(gltf, 'utf8')) as {
      buffers?: { uri?: string }[]
      images?: { uri?: string }[]
    }
    for (const { uri } of [...buffers, ...images]) {
      if (!uri || uri.startsWith('data:')) continue
      const file = decodeURI(uri)
      mkdirSync(dirname(join(dir, 'meshes', file)), { recursive: true })
      await download(`${raw}/rover/meshes/${uri}`, join(dir, 'meshes', file))
    }
  }
  const path = NASA.path.split('/').map(encodeURIComponent).join('/')
  await download(
    `https://raw.githubusercontent.com/${NASA.repo}/${NASA.commit}/${path}`,
    join(dir, 'perseverance.glb'),
  )
}

// ---------------------------------------------------------------------------------------------
// Geometry in the app frame

/** One source primitive's triangles, in the rover's body frame. */
interface Baked {
  source: string
  material: Material
  positions: Float32Array<ArrayBuffer>
  normals: Float32Array<ArrayBuffer>
  uvs?: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
  /** Each triangle's app node, by name. */
  part: string[]
}

/** Column-major 4×4, as glTF stores node matrices. */
type Mat4 = number[]

const mat4 = ({ r, t }: Rigid): Mat4 => [
  r[0],
  r[3],
  r[6],
  0,
  r[1],
  r[4],
  r[7],
  0,
  r[2],
  r[5],
  r[8],
  0,
  t[0],
  t[1],
  t[2],
  1,
]

function mulMat4(a: Mat4, b: ArrayLike<number>): Mat4 {
  const out = Array.from({ length: 16 }, () => 0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[4 * k + r]! * b[4 * c + k]!
      out[4 * c + r] = s
    }
  }
  return out
}

/**
 * A primitive's triangles carried into the app frame by `m`: a node's world matrix, or for a
 * skinned mesh each vertex's blend of its joints' matrices.
 */
function bake(primitive: Primitive, m: Mat4 | ((vertex: number) => Mat4), source: string): Baked {
  const position = primitive.getAttribute('POSITION')!
  const normal = primitive.getAttribute('NORMAL')
  const uv = primitive.getAttribute('TEXCOORD_0')
  const count = position.getCount()
  const positions = new Float32Array(3 * count)
  const normals = new Float32Array(3 * count)
  const linearOf = (m: Mat4): Mat3 => [
    m[0]!,
    m[4]!,
    m[8]!,
    m[1]!,
    m[5]!,
    m[9]!,
    m[2]!,
    m[6]!,
    m[10]!,
  ]
  // Normals by the inverse transpose: some of the export's nodes are scaled unevenly.
  const rigid = typeof m === 'function' ? undefined : transpose(inverse3(linearOf(m)))
  const v: Vec3 = [0, 0, 0]
  for (let i = 0; i < count; i++) {
    const w = typeof m === 'function' ? m(i) : m
    position.getElement(i, v)
    positions.set(
      [
        w[0]! * v[0] + w[4]! * v[1] + w[8]! * v[2] + w[12]!,
        w[1]! * v[0] + w[5]! * v[1] + w[9]! * v[2] + w[13]!,
        w[2]! * v[0] + w[6]! * v[1] + w[10]! * v[2] + w[14]!,
      ],
      3 * i,
    )
    if (normal) {
      normal.getElement(i, v)
      const n = apply(rigid ?? transpose(inverse3(linearOf(w))), v)
      const l = Math.hypot(...n) || 1
      normals.set([n[0] / l, n[1] / l, n[2] / l], 3 * i)
    }
  }
  const indices = Uint32Array.from(
    primitive.getIndices()?.getArray() ?? Array.from({ length: count }, (_, i) => i),
  )
  // A mirroring transform turns the triangles inside out; keep them facing out.
  if (typeof m !== 'function' && det3(linearOf(m)) < 0) {
    for (let t = 0; t < indices.length; t += 3) {
      ;[indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!]
    }
  }
  return {
    source,
    material: primitive.getMaterial()!,
    positions,
    normals,
    ...(uv && { uvs: Float32Array.from(uv.getArray()!) }),
    indices,
    part: Array.from({ length: indices.length / 3 }, () => 'chassis'),
  }
}

/**
 * Each vertex's skinning matrix into the app frame for `primitive` of skinned `node`: its joints'
 * current world matrices over their inverse bind matrices, blended by the vertex's weights.
 */
function skinning(node: GltfNode, primitive: Primitive, toBody: Mat4): (vertex: number) => Mat4 {
  const skin = node.getSkin()!
  const inverseBind = skin.getInverseBindMatrices()!
  const joints = skin.listJoints().map((joint, k) => {
    const ibm = Array.from({ length: 16 }, () => 0)
    inverseBind.getElement(k, ibm)
    return mulMat4(mulMat4(toBody, joint.getWorldMatrix()), ibm)
  })
  const jointIndex = primitive.getAttribute('JOINTS_0')!
  const weight = primitive.getAttribute('WEIGHTS_0')!
  const [j, w] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  return (vertex) => {
    jointIndex.getElement(vertex, j)
    weight.getElement(vertex, w)
    const out = Array.from({ length: 16 }, () => 0)
    for (let k = 0; k < 4; k++) {
      if (!w[k]) continue
      const joint = joints[j[k]!]!
      for (let e = 0; e < 16; e++) out[e]! += w[k]! * joint[e]!
    }
    return out
  }
}

const det3 = (m: Mat3): number =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) -
  m[1] * (m[3] * m[8] - m[5] * m[6]) +
  m[2] * (m[3] * m[7] - m[4] * m[6])

function inverse3(m: Mat3): Mat3 {
  const d = det3(m)
  return [
    (m[4] * m[8] - m[5] * m[7]) / d,
    (m[2] * m[7] - m[1] * m[8]) / d,
    (m[1] * m[5] - m[2] * m[4]) / d,
    (m[5] * m[6] - m[3] * m[8]) / d,
    (m[0] * m[8] - m[2] * m[6]) / d,
    (m[2] * m[3] - m[0] * m[5]) / d,
    (m[3] * m[7] - m[4] * m[6]) / d,
    (m[1] * m[6] - m[0] * m[7]) / d,
    (m[0] * m[4] - m[1] * m[3]) / d,
  ]
}

/** A URDF link's mesh vertices in the URDF's rover frame, at the link's pose. */
async function linkCloud(io: NodeIO, src: string, stem: string, pose: Rigid, visual: Rigid) {
  const doc = await io.read(join(src, 'meshes', `${stem}.gltf`))
  const position = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!
  const toRover = compose(pose, visual)
  const points: Vec3[] = []
  const v: Vec3 = [0, 0, 0]
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, v)
    points.push(transformPoint(toRover, v))
  }
  return points
}

// ---------------------------------------------------------------------------------------------
// Build

function cli(...args: string[]): void {
  execFileSync('pnpm', ['exec', 'gltf-transform', ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

interface Built {
  triangles: number
  primitives: number
  /** Joint values baked into the node transforms, radians, by URDF joint name. */
  baked: Map<string, number>
  /** The NASA→app fit's residual at each wheel centre, metres. */
  residuals: number[]
  /** File sizes in bytes: the shipped file, and the same before meshopt compression. */
  bytes: { meshopt: number; plain: number }
  /** The shipped file, in the work directory. */
  out: string
}

async function build(src: string, work: string, variant: Variant): Promise<Built> {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() })
  const urdf = parseUrdf(readFileSync(join(src, 'm2020.urdf'), 'utf8'))
  const baked = new Map([...deployedMast(urdf.joints), ...stowedArm(urdf.joints)])
  const urdfPoses = linkPoses(urdf.joints, baked)
  /** A kept link's pose in the app frame. */
  const pose = (link: string): Rigid => {
    const entry = urdfPoses.get(link)
    if (!entry) throw new Error(`rover-model: link ${link} is not in the URDF.`)
    return toApp(entry.pose)
  }

  const doc = await io.read(join(src, 'perseverance.glb'))
  const root = doc.getRoot()
  const named = (name: string): GltfNode => {
    const node = root.listNodes().find((n) => n.getName() === name)
    if (!node) throw new Error(`rover-model: NASA's model has no node ${name}.`)
    return node
  }
  // Everything at rest (the arm stowed), then the mast alone at its deployed hold.
  sampleAnimations(doc, 0)
  const mast = new Set<GltfNode>()
  // The mast and the armature its cable is skinned to.
  for (const name of ['Cylinder', 'Armature']) named(name).traverse((n) => mast.add(n))
  const deployedAt = highestHold(doc, named('head'), mast)
  sampleAnimations(doc, deployedAt, mast)

  // --- Fit NASA's model onto the URDF by the wheel centres.
  const wheelCentres = WHEELS.map((w) => pose(w.link).t)
  const axes = mat4({ r: NASA_AXES, t: [0, 0, 0] })
  const wheelsWorld = mulMat4(axes, named('Wheels_objs').getWorldMatrix())
  const boxes = wheelCentres.map(() => ({
    min: [Infinity, Infinity, Infinity] as Vec3,
    max: [-Infinity, -Infinity, -Infinity] as Vec3,
  }))
  for (const primitive of named('Wheels_objs').getMesh()!.listPrimitives()) {
    const b = bake(primitive, wheelsWorld, 'Wheels_objs')
    for (let v = 0; v < b.positions.length; v += 3) {
      const p: Vec3 = [b.positions[v]!, b.positions[v + 1]!, b.positions[v + 2]!]
      const box = boxes[nearestIndex(wheelCentres, p)]!
      for (let k = 0; k < 3; k++) {
        box.min[k] = Math.min(box.min[k]!, p[k]!)
        box.max[k] = Math.max(box.max[k]!, p[k]!)
      }
    }
  }
  const nasaCentres = boxes.map(
    ({ min, max }) => [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2) as Vec3,
  )
  const fit = fitRigid(nasaCentres, wheelCentres)
  const toBody = mulMat4(mat4(fit), axes)

  // --- Every drawn primitive in the app frame, each triangle given its app node.
  const mastAzimuth = new Set<GltfNode>()
  const mastElevation = new Set<GltfNode>()
  named('top').traverse((n) => mastAzimuth.add(n))
  named('Cylinder.002').traverse((n) => {
    mastElevation.add(n)
    mastAzimuth.delete(n)
  })
  const armOf = new Map<GltfNode, string>()
  for (const [pivot, link] of ARM_PIVOTS) named(pivot).traverse((n) => armOf.set(n, link))
  const bakedPrimitives: Baked[] = []
  for (const node of root.listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const world = mulMat4(toBody, node.getWorldMatrix())
    for (const primitive of mesh.listPrimitives()) {
      // Pivot markers the export leaves in the scene, textured fully transparent but opaque.
      if (primitive.getMaterial()?.getName() === 'transparent') continue
      const b = bake(
        primitive,
        node.getSkin() ? skinning(node, primitive, toBody) : world,
        node.getName(),
      )
      const arm = armOf.get(node)
      if (mastElevation.has(node)) b.part.fill('mast_elevation')
      else if (mastAzimuth.has(node)) b.part.fill('mast_azimuth')
      else if (arm) b.part.fill(arm)
      bakedPrimitives.push(b)
    }
  }

  // Wheels: each triangle to the nearest wheel centre.
  for (const b of bakedPrimitives.filter((b) => b.source === 'Wheels_objs')) {
    for (let t = 0; t < b.part.length; t++) {
      b.part[t] = WHEELS[nearestIndex(wheelCentres, centroid(b, t))]!.node
    }
  }
  // Suspension: each piece to the URDF link whose mesh it lies on.
  const clouds = await Promise.all(
    SUSPENSION.map((k) => {
      const visual = urdf.links.get(k.link)!.visual!
      return linkCloud(io, src, visual.stem, urdfPoses.get(k.link)!.pose, visual.origin)
    }),
  )
  const index = new PointIndex(
    SUSPENSION.map((k) => k.node),
    clouds.map((points) => points.map((p) => apply(C, p))),
    0.02,
  )
  // The URDF has no link for the differential's linkage: on each side a crank rising from the
  // rocker hub and a rod from its top to the bar's end. Those pieces lie on no URDF mesh.
  const pivots = { left: pose('Body_RockerLeft').t, right: pose('Body_RockerRight').t }
  for (const b of bakedPrimitives.filter((b) => b.source === 'suspension')) {
    const piece = pieces(b.positions, b.indices)
    const link = assignPieces(b.positions, b.indices, piece, index, { reach: 0.04, quorum: 0.5 })
    const centres = new Map<number, Vec3[]>()
    for (let t = 0; t < b.part.length; t++) {
      const l = link[piece[t]!]!
      if (l >= 0) b.part[t] = SUSPENSION[l]!.node
      else {
        let list = centres.get(piece[t]!)
        if (!list) centres.set(piece[t]!, (list = []))
        list.push(centroid(b, t))
      }
    }
    const parts = new Map(
      [...centres].map(([p, list]) => {
        const centre = [0, 1, 2].map((k) => list.reduce((s, c) => s + c[k]!, 0) / list.length)
        const side = centre[1]! > 0 ? 'left' : 'right'
        const kind = linkagePart(centre as Vec3, pivots[side])
        return [p, kind === 'rod' ? `${side}_differential_link` : `${side}_rocker`] as const
      }),
    )
    for (let t = 0; t < b.part.length; t++) {
      if (link[piece[t]!]! < 0) b.part[t] = parts.get(piece[t]!)!
    }
  }

  // --- The app's node tree, NASA's geometry placed in each node's frame.
  const scene = doc.createScene('rover')
  const buffer = root.listBuffers()[0] ?? doc.createBuffer()
  const nodes = new Map<string, GltfNode>()
  const nodePose = new Map<string, Rigid>()
  let triangles = 0
  let primitives = 0
  const ghostMaterial = doc.createMaterial('ghost').setRoughnessFactor(1).setMetallicFactor(0)
  for (const kept of KEPT) {
    const entry = urdfPoses.get(kept.link)!
    const node = doc.createNode(kept.node)
    const joint = entry.joint
    const parentKept = joint ? keptAncestor(joint.parent, urdfPoses) : undefined
    const parentPose = parentKept ? urdfPoses.get(parentKept.link)!.pose : undefined
    const local = toApp(parentPose ? compose(invert(parentPose), entry.pose) : entry.pose)
    node.setTranslation(round(local.t)).setRotation(quatOf(local.r))
    if (joint && joint.type !== 'floating') {
      const value = baked.get(joint.name)
      const limited = joint.limit && joint.limit.every((x) => Math.abs(x) < 1e300)
      node.setExtras({
        joint: joint.name,
        // In the node's own frame: the rig turns a node by its rest rotation, then about this.
        axis: round(apply(C, joint.axis)),
        ...(limited && { limit: joint.limit }),
        ...(value !== undefined && { baked: Math.round(value * 1e6) / 1e6 }),
      })
    }
    if (parentKept) nodes.get(parentKept.node)!.addChild(node)
    else scene.addChild(node)
    nodes.set(kept.node, node)
    nodePose.set(kept.node, pose(kept.link))
  }

  // The differential's rods: nodes under the bar at each rod's bar end, turned at run time to
  // keep pointing at the crank's top on the rocker (`extras.aim`).
  const rodEnds: Record<string, { bar: Vec3; crank: Vec3 }> = {}
  for (const side of ['left', 'right'] as const) {
    const name = `${side}_differential_link`
    const points = bakedPrimitives.flatMap((b) =>
      b.part.flatMap((part, t) =>
        part === name
          ? [0, 1, 2].map((k) => {
              const v = b.indices[3 * t + k]!
              return [b.positions[3 * v]!, b.positions[3 * v + 1]!, b.positions[3 * v + 2]!] as Vec3
            })
          : [],
      ),
    )
    if (!points.length) throw new Error(`rover-model: no pieces of the ${side} differential rod.`)
    const ends = (rodEnds[side] = rodEndsOf(points))
    const barPose = nodePose.get('differential')!
    const rockerPose = nodePose.get(`${side}_rocker`)!
    const rodPose: Rigid = { r: barPose.r, t: ends.bar }
    const node = doc
      .createNode(name)
      .setTranslation(round(transformPoint(invert(barPose), ends.bar)))
      .setExtras({
        aim: {
          node: `${side}_rocker`,
          // The crank's top, in the rocker's frame and in the rod's.
          point: round(transformPoint(invert(rockerPose), ends.crank)),
          from: round(transformPoint(invert(rodPose), ends.crank)),
        },
      })
    nodes.get('differential')!.addChild(node)
    nodes.set(name, node)
    nodePose.set(name, rodPose)
  }
  {
    const { left } = rodEnds
    const rise = left!.crank[2] - pivots.left[2]
    const reach = Math.abs(left!.bar[1] - nodePose.get('differential')!.t[1])
    console.log(
      `  differential linkage: crank top ${(rise * 1000).toFixed(1)} mm above the pivot, ` +
        `bar end ${(reach * 1000).toFixed(1)} mm out: ratio ${(rise / reach).toFixed(4)}`,
    )
  }

  if (variant.kind === 'full') {
    for (const material of root.listMaterials()) glassAsBlend(material, GLASS_OPACITY)
  }
  const ghost =
    variant.kind === 'ghost' ? fitParts(bakedPrimitives, nodePose, variant.fit) : undefined
  /** The full model's triangles, one surface per material per node, before baking. */
  const surfaces: Surface[] = []
  const meshes = new Map<string, ReturnType<Document['createMesh']>>()
  for (const [name, placed] of nodePose) {
    const inNode = invert(placed)
    const mesh = doc.createMesh(name)
    meshes.set(name, mesh)
    const list = bakedPrimitives.flatMap((b) =>
      b.part.flatMap((part, t) => (part === name ? [{ b, t }] : [])),
    )
    if (variant.kind === 'full') {
      const byMaterial = new Map<Material, { b: Baked; t: number }[]>()
      for (const entry of list) {
        let group = byMaterial.get(entry.b.material)
        if (!group) byMaterial.set(entry.b.material, (group = []))
        group.push(entry)
      }
      for (const [material, group] of byMaterial) {
        const merged = gather(
          group,
          inNode,
          group.every(({ b }) => b.uvs),
        )
        surfaces.push({ node: name, material, ...merged })
      }
    } else if (ghost?.has(name)) {
      const shape = meshOf(ghost.get(name)!)
      mesh.addPrimitive(
        doc
          .createPrimitive()
          .setMaterial(ghostMaterial)
          .setAttribute('POSITION', accessor(doc, buffer, 'VEC3', shape.positions))
          .setAttribute('NORMAL', accessor(doc, buffer, 'VEC3', shape.normals))
          .setIndices(accessor(doc, buffer, 'SCALAR', shape.indices)),
      )
    }
  }
  const calls = new Map<string, { before: number; after: number }>()
  if (variant.kind === 'full') {
    // Each atlas group's materials baked into its pages and its glass: a node then draws one
    // primitive per page it uses, and one for its glass.
    for (const [group, members] of atlasGroups(surfaces)) {
      const { baked, report } = await bakeAtlases(doc, group, members)
      const pages = report.pages.map((p) => `${p.width}×${p.height} (${p.islands} islands)`)
      console.log(
        `  atlas ${group}: ${pages.join(', ')}` +
          (report.dropped.length ? `; dropped ${report.dropped.join(', ')}` : ''),
      )
      for (const surface of baked) {
        meshes.get(surface.node)!.addPrimitive(
          doc
            .createPrimitive()
            .setMaterial(surface.material)
            .setAttribute('POSITION', accessor(doc, buffer, 'VEC3', surface.positions))
            .setAttribute('NORMAL', accessor(doc, buffer, 'VEC3', surface.normals))
            .setAttribute('TEXCOORD_0', accessor(doc, buffer, 'VEC2', surface.uvs))
            .setIndices(accessor(doc, buffer, 'SCALAR', surface.indices)),
        )
      }
      for (const name of new Set(members.map((s) => s.node))) {
        calls.set(name, {
          before: members.filter((s) => s.node === name).length,
          after: baked.filter((s) => s.node === name).length,
        })
      }
    }
  }
  for (const [name, mesh] of meshes) {
    if (!mesh.listPrimitives().length) {
      mesh.dispose()
      continue
    }
    const count = mesh.listPrimitives().length
    const meshTriangles = mesh
      .listPrimitives()
      .reduce((s, p) => s + p.getIndices()!.getCount() / 3, 0)
    triangles += meshTriangles
    primitives += count
    const call = calls.get(name)
    console.log(
      `  ${variant.name} ${name}: ${count} primitives` +
        (call ? ` (${call.before} materials before baking)` : '') +
        `, ${meshTriangles} triangles`,
    )
    // Mesh on a child node: quantization rescales mesh nodes, the joint node stays exact.
    nodes.get(name)!.addChild(doc.createNode(`${name}:mesh`).setMesh(mesh))
  }

  // The turret's lamp: WATSON's LEDs ring its lens and light what it looks at, along its URDF
  // frame's x axis (the lens sits at that end of NASA's camera). The node lies at the lens and
  // records that direction in its own frame, which is the turret link's.
  const watson = urdfPoses.get('Frame_WATSON')
  if (!watson) throw new Error('rover-model: the URDF has no WATSON frame.')
  const turretPose = nodePose.get('arm_5')!
  const lens = toApp(watson.pose)
  const inTurret = compose(invert(turretPose), lens)
  nodes.get('arm_5')!.addChild(
    doc
      .createNode('turret')
      .setTranslation(round(inTurret.t))
      .setExtras({ beam: round([inTurret.r[0], inTurret.r[3], inTurret.r[6]]) }),
  )

  // --- Only the new tree remains: NASA's scene, rig and animations go.
  for (const old of root.listScenes()) if (old !== scene) old.dispose()
  for (const animation of root.listAnimations()) animation.dispose()
  for (const skin of root.listSkins()) skin.dispose()
  for (const node of root.listNodes()) if (!isUnder(node, scene)) node.dispose()
  root.setDefaultScene(scene)
  for (const extension of root.listExtensionsUsed()) {
    if (extension.extensionName === 'KHR_draco_mesh_compression') extension.dispose()
  }
  await doc.transform(prune({ keepExtras: true, keepLeaves: true }))
  root.getAsset().extras = {
    credit: 'NASA/JPL-Caltech',
    sources: [
      `github.com/${NASA.repo}@${NASA.commit}/${NASA.path}`,
      `github.com/${URDF.repo}@${URDF.commit}`,
    ],
  }

  const plain = join(work, `assembled-${variant.name}.glb`)
  await io.write(plain, doc)
  const out = join(work, `${variant.name}.glb`)
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
    ...(variant.kind === 'ghost' ? ['--quantize-normal', String(QUANTIZE.flatNormal)] : []),
  )
  console.log(`  NASA mast frame: t = ${deployedAt.toFixed(3)} s`)
  return {
    triangles,
    primitives,
    baked,
    residuals: fit.residuals,
    bytes: { meshopt: statSync(out).size, plain: statSync(plain).size },
    out,
  }
}

/**
 * A rod's two joints from its vertices: it runs fore and aft, so each end is the middle of the
 * vertices within 5 mm of its extreme x; the aft end meets the bar, the forward one the crank.
 */
function rodEndsOf(points: Vec3[]): { bar: Vec3; crank: Vec3 } {
  const xs = points.map((p) => p[0])
  const endAt = (x: number): Vec3 => {
    const near = points.filter((p) => Math.abs(p[0] - x) < 0.005)
    const box = [0, 1, 2].map((k) => {
      const values = near.map((p) => p[k]!)
      return (Math.min(...values) + Math.max(...values)) / 2
    })
    return box as Vec3
  }
  return { bar: endAt(Math.min(...xs)), crank: endAt(Math.max(...xs)) }
}

function isUnder(node: GltfNode, scene: { listChildren(): GltfNode[] }): boolean {
  let top = node
  for (let parent = node.getParentNode(); parent; parent = parent.getParentNode()) top = parent
  return scene.listChildren().includes(top)
}

function accessor(
  doc: Document,
  buffer: ReturnType<Document['createBuffer']>,
  type: 'VEC3' | 'VEC2' | 'SCALAR',
  array: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>,
) {
  return doc.createAccessor().setType(type).setArray(array).setBuffer(buffer)
}

function centroid(b: Baked, t: number): Vec3 {
  const out: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const v = b.indices[3 * t + k]!
    for (let i = 0; i < 3; i++) out[i]! += b.positions[3 * v + i]! / 3
  }
  return out
}

function nearestIndex(points: Vec3[], p: Vec3): number {
  let best = 0
  let bestD = Infinity
  points.forEach((q, i) => {
    const d = Math.hypot(...sub(p, q))
    if (d < bestD) [best, bestD] = [i, d]
  })
  return best
}

/** The listed triangles as one indexed mesh, their vertices carried into a node's frame. */
function gather(list: { b: Baked; t: number }[], inNode: Rigid, textured: boolean) {
  const remap = new Map<Baked, Map<number, number>>()
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (const { b, t } of list) {
    let map = remap.get(b)
    if (!map) remap.set(b, (map = new Map()))
    for (let k = 0; k < 3; k++) {
      const v = b.indices[3 * t + k]!
      let out = map.get(v)
      if (out === undefined) {
        out = positions.length / 3
        map.set(v, out)
        const p: Vec3 = [b.positions[3 * v]!, b.positions[3 * v + 1]!, b.positions[3 * v + 2]!]
        const n: Vec3 = [b.normals[3 * v]!, b.normals[3 * v + 1]!, b.normals[3 * v + 2]!]
        positions.push(...transformPoint(inNode, p))
        normals.push(...apply(inNode.r, n))
        if (textured) uvs.push(b.uvs![2 * v]!, b.uvs![2 * v + 1]!)
      }
      indices.push(out)
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    ...(textured && { uvs: Float32Array.from(uvs) }),
    indices: Uint32Array.from(indices),
  }
}

/**
 * The low-poly model's parts fitted together (`rover-model/ghost-fit.ts`), each in its node's
 * frame, each wheel its fitted tread and hub. Prints what the fit chose and how its silhouette and
 * extents compare with the full model's.
 */
function fitParts(
  baked: Baked[],
  nodePose: Map<string, Rigid>,
  options: GhostFitOptions,
): Map<string, Solid[]> {
  const byPart = new Map<string, number[]>()
  for (const b of baked) {
    for (let t = 0; t < b.part.length; t++) {
      let list = byPart.get(b.part[t]!)
      if (!list) byPart.set(b.part[t]!, (list = []))
      for (let k = 0; k < 3; k++) {
        const v = b.indices[3 * t + k]!
        list.push(b.positions[3 * v]!, b.positions[3 * v + 1]!, b.positions[3 * v + 2]!)
      }
    }
  }
  const parts: GhostPart[] = []
  for (const [name, placed] of nodePose) {
    const list = byPart.get(name)
    if (!list) continue
    const inNode = invert(placed)
    const triangles = new Float32Array(list.length)
    for (let i = 0; i < list.length; i += 3) {
      triangles.set(transformPoint(inNode, [list[i]!, list[i + 1]!, list[i + 2]!]), i)
    }
    // A wheel turns about its node's y axis. Its rim is open between the spokes, which no convex
    // piece draws: a fitted tread, rim and hub do.
    const fixed = WHEELS.some((w) => w.node === name)
      ? wheel(triangles, { axis: [0, 1, 0], ...GHOST_WHEEL })
      : undefined
    parts.push({ name, pose: placed, triangles, ...(fixed && { fixed }) })
  }
  const started = Date.now()
  const fit = fitGhost(parts, options)
  console.log(`  ghost fitted in ${((Date.now() - started) / 1000).toFixed(1)} s`)

  const full: number[] = []
  const ghost: number[] = []
  for (const part of parts) {
    const solids = fit.shapes.get(part.name)!
    const local = solids.flatMap((s) => [...trianglesOf(s)])
    const delta = boundsDelta(boundsOf(part.triangles), boundsOf(local))
    const choices = fit.choices.get(part.name)!
    console.log(
      `  ghost ${part.name}: ${local.length / 9} triangles, extent within ` +
        `${(delta * 100).toFixed(2)} cm (${choices.map((c) => `${c.kind} ${c.triangles}`).join(', ')})`,
    )
    const { r, t } = part.pose
    for (const s of solids) ghost.push(...trianglesOf(moved(s, r, t)))
    for (let i = 0; i < part.triangles.length; i += 3) {
      const p: Vec3 = [part.triangles[i]!, part.triangles[i + 1]!, part.triangles[i + 2]!]
      full.push(...transformPoint(nodePose.get(part.name)!, p))
    }
  }
  const iou = SILHOUETTE_VIEWS.map(
    ({ name, look }) =>
      `${name} ${silhouetteIoU(full, ghost, look, options.resolution).toFixed(4)}`,
  )
  console.log(`  ghost silhouette IoU: ${iou.join(', ')}`)
  return fit.shapes
}

/** The arm joints at {@link ARM_STOWED}, checked against the URDF's names and limits. */
function stowedArm(joints: UrdfJoint[]): Map<string, number> {
  return new Map(
    ARM_JOINTS.map(({ node, urdf, limit }) => {
      const joint = joints.find((j) => j.name === urdf)
      if (!joint?.limit || joint.limit.some((x, k) => x !== limit[k])) {
        throw new Error(`rover-model: the URDF's ${urdf} is not the arm joint ${node} expects.`)
      }
      return [urdf, ARM_STOWED[node]] as const
    }),
  )
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

const src =
  process.argv[2] ??
  join(tmpdir(), `ai-rover-model-${URDF.commit.slice(0, 7)}-${NASA.commit.slice(0, 7)}`)
mkdirSync(src, { recursive: true })
const work = mkdtempSync(join(src, 'build-'))
await ensureSources(src)

const built: { variant: Variant; out: string }[] = []
for (const variant of VARIANTS) {
  const { triangles, primitives, baked, residuals, bytes, out } = await build(src, work, variant)
  built.push({ variant, out })
  if (variant.kind === 'full') {
    for (const [joint, value] of baked) {
      const degrees = ((value * 180) / Math.PI).toFixed(3)
      console.log(`baked ${joint} = ${value.toFixed(6)} rad (${degrees}°)`)
    }
    const mm = residuals.map((r) => (r * 1000).toFixed(2))
    const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length) * 1000
    console.log(
      `fit residuals at the wheel centres: ${mm.join(', ')} mm (rms ${rms.toFixed(2)} mm)`,
    )
  }
  console.log(
    `${variant.name}: ${triangles} triangles, ${primitives} primitives, ` +
      `${bytes.meshopt} bytes (${bytes.plain} before meshopt)`,
  )
}

// The files are named by their content, so a browser and the CDN keep each one for good; the
// app reads the names from `FILES_LIST`. The previous build's files go.
const previous = existsSync(FILES_LIST)
  ? (JSON.parse(readFileSync(FILES_LIST, 'utf8')) as Record<string, string>)
  : {}
mkdirSync(OUT_DIR, { recursive: true })
for (const file of readdirSync(OUT_DIR)) if (file.endsWith('.glb')) rmSync(join(OUT_DIR, file))
const files: Record<string, string> = {}
for (const { variant, out } of built) {
  const bytes = readFileSync(out)
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const name = `${variant.name}.${hash}.glb`
  writeFileSync(join(OUT_DIR, name), bytes)
  files[variant.file] = `${MODELS_URL}${name}`
  // The build is deterministic for the pinned sources: a rebuild must give the same bytes.
  const before = previous[variant.file]
  console.log(
    `${name}: ` +
      (before === files[variant.file]
        ? 'byte-identical to the previous build'
        : before
          ? `differs from the previous build (${before.slice(MODELS_URL.length)})`
          : 'no previous build to compare'),
  )
}
writeFileSync(FILES_LIST, `${JSON.stringify(files, null, 2)}\n`)
