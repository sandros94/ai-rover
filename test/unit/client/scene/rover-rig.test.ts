import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { Point3, RoverPose } from '#shared/utils/rover'
import { ARM_JOINTS, ARM_STOWED, DEFAULT_ROVER_GEOMETRY, poseOnTerrain } from '#shared/utils/rover'
import type { Quat } from '#shared/utils/client/scene/placement'
import { flatFrame } from '#shared/utils/client/scene/placement'
import type { RigNode } from '#shared/utils/client/scene/rover-rig'
import { RIG_JOINTS, rigTransforms, ROVER_RIG_NODES } from '#shared/utils/client/scene/rover-rig'

const DEG = Math.PI / 180
const MODEL_DIR = fileURLToPath(new URL('../../../../public/models/rover/', import.meta.url))

interface GltfNode {
  name?: string
  translation?: [number, number, number]
  rotation?: [number, number, number, number]
  children?: number[]
  extras?: {
    joint?: string
    axis?: [number, number, number]
    aim?: { node: string; point: [number, number, number]; from: [number, number, number] }
  }
}

/** The glTF JSON chunk of a binary glTF: the node tree, without any three.js. */
function readNodes(file: string): GltfNode[] {
  const bytes = readFileSync(`${MODEL_DIR}${file}`)
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67) // 'glTF'
  const length = bytes.readUInt32LE(12)
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a) // 'JSON'
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as { nodes: GltfNode[] }
  return json.nodes
}

/** Each named node with its parent's name. */
function tree(nodes: GltfNode[]): Map<string, { node: GltfNode; parent?: string }> {
  const out = new Map<string, { node: GltfNode; parent?: string }>()
  nodes.forEach((node) => out.set(node.name!, { node }))
  for (const node of nodes) {
    for (const child of node.children ?? []) out.get(nodes[child]!.name!)!.parent = node.name
  }
  return out
}

function rotate(q: Quat, p: Point3): Point3 {
  const tx = 2 * (q.y * p.z - q.z * p.y)
  const ty = 2 * (q.z * p.x - q.x * p.z)
  const tz = 2 * (q.x * p.y - q.y * p.x)
  return {
    x: p.x + q.w * tx + (q.y * tz - q.z * ty),
    y: p.y + q.w * ty + (q.z * tx - q.x * tz),
    z: p.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 }

/**
 * World position of a node's origin: the model's node tree with the rig's joint rotations
 * applied on top of each node's own rotation, under the rig's body placement.
 */
function worldOrigin(
  nodes: Map<string, { node: GltfNode; parent?: string }>,
  rig: ReturnType<typeof rigTransforms>,
  name: string,
): Point3 {
  return worldPose(nodes, rig, name).position
}

/** World position and orientation of a node, as `worldOrigin` composes them. */
function worldPose(
  nodes: Map<string, { node: GltfNode; parent?: string }>,
  rig: ReturnType<typeof rigTransforms>,
  name: string,
): { position: Point3; orientation: Quat } {
  const chain: GltfNode[] = []
  for (let current: string | undefined = name; current; current = nodes.get(current)!.parent) {
    chain.unshift(nodes.get(current)!.node)
  }
  let position = rig.position
  let orientation = rig.quaternion
  for (const node of chain) {
    const [tx, ty, tz] = node.translation ?? [0, 0, 0]
    const offset = rotate(orientation, { x: tx, y: ty, z: tz })
    position = { x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z }
    const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1]
    const joint = rig.joints[node.name as RigNode] ?? IDENTITY
    orientation = multiply(multiply(orientation, { x: qx, y: qy, z: qz, w: qw }), joint)
  }
  return { position, orientation }
}

/** The keyframe a producer writes for a solved pose. */
function frameOf(pose: RoverPose): Float32Array {
  const out = new Float32Array(KEYFRAME_STRIDE)
  const values: Partial<Record<(typeof KEYFRAME_FIELDS)[number], number>> = {
    x: pose.position.x,
    y: pose.position.y,
    z: pose.position.z,
    qx: pose.quaternion.x,
    qy: pose.quaternion.y,
    qz: pose.quaternion.z,
    qw: pose.quaternion.w,
    rockerL: pose.rocker.left,
    rockerR: pose.rocker.right,
    bogieL: pose.bogie.left,
    bogieR: pose.bogie.right,
  }
  for (const [name, v] of Object.entries(values)) {
    out[KEYFRAME_FIELDS.indexOf(name as (typeof KEYFRAME_FIELDS)[number])] = v!
  }
  return out
}

function withField(frame: Float32Array, name: (typeof KEYFRAME_FIELDS)[number], v: number) {
  const out = frame.slice()
  out[KEYFRAME_FIELDS.indexOf(name)] = v
  return out
}

const isIdentity = (q: Quat) =>
  Math.abs(q.x) < 1e-12 && Math.abs(q.y) < 1e-12 && Math.abs(q.z) < 1e-12 && q.w > 1 - 1e-12

const HUBS = ['wheel_lf', 'wheel_rf', 'wheel_lm', 'wheel_rm', 'wheel_lr', 'wheel_rr'] as const
const distance = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

describe('rigTransforms', () => {
  it('leaves every joint at the identity on the flat frame', () => {
    const rig = rigTransforms(flatFrame({ x: 3, y: 4, z: 5, headingRad: 1 }))
    expect(Object.keys(rig.joints).sort()).toEqual([...ROVER_RIG_NODES].sort())
    for (const name of ROVER_RIG_NODES) expect(isIdentity(rig.joints[name])).toBe(true)
    expect(rig.position).toEqual({ x: 3, y: 4, z: 5 })
  })

  it('turns only the left bogie for a 10° left bogie, about an axis along the axles', () => {
    const rig = rigTransforms(
      withField(flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }), 'bogieL', 10 * DEG),
    )
    const turned = ROVER_RIG_NODES.filter((name) => !isIdentity(rig.joints[name]))
    expect(turned).toEqual(['left_bogie'])
    const q = rig.joints.left_bogie
    // A rotation about ±y by 10°.
    expect(Math.abs(q.x)).toBeLessThan(1e-12)
    expect(Math.abs(q.z)).toBeLessThan(1e-12)
    expect(2 * Math.acos(q.w)).toBeCloseTo(10 * DEG, 6)
    // Positive bogie raises the middle wheel: its hub, ahead of the pivot, goes up.
    const ahead = rotate(q, { x: 1, y: 0, z: 0 })
    expect(ahead.z).toBeGreaterThan(0.1)
  })

  it('steers the corner wheels about the body up axis, a positive angle turning the front left', () => {
    const rig = rigTransforms(
      withField(flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }), 'steerRL', 0.5),
    )
    const turned = ROVER_RIG_NODES.filter((name) => !isIdentity(rig.joints[name]))
    expect(turned).toEqual(['steer_lr'])
    const forward = rotate(rig.joints.steer_lr, { x: 1, y: 0, z: 0 })
    expect(Math.atan2(forward.y, forward.x)).toBeCloseTo(0.5, 6)
    expect(forward.z).toBeCloseTo(0, 12)
  })

  it('spins the wheels about their axles, forward spin carrying the top forward', () => {
    const rig = rigTransforms(
      withField(flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }), 'spinRR', Math.PI / 2),
    )
    const top = rotate(rig.joints.wheel_rr, { x: 0, y: 0, z: 1 })
    // The keyframe holds float32 values.
    expect(top.x).toBeCloseTo(1, 6)
    expect(top.z).toBeCloseTo(0, 6)
  })
})

describe('the rig on rover.glb', () => {
  const nodes = tree(readNodes('rover.glb'))

  it('names a node for every rig joint, turning about the URDF joint axis', () => {
    const fromModel = ROVER_RIG_NODES.map((name) => {
      const extras = nodes.get(name)?.node.extras
      const [x, y, z] = extras?.axis ?? []
      return { name, joint: extras?.joint, axis: { x, y, z } }
    })
    const fromRig = ROVER_RIG_NODES.map((name) => ({
      name,
      joint: RIG_JOINTS[name].urdf,
      axis: RIG_JOINTS[name].axis,
    }))
    expect(fromModel).toEqual(fromRig)
  })

  it('hangs the wheels on the chassis, rockers and bogies as the URDF does', () => {
    const parents = Object.fromEntries(HUBS.map((h) => [h, nodes.get(h)!.parent]))
    expect(parents).toEqual({
      wheel_lf: 'steer_lf',
      wheel_rf: 'steer_rf',
      wheel_lm: 'left_bogie',
      wheel_rm: 'right_bogie',
      wheel_lr: 'steer_lr',
      wheel_rr: 'steer_rr',
    })
    expect(nodes.get('steer_lf')!.parent).toBe('left_rocker')
    expect(nodes.get('steer_lr')!.parent).toBe('left_bogie')
    expect(nodes.get('left_bogie')!.parent).toBe('left_rocker')
    expect(nodes.get('left_rocker')!.parent).toBe('chassis')
    expect(nodes.get('differential')!.parent).toBe('chassis')
  })

  it('bakes the mast deployed: head on top, Navcam boresight level and forward', () => {
    expect(nodes.get('mast_azimuth')!.parent).toBe('chassis')
    expect(nodes.get('mast_elevation')!.parent).toBe('mast_azimuth')
    const baked = ['mast_azimuth', 'mast_elevation'].map((name) => {
      const extras = nodes.get(name)!.node.extras as { joint?: string; baked?: number }
      return [extras.joint, extras.baked]
    })
    // 181° and 91°: the URDF's zero leaves the head facing the deck, turned aft.
    expect(baked).toEqual([
      ['RSM_AZ_ENC', 3.159045],
      ['RSM_EL_ENC', 1.588253],
    ])
    const rest = rigTransforms(flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }))
    const head = worldPose(nodes, rest, 'mast_elevation')
    // The elevation axis sits 1.92 m above the ground, above the mast foot on the deck.
    expect(head.position.z).toBeCloseTo(1.919, 3)
    // The Navcam boresight is the elevation link's +x (URDF and body frames share x).
    const boresight = rotate(head.orientation, { x: 1, y: 0, z: 0 })
    expect(distance(boresight, { x: 1, y: 0, z: 0 })).toBeLessThan(1e-4)
  })

  it('pivots the rockers and bogies where the solver geometry does', () => {
    const rest = rigTransforms(flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }))
    const rocker = worldOrigin(nodes, rest, 'left_rocker')
    const bogie = worldOrigin(nodes, rest, 'left_bogie')
    const { rockerPivot, bogiePivot } = DEFAULT_ROVER_GEOMETRY
    expect(Math.hypot(rocker.x - rockerPivot.x, rocker.z - rockerPivot.z)).toBeLessThan(5e-4)
    expect(Math.hypot(bogie.x - bogiePivot.x, bogie.z - bogiePivot.z)).toBeLessThan(5e-4)
  })

  it('puts the wheel hubs within 5 mm of the solver on flat ground', () => {
    const pose = poseOnTerrain(() => 0, { x: 7, y: -3, headingRad: 0.6 })
    const rig = rigTransforms(frameOf(pose))
    const off = HUBS.filter(
      (hub, k) => distance(worldOrigin(nodes, rig, hub), pose.wheels[k]!) >= 0.005,
    )
    expect(off).toEqual([])
  })

  it('follows the solver within 5 mm with the left rear wheel up a step', () => {
    // A 20 cm ledge under the left rear wheel only.
    const ground = (x: number, y: number) => (x < -0.8 && y > 0.6 ? 0.2 : 0)
    const pose = poseOnTerrain(ground, { x: 0, y: 0, headingRad: 0 })
    expect(pose.bogie.left).toBeLessThan(-5 * DEG)
    const rig = rigTransforms(frameOf(pose))
    const off = HUBS.filter(
      (hub, k) => distance(worldOrigin(nodes, rig, hub), pose.wheels[k]!) >= 0.005,
    )
    expect(off).toEqual([])
    // The rig's signs matter: the same angles negated put the rear hub far off.
    const flipped = rigTransforms(
      withField(withField(frameOf(pose), 'bogieL', -pose.bogie.left), 'rockerL', -pose.rocker.left),
    )
    expect(distance(worldOrigin(nodes, flipped, 'wheel_lr'), pose.wheels[4]!)).toBeGreaterThan(0.1)
  })
  /** A rod's two ends in the world: its bar end, and where it says its crank's top is. */
  function rodEnds(rig: ReturnType<typeof rigTransforms>, side: 'left' | 'right') {
    const rod = `${side}_differential_link`
    const aim = nodes.get(rod)!.node.extras!.aim!
    const at = (name: string, [x, y, z]: [number, number, number]) => {
      const pose = worldPose(nodes, rig, name)
      const offset = rotate(pose.orientation, { x, y, z })
      return {
        x: pose.position.x + offset.x,
        y: pose.position.y + offset.y,
        z: pose.position.z + offset.z,
      }
    }
    return { bar: at(rod, [0, 0, 0]), rest: at(rod, aim.from), crank: at(aim.node, aim.point) }
  }

  it('hangs each differential rod from the bar, aimed at the crank on its rocker', () => {
    const rest = rigTransforms(flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }))
    for (const side of ['left', 'right'] as const) {
      const rod = nodes.get(`${side}_differential_link`)!
      expect(rod.parent).toBe('differential')
      expect(rod.node.extras?.aim?.node).toBe(`${side}_rocker`)
      const { rest: tip, crank } = rodEnds(rest, side)
      expect(distance(tip, crank)).toBeLessThan(5e-4)
    }
  })

  it('keeps each rod within 3 mm of its length as the rockers swing 7° either way', () => {
    const rest = rigTransforms(flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }))
    for (const side of ['left', 'right'] as const) {
      const { bar, crank } = rodEnds(rest, side)
      const length = distance(bar, crank)
      for (const rocker of [-7 * DEG, 7 * DEG]) {
        const frame = withField(
          withField(flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }), 'rockerL', rocker),
          'rockerR',
          -rocker,
        )
        const swung = rodEnds(rigTransforms(frame), side)
        expect(Math.abs(distance(swung.bar, swung.crank) - length)).toBeLessThan(0.003)
      }
    }
  })

  it('hangs the turret lamp from the last arm link, at the stowed WATSON camera ahead of the body on the left', () => {
    expect(nodes.get('turret')!.parent).toBe('arm_5')
    const rig = rigTransforms(flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }))
    const { x, y, z } = worldOrigin(nodes, rig, 'turret')
    expect(x).toBeGreaterThan(0.9)
    expect(y).toBeGreaterThan(0.5)
    expect(z).toBeGreaterThan(1.2)
    expect(z).toBeLessThan(1.6)
    const beam = nodes.get('turret')!.node.extras as { beam?: number[] }
    expect(Math.hypot(...beam.beam!)).toBeCloseTo(1, 5)
  })

  it('carries the arm as five URDF joints from the chassis out, at rest in the stowed pose', () => {
    let parent = 'chassis'
    for (const { node, urdf, limit } of ARM_JOINTS) {
      const entry = nodes.get(node)!
      expect(entry.parent).toBe(parent)
      const extras = entry.node.extras as { joint?: string; limit?: number[]; baked?: number }
      expect(extras.joint).toBe(urdf)
      expect(extras.limit).toEqual(limit)
      expect(extras.baked).toBeCloseTo(ARM_STOWED[node], 6)
      parent = node
    }
  })
})
