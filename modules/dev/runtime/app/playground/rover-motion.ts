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
import {
  DEFAULT_SPEED_MODEL,
  driveLimits,
  KEYFRAME_FIELDS,
  moveAt,
  planMove,
  steeringFor,
  steerLimits,
  steerTravelRad,
  STRAIGHT_WHEELS,
  turnLimits,
} from '#shared/utils/drive'
import type { Move, Steering } from '#shared/utils/drive'
import type { Motion } from '#shared/utils/nav'

/*
 * Scripted motions for the rover-motion page: what the model does in a point turn, an arc and
 * at dusk and dawn, as pure functions of the scrub time. The turn and the arc move as the drive
 * producer moves the rover, on its wheel angles and rolls (`steeringFor`) and its steering, turn
 * and drive limits on flat ground; the angle turned and the arc driven are the demo's own.
 */

const DEG = Math.PI / 180
/** Seconds held still before the motion starts and after it ends. */
const HOLD_S = 2
/** The dusk window opens a minute before sunset and runs until the lamp is full. */
const DUSK_BEFORE_S = 60
const DUSK_AFTER_S = 840
/** The dawn window opens with the lamp full and closes a minute after the arm has stowed. */
const DAWN_BEFORE_S = 840
const DAWN_AFTER_S = ARM_SEQUENCE_S + 60

const STEER_FIELDS = ['steerFL', 'steerFR', 'steerRL', 'steerRR'] as const
const SPIN_FIELDS = ['spinFL', 'spinFR', 'spinML', 'spinMR', 'spinRL', 'spinRR'] as const
const field = (name: (typeof KEYFRAME_FIELDS)[number]) => KEYFRAME_FIELDS.indexOf(name)

interface DemoPlan {
  motion: Motion
  steering: Steering
  /** The corner wheels' steering from straight into the motion's stance, and back. */
  steer: Move
  /** The turn's radians or the arc's metres. */
  move: Move
}

/**
 * `motion` from rest to rest as the producer drives it from straight wheels: the corner wheels
 * steer standing still, all four on the one move of the largest change; the rover turns in place
 * at the turn limits, or drives the arc at the flat-ground cruise speed; the wheels steer
 * straight again.
 */
function demoPlan(motion: Motion): DemoPlan {
  const steering = steeringFor(motion)
  const steer = planMove(steerTravelRad(STRAIGHT_WHEELS, steering.angles), steerLimits())
  const move =
    motion.type === 'turn'
      ? planMove(Math.abs(motion.angleRad), turnLimits())
      : planMove(motion.lengthM, driveLimits(DEFAULT_SPEED_MODEL.cruiseSpeedMps))
  return { motion, steering, steer, move }
}

const PLANS = {
  /** A quarter turn to the left. */
  'point-turn': demoPlan({ type: 'turn', angleRad: 90 * DEG }),
  /** Left about a centre 4 m off the body's middle, 3.6 m along the arc. */
  'arc': demoPlan({ type: 'arc', lengthM: 3.6, curvature: 1 / 4 }),
}
const planSpan = ({ steer, move }: DemoPlan) => 2 * HOLD_S + 2 * steer.durationS + move.durationS

export type MotionDemo = 'point-turn' | 'arc' | 'dusk-dawn'

export const MOTION_DEMOS: readonly { id: MotionDemo; title: string; durationS: number }[] = [
  { id: 'point-turn', title: 'Point turn', durationS: planSpan(PLANS['point-turn']) },
  { id: 'arc', title: 'Arc', durationS: planSpan(PLANS.arc) },
  {
    id: 'dusk-dawn',
    title: 'Dusk and dawn',
    durationS: DUSK_BEFORE_S + DUSK_AFTER_S + DAWN_BEFORE_S + DAWN_AFTER_S,
  },
]

export interface MotionState {
  /** The 23 keyframe values: placement, speed, wheel spins and corner steering, as a drive records them. */
  frame: Float32Array
  /** Arm joint values by model node name, every one of them each time. */
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
  return planAt(PLANS[demo], at)
}

/**
 * Steer into the motion's stance, move, steer straight again, each from rest to rest. The body
 * starts at the origin heading along x; each wheel spins by its roll per unit of progress over
 * the wheel radius, as the producer's wheels do.
 */
function planAt({ motion, steering, steer, move }: DemoPlan, t: number): MotionState {
  const share = (s: number) => moveAt(steer, s).position / steer.distance
  const stance = share(t - HOLD_S) - share(t - HOLD_S - steer.durationS - move.durationS)
  const along = moveAt(move, t - HOLD_S - steer.durationS)
  let frame: Float32Array
  if (motion.type === 'turn') {
    frame = flatFrame({ x: 0, y: 0, z: 0, headingRad: Math.sign(motion.angleRad) * along.position })
  } else {
    const k = motion.curvature
    const heading = k * along.position
    frame = flatFrame({
      x: Math.sin(heading) / k,
      y: (1 - Math.cos(heading)) / k,
      z: 0,
      headingRad: heading,
    })
    frame[field('speed')] = along.rate
  }
  for (const [k, name] of STEER_FIELDS.entries()) frame[field(name)] = steering.angles[k]! * stance
  for (const [w, name] of SPIN_FIELDS.entries()) {
    frame[field(name)] = (steering.roll[w]! * along.position) / DEFAULT_ROVER_GEOMETRY.wheelRadius
  }
  return { frame, joints: { ...ARM_STOWED }, solFraction: 0.4, lamp: 0 }
}

/** The rover standing still from before sunset to after dusk, then from before dawn to after. */
function twilightAt(t: number): MotionState {
  const { rise, set } = sunCrossings()
  const dusk = DUSK_BEFORE_S + DUSK_AFTER_S
  const seconds = t < dusk ? t - DUSK_BEFORE_S : t - dusk - DAWN_BEFORE_S
  const solFraction = ((((t < dusk ? set : rise) + seconds / MARS_SOL_SECONDS) % 1) + 1) % 1
  return {
    frame: flatFrame({ x: 0, y: 0, z: 0, headingRad: 0 }),
    joints: { ...armPoseAt(solFraction) },
    solFraction,
    lamp: turretLampLevel(sunPosition(solFraction).elevationDeg),
  }
}
