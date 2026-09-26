import { describe, expect, it } from 'vitest'
import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { Point3, RoverPose } from '#shared/utils/rover'
import { DEFAULT_ROVER_GEOMETRY as G, poseOnTerrain } from '#shared/utils/rover'
import {
  frameAttitude,
  levelPoint,
  roverLinkage,
} from '#shared/utils/client/instruments/attitude-geometry'
import type { Quat, RoverPart } from '#shared/utils/client/scene/rover-parts'
import { flatFrame, framePlacement, roverParts } from '#shared/utils/client/scene/rover-parts'

const DEG = Math.PI / 180

/** The keyframe a producer writes for a solved pose, spins as given. */
function frameOf(pose: RoverPose, spins = [0, 0, 0, 0, 0, 0]): Float32Array {
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
    spinFL: spins[0],
    spinFR: spins[1],
    spinML: spins[2],
    spinMR: spins[3],
    spinRL: spins[4],
    spinRR: spins[5],
  }
  for (const [name, v] of Object.entries(values)) {
    out[KEYFRAME_FIELDS.indexOf(name as (typeof KEYFRAME_FIELDS)[number])] = v!
  }
  return out
}

function rotate(q: Quat, p: Point3): Point3 {
  // p + 2w(v × p) + 2 v × (v × p)
  const tx = 2 * (q.y * p.z - q.z * p.y)
  const ty = 2 * (q.z * p.x - q.x * p.z)
  const tz = 2 * (q.x * p.y - q.y * p.x)
  return {
    x: p.x + q.w * tx + (q.y * tz - q.z * ty),
    y: p.y + q.w * ty + (q.z * tx - q.x * tz),
    z: p.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

function toWorld(frame: Float32Array, p: Point3): Point3 {
  const { position, quaternion } = framePlacement(frame)
  const r = rotate(quaternion, p)
  return { x: position.x + r.x, y: position.y + r.y, z: position.z + r.z }
}

const byName = (parts: RoverPart[], name: string) => {
  const part = parts.find((p) => p.name === name)
  if (!part) throw new Error(`no part ${name}`)
  return part
}

const WHEELS = ['FL', 'FR', 'ML', 'MR', 'RL', 'RR']

describe('roverParts at the flat pose', () => {
  const pose = poseOnTerrain(() => 0, { x: 12, y: -4, headingRad: 0.7 })
  const frame = frameOf(pose)
  const parts = roverParts(frameAttitude(frame), G)

  it('puts the wheel centres at the geometry', () => {
    const mounts = [G.frontWheel, G.middleWheel, G.rearWheel]
    WHEELS.forEach((name, k) => {
      const mount = mounts[k >> 1]!
      const wheel = byName(parts, `wheel-${name}`)
      expect(wheel.position.x).toBeCloseTo(mount.x, 9)
      expect(wheel.position.y).toBeCloseTo(k % 2 ? -mount.y : mount.y, 9)
      expect(wheel.position.z).toBeCloseTo(G.wheelRadius, 9)
      expect(wheel.scale).toEqual({ x: 2 * G.wheelRadius, y: G.wheelWidth, z: 2 * G.wheelRadius })
    })
  })

  it('stands the body where the solver stands it: belly at its clearance above the ground', () => {
    expect(pose.position.z).toBeCloseTo(0, 9)
    const body = byName(parts, 'body')
    expect(toWorld(frame, body.position).z - body.scale.z / 2).toBeCloseTo(G.bellyClearance, 6)
  })

  it('draws the rocker and bogie links between the joints the 2D attitude view uses', () => {
    const linkage = roverLinkage({ ...frameAttitude(frame), pitchRad: 0, rollRad: 0 }, G)
    for (const [side, s] of [
      ['L', 0],
      ['R', 1],
    ] as const) {
      const front = byName(parts, `rocker-front-${side}`).ends!
      const rear = byName(parts, `rocker-rear-${side}`).ends!
      const bogieM = byName(parts, `bogie-middle-${side}`).ends!
      const bogieR = byName(parts, `bogie-rear-${side}`).ends!
      const side2d = (p: Point3) => [p.x, p.z]
      expect(side2d(front[0])).toEqual(side2d(linkage.rockerPivots[s]!).map(close))
      expect(side2d(front[1])).toEqual(side2d(linkage.wheels[s]!).map(close))
      expect(side2d(rear[1])).toEqual(side2d(linkage.bogiePivots[s]!).map(close))
      expect(side2d(bogieM[0])).toEqual(side2d(linkage.bogiePivots[s]!).map(close))
      expect(side2d(bogieM[1])).toEqual(side2d(linkage.wheels[2 + s]!).map(close))
      expect(side2d(bogieR[1])).toEqual(side2d(linkage.wheels[4 + s]!).map(close))
    }
  })

  it('sets each beam between its ends: centre at the midpoint, length along its x axis', () => {
    for (const part of parts.filter((p) => p.ends)) {
      const [a, b] = part.ends!
      expect(part.position.x).toBeCloseTo((a.x + b.x) / 2, 9)
      expect(part.position.z).toBeCloseTo((a.z + b.z) / 2, 9)
      const along = rotate(part.quaternion, { x: part.scale.x / 2, y: 0, z: 0 })
      expect(part.position.x + along.x).toBeCloseTo(b.x, 9)
      expect(part.position.y + along.y).toBeCloseTo(b.y, 9)
      expect(part.position.z + along.z).toBeCloseTo(b.z, 9)
    }
  })
})

describe('roverParts on a rolled and pitched frame', () => {
  const plane = (x: number, y: number) => 0.12 * x - 0.15 * y + 0.03 * Math.sin(3 * x) * y
  const pose = poseOnTerrain(plane, { x: 3, y: 2, headingRad: -0.4 })
  const frame = frameOf(pose)
  const attitude = frameAttitude(frame)
  const parts = roverParts(attitude, G)

  it('is really tilted', () => {
    expect(Math.abs(pose.pitchRad)).toBeGreaterThan(3 * DEG)
    expect(Math.abs(pose.rollRad)).toBeGreaterThan(3 * DEG)
  })

  it('follows the frame quaternion: the wheels land on the solved wheel centres', () => {
    WHEELS.forEach((name, k) => {
      const world = toWorld(frame, byName(parts, `wheel-${name}`).position)
      // The keyframe holds float32 values: millimetre agreement is the frame's own precision.
      expect(world.x).toBeCloseTo(pose.wheels[k]!.x, 3)
      expect(world.y).toBeCloseTo(pose.wheels[k]!.y, 3)
      expect(world.z).toBeCloseTo(pose.wheels[k]!.z, 3)
    })
  })

  it('matches the 2D side view once levelled by pitch and roll', () => {
    const linkage = roverLinkage(attitude, G)
    WHEELS.forEach((name, k) => {
      const level = levelPoint(attitude, byName(parts, `wheel-${name}`).position)
      expect(level.x).toBeCloseTo(linkage.wheels[k]!.x, 6)
      expect(level.z).toBeCloseTo(linkage.wheels[k]!.z, 6)
    })
  })
})

describe('wheel spin', () => {
  it('turns the spokes with the wheel, forward spin carrying the top forward', () => {
    const pose = poseOnTerrain(() => 0, { x: 0, y: 0, headingRad: 0 })
    const still = roverParts(frameAttitude(frameOf(pose)), G)
    const turned = roverParts(frameAttitude(frameOf(pose, [Math.PI / 2, 0, 0, 0, 0, 0])), G)
    const tip = (part: RoverPart) => rotate(part.quaternion, { x: part.scale.x / 2, y: 0, z: 0 })
    const spoke = (parts: RoverPart[]) => byName(parts, 'spoke-FL-0')
    // A quarter turn forward swings the spoke's front end down to the ground.
    const before = tip(spoke(still))
    const after = tip(spoke(turned))
    expect(before.x).toBeGreaterThan(0.1)
    expect(after.z).toBeLessThan(-0.1)
    expect(Math.abs(after.x)).toBeLessThan(1e-6)
  })
})

describe('flatFrame', () => {
  it('places an unarticulated rover at a point and heading', () => {
    const frame = flatFrame({ x: 5, y: 6, z: 7, headingRad: Math.PI / 2 })
    const { position, quaternion } = framePlacement(frame)
    expect(position).toEqual({ x: 5, y: 6, z: 7 })
    const forward = rotate(quaternion, { x: 1, y: 0, z: 0 })
    expect(forward.x).toBeCloseTo(0, 6)
    expect(forward.y).toBeCloseTo(1, 6)
    const attitude = frameAttitude(frame)
    expect(attitude.rocker).toEqual({ left: 0, right: 0 })
  })
})

function close(v: number) {
  return expect.closeTo(v, 9)
}
