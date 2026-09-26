import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '../../drive/keyframes'
import type { ResolvedRoverGeometry } from '../../rover/geometry'
import type { Point3 } from '../../rover/kinematics'
import type { FrameAttitude } from '../instruments/attitude-geometry'
import { roverLinkage } from '../instruments/attitude-geometry'

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

/**
 * Unit shapes the parts scale: a box of side 1 centred on the origin, and a cylinder of
 * diameter 1 and height 1 along its local y axis (three.js's own cylinder axis). Closed set.
 */
export type PartShape = 'box' | 'cylinder'

/** Colour roles; the renderer maps each to a material colour. Closed set. */
export type PartTone = 'body' | 'deck' | 'link' | 'tyre' | 'spoke' | 'mast' | 'rtg'

/** One solid of the rover in the body frame (x forward, y left, z up, origin on the contact plane). */
export interface RoverPart {
  name: string
  shape: PartShape
  tone: PartTone
  position: Point3
  quaternion: Quat
  /** Size along the unit shape's local axes, metres. */
  scale: Point3
  /** For a beam: the joints it spans, in the body frame; its local x runs from the first to the second. */
  ends?: [Point3, Point3]
}

/** Box section of the rocker and bogie links, metres (lateral, vertical). */
const LINK = { width: 0.07, height: 0.1 }
/** Gap kept between the links and the inner face of the wheels. */
const LINK_CLEARANCE_M = 0.06
/** Body box height above the belly pan. */
const BODY_HEIGHT_M = 0.55
/** Spokes per wheel face, drawn as bars through the hub; three bars give six spokes. */
const SPOKE_BARS = 3

const IDENTITY: Quat = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })

/**
 * The rover's solids at an articulation, in the body frame. The joints come from the same
 * linkage the pose solver and the 2D attitude view use; laterally the rockers leave the body at
 * the belly-pan sides and run with the bogies in one plane just inside the wheels. Wheels turn
 * about their axles by their spins, forward spin carrying the top of the wheel forward.
 */
export function roverParts(
  attitude: Pick<FrameAttitude, 'rocker' | 'bogie' | 'spins'>,
  geometry: ResolvedRoverGeometry,
): RoverPart[] {
  const g = geometry
  const joints = roverLinkage({ ...attitude, pitchRad: 0, rollRad: 0 }, g)
  const innerFace = Math.min(g.frontWheel.y, g.middleWheel.y, g.rearWheel.y) - g.wheelWidth / 2
  const linkY = innerFace - LINK_CLEARANCE_M
  const parts: RoverPart[] = []
  const at = (p: Point3, y: number): Point3 => ({ x: p.x, y, z: p.z })

  const bodyBottom = g.bellyClearance
  const bodyTop = bodyBottom + BODY_HEIGHT_M
  parts.push({
    name: 'body',
    shape: 'box',
    tone: 'body',
    position: { x: g.bellyOffsetX, y: 0, z: bodyBottom + BODY_HEIGHT_M / 2 },
    quaternion: IDENTITY,
    scale: { x: g.bellyLength, y: g.bellyWidth, z: BODY_HEIGHT_M },
  })

  const names = ['L', 'R'] as const
  for (let s = 0; s < 2; s++) {
    const sign = s === 0 ? 1 : -1
    const side = names[s]
    const pivot = joints.rockerPivots[s]!
    const hub = at(pivot, sign * linkY)
    const bogie = at(joints.bogiePivots[s]!, sign * linkY)
    parts.push(
      beam(`rocker-stub-${side}`, pivot, hub),
      beam(`rocker-front-${side}`, hub, at(joints.wheels[s]!, sign * linkY)),
      beam(`rocker-rear-${side}`, hub, bogie),
      beam(`bogie-middle-${side}`, bogie, at(joints.wheels[2 + s]!, sign * linkY)),
      beam(`bogie-rear-${side}`, bogie, at(joints.wheels[4 + s]!, sign * linkY)),
    )
  }

  // The bar across the deck turns with the differential; its linkage to the rockers is not modelled.
  const differential = attitude.rocker.left
  parts.push({
    name: 'differential',
    shape: 'box',
    tone: 'link',
    position: { x: joints.rockerPivots[0]!.x, y: 0, z: bodyTop + LINK.height / 2 },
    quaternion: aboutAxis('z', differential),
    scale: { x: LINK.width, y: g.bellyWidth + 0.2, z: LINK.height },
  })

  const wheelNames = ['FL', 'FR', 'ML', 'MR', 'RL', 'RR'] as const
  for (let k = 0; k < 6; k++) {
    const centre = joints.wheels[k]!
    const sign = k % 2 === 0 ? 1 : -1
    const spin = aboutAxis('y', attitude.spins[k] ?? 0)
    parts.push(beam(`axle-${wheelNames[k]}`, at(centre, sign * linkY), centre), {
      name: `wheel-${wheelNames[k]}`,
      shape: 'cylinder',
      tone: 'tyre',
      position: centre,
      quaternion: spin,
      scale: { x: 2 * g.wheelRadius, y: g.wheelWidth, z: 2 * g.wheelRadius },
    })
    const faceY = centre.y + sign * (g.wheelWidth / 2 + 0.01)
    for (let bar = 0; bar < SPOKE_BARS; bar++) {
      parts.push({
        name: `spoke-${wheelNames[k]}-${bar}`,
        shape: 'box',
        tone: 'spoke',
        position: { x: centre.x, y: faceY, z: centre.z },
        quaternion: aboutAxis('y', (attitude.spins[k] ?? 0) + (bar * Math.PI) / SPOKE_BARS),
        scale: { x: 1.8 * g.wheelRadius, y: 0.02, z: 0.05 },
      })
    }
  }

  // Mast at the front left of the deck, RTG leaning back from the rear: they make the heading read.
  const mastX = g.bellyOffsetX + g.bellyLength / 2 - 0.25
  const mastY = g.bellyWidth / 2 - 0.2
  const mastHeight = 1.1
  parts.push(
    {
      name: 'mast',
      shape: 'cylinder',
      tone: 'mast',
      position: { x: mastX, y: mastY, z: bodyTop + mastHeight / 2 },
      quaternion: aboutAxis('x', Math.PI / 2),
      scale: { x: 0.12, y: mastHeight, z: 0.12 },
    },
    {
      name: 'mast-head',
      shape: 'box',
      tone: 'deck',
      position: { x: mastX + 0.05, y: mastY, z: bodyTop + mastHeight + 0.1 },
      quaternion: IDENTITY,
      scale: { x: 0.25, y: 0.45, z: 0.2 },
    },
  )
  const rtgLean = Math.PI / 6
  const rtgLength = 0.7
  parts.push({
    name: 'rtg',
    shape: 'cylinder',
    tone: 'rtg',
    position: {
      x: g.bellyOffsetX - g.bellyLength / 2 - (Math.cos(rtgLean) * rtgLength) / 2 + 0.1,
      y: 0,
      z: bodyTop - 0.1 + (Math.sin(rtgLean) * rtgLength) / 2,
    },
    // Local y (the cylinder axis) turned to point back and up.
    quaternion: fromTo({ x: 0, y: 1, z: 0 }, { x: -Math.cos(rtgLean), y: 0, z: Math.sin(rtgLean) }),
    scale: { x: 0.45, y: rtgLength, z: 0.45 },
  })
  return parts
}

/** A link box of the standard section spanning two joints. */
function beam(name: string, a: Point3, b: Point3): RoverPart {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const length = Math.hypot(d.x, d.y, d.z)
  return {
    name,
    shape: 'box',
    tone: 'link',
    position: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
    quaternion: fromTo({ x: 1, y: 0, z: 0 }, { x: d.x / length, y: d.y / length, z: d.z / length }),
    scale: { x: length, y: LINK.width, z: LINK.height },
    ends: [a, b],
  }
}

function aboutAxis(axis: 'x' | 'y' | 'z', angle: number): Quat {
  const s = Math.sin(angle / 2)
  return {
    x: axis === 'x' ? s : 0,
    y: axis === 'y' ? s : 0,
    z: axis === 'z' ? s : 0,
    w: Math.cos(angle / 2),
  }
}

/**
 * The shortest rotation taking unit vector `a` onto unit vector `b`. For opposite vectors it
 * turns half a revolution about an axis perpendicular to `a`.
 */
function fromTo(a: Point3, b: Point3): Quat {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  if (dot < -1 + 1e-12) {
    const axis = Math.abs(a.x) < 0.9 ? { x: 0, y: a.z, z: -a.y } : { x: -a.z, y: 0, z: a.x }
    const n = Math.hypot(axis.x, axis.y, axis.z)
    return { x: axis.x / n, y: axis.y / n, z: axis.z / n, w: 0 }
  }
  const q = {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
    w: 1 + dot,
  }
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }
}

const field = (name: (typeof KEYFRAME_FIELDS)[number]) => KEYFRAME_FIELDS.indexOf(name)

/**
 * Where a keyframe puts the body frame in the world: the recorded position and world-from-body
 * quaternion, used as they are. The producer solved the pose; the client never re-solves it.
 */
export function framePlacement(frame: ArrayLike<number>): { position: Point3; quaternion: Quat } {
  return {
    position: { x: frame[field('x')]!, y: frame[field('y')]!, z: frame[field('z')]! },
    quaternion: {
      x: frame[field('qx')]!,
      y: frame[field('qy')]!,
      z: frame[field('qz')]!,
      w: frame[field('qw')]!,
    },
  }
}

/** A keyframe of a level, unarticulated rover at rest: for markers such as death ghosts. */
export function flatFrame(pose: Point3 & { headingRad: number }): Float32Array {
  const frame = new Float32Array(KEYFRAME_STRIDE)
  frame[field('x')] = pose.x
  frame[field('y')] = pose.y
  frame[field('z')] = pose.z
  frame[field('qz')] = Math.sin(pose.headingRad / 2)
  frame[field('qw')] = Math.cos(pose.headingRad / 2)
  return frame
}
