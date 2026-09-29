import { ARM_STOWED, DEFAULT_ROVER_GEOMETRY } from '#shared/utils/rover'
import {
  ARM_SEQUENCE_S,
  armPoseAt,
  flatFrame,
  sunCrossings,
  sunPosition,
  turretLampLevel,
} from '#shared/utils/client/scene'
import { MARS_SOL_SECONDS } from '#shared/utils/client/instruments'
import { KEYFRAME_FIELDS } from '#shared/utils/drive'

/*
 * Scripted motions for the rover-motion page: what the model does in a point turn, an arc and
 * at dusk and dawn, as pure functions of the scrub time. The angles, rates and speeds here are
 * the demo's own constants: the drive producer owns the real values, and none of these feed it.
 */

const DEG = Math.PI / 180
/** Seconds the corner wheels take to steer from straight to any stance, and back. */
const STEER_S = 8
/** Seconds held still before the motion starts and after it ends. */
const HOLD_S = 2
/** The point turn: a quarter turn to the left at 3°/s. */
const POINT_TURN_RAD = 90 * DEG
const TURN_RATE = 3 * DEG
/** The arc: left about a centre 4 m off the middle axle, at 4 cm/s for 90 s. */
const ARC_RADIUS_M = 4
const ARC_SPEED_MPS = 0.04
const ARC_DRIVE_S = 90
/** The dusk window opens a minute before sunset and runs until the lamp is full. */
const DUSK_BEFORE_S = 60
const DUSK_AFTER_S = 840
/** The dawn window opens with the lamp full and closes a minute after the arm has stowed. */
const DAWN_BEFORE_S = 840
const DAWN_AFTER_S = ARM_SEQUENCE_S + 60

export type MotionDemo = 'point-turn' | 'arc' | 'dusk-dawn'

export const MOTION_DEMOS: readonly { id: MotionDemo; title: string; durationS: number }[] = [
  {
    id: 'point-turn',
    title: 'Point turn',
    durationS: 2 * HOLD_S + 2 * STEER_S + POINT_TURN_RAD / TURN_RATE,
  },
  { id: 'arc', title: 'Arc', durationS: 2 * HOLD_S + 2 * STEER_S + ARC_DRIVE_S },
  {
    id: 'dusk-dawn',
    title: 'Dusk and dawn',
    durationS: DUSK_BEFORE_S + DUSK_AFTER_S + DAWN_BEFORE_S + DAWN_AFTER_S,
  },
]

/** The model's steered corners and every wheel, by keyframe spin field, body frame. */
const G = DEFAULT_ROVER_GEOMETRY
const WHEELS = [
  { spin: 'spinFL', steer: 'steer_lf', x: G.frontWheel.x, y: G.frontWheel.y },
  { spin: 'spinFR', steer: 'steer_rf', x: G.frontWheel.x, y: -G.frontWheel.y },
  { spin: 'spinML', steer: undefined, x: G.middleWheel.x, y: G.middleWheel.y },
  { spin: 'spinMR', steer: undefined, x: G.middleWheel.x, y: -G.middleWheel.y },
  { spin: 'spinRL', steer: 'steer_lr', x: G.rearWheel.x, y: G.rearWheel.y },
  { spin: 'spinRR', steer: 'steer_rr', x: G.rearWheel.x, y: -G.rearWheel.y },
] as const satisfies readonly {
  spin: (typeof KEYFRAME_FIELDS)[number]
  steer: string | undefined
  x: number
  y: number
}[]

/** The model's steering joints turn about the body's −z: a positive value steers right. */
const STEER_NODES = ['steer_lf', 'steer_rf', 'steer_lr', 'steer_rr'] as const

export interface MotionState {
  /** The 19 keyframe values: placement and wheel spins. */
  frame: Float32Array
  /** Steering and arm joint values by model node name, every one of them each time. */
  joints: Record<string, number>
  solFraction: number
  /** The turret lamp, 0 to 1. */
  lamp: number
}

/** The demo at `t` seconds into it, clamped to its span. */
export function motionAt(demo: MotionDemo, t: number): MotionState {
  const span = MOTION_DEMOS.find((d) => d.id === demo)!.durationS
  const at = Math.min(span, Math.max(0, t))
  if (demo === 'dusk-dawn') return twilightAt(at)
  return demo === 'point-turn'
    ? turnAbout({ x: 0, y: 0 }, TURN_RATE, POINT_TURN_RAD / TURN_RATE, at)
    : turnAbout({ x: 0, y: ARC_RADIUS_M }, ARC_SPEED_MPS / ARC_RADIUS_M, ARC_DRIVE_S, at)
}

/**
 * Steer into the stance for turning about `centre` (body frame at the start), turn about it at
 * `rate` rad/s for `turnS` seconds, steer straight again. Each wheel rolls along its circle about
 * the centre: steered square to the line from the centre, spinning at its distance from the
 * centre times the rate over the wheel radius; a centre on the middle axle leaves the middle
 * wheels straight.
 */
function turnAbout(
  centre: { x: number; y: number },
  rate: number,
  turnS: number,
  t: number,
): MotionState {
  const turning = Math.min(turnS, Math.max(0, t - HOLD_S - STEER_S))
  const steerIn = Math.min(1, Math.max(0, (t - HOLD_S) / STEER_S))
  const steerOut = Math.min(1, Math.max(0, (t - HOLD_S - STEER_S - turnS) / STEER_S))
  const stance = steerIn * (1 - steerOut)
  const heading = rate * turning
  // The body origin, carried about the centre from the start.
  const frame = flatFrame({
    x: centre.x - centre.x * Math.cos(heading) + centre.y * Math.sin(heading),
    y: centre.y - centre.x * Math.sin(heading) - centre.y * Math.cos(heading),
    z: 0,
    headingRad: heading,
  })
  const joints: Record<string, number> = { ...ARM_STOWED }
  for (const node of STEER_NODES) joints[node] = 0
  for (const wheel of WHEELS) {
    const dx = wheel.x - centre.x
    const dy = wheel.y - centre.y
    // Steered, left positive, so the wheel rolls square to the line from the centre.
    const steer = Math.atan(-dx / dy)
    if (wheel.steer) joints[wheel.steer] = -steer * stance
    // The wheel's ground velocity about the centre, along its heading.
    const along = rate * (-dy * Math.cos(steer) + dx * Math.sin(steer))
    frame[KEYFRAME_FIELDS.indexOf(wheel.spin)] = (along * turning) / G.wheelRadius
  }
  return { frame, joints, solFraction: 0.4, lamp: 0 }
}

/** The rover standing still from before sunset to after dusk, then from before dawn to after. */
function twilightAt(t: number): MotionState {
  const { rise, set } = sunCrossings()
  const dusk = DUSK_BEFORE_S + DUSK_AFTER_S
  const seconds = t < dusk ? t - DUSK_BEFORE_S : t - dusk - DAWN_BEFORE_S
  const solFraction = ((((t < dusk ? set : rise) + seconds / MARS_SOL_SECONDS) % 1) + 1) % 1
  const joints: Record<string, number> = { ...armPoseAt(solFraction) }
  for (const node of STEER_NODES) joints[node] = 0
  return {
    frame: flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }),
    joints,
    solFraction,
    lamp: turretLampLevel(sunPosition(solFraction).elevationDeg),
  }
}
