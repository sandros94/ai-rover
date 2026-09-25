import { RoverError } from './errors'
import type { RoverPose } from './kinematics'

/** Thresholds on a solved pose, radians and metres; omitted fields take {@link DEFAULT_ROVER_LIMITS}. */
export interface RoverLimits {
  /** Warn above this body tilt. */
  tiltRad?: number
  /** Warn above this |pitch|. */
  pitchRad?: number
  /** Warn above this |roll|. */
  rollRad?: number
  /** Warn above this |bogie angle|, per side. */
  bogieRad?: number
  /** Warn above this |differential angle|. */
  differentialRad?: number
  /** Fail above this body tilt. */
  tipOverRad?: number
  /** Fail below this belly clearance. */
  minClearanceM?: number
}

/**
 * Why a pose is flagged. Closed set, listed in the order verdicts report them: callers may
 * match on it exhaustively, so adding a reason is a breaking change.
 */
export type LimitReason =
  | 'tilt'
  | 'pitch'
  | 'roll'
  | 'bogie-left'
  | 'bogie-right'
  | 'differential'
  | 'clearance'
  | 'tip-over'

export type LimitVerdict = { level: 'ok' | 'warn' | 'fail'; reasons: LimitReason[] }

export interface CheckLimitsOptions {
  limits?: RoverLimits
}

const DEG = Math.PI / 180

/** Curiosity nominal flight limits for the warnings; tip-over at the rated 45° static tilt. */
export const DEFAULT_ROVER_LIMITS: Readonly<Required<RoverLimits>> = Object.freeze({
  tiltRad: 30 * DEG,
  pitchRad: 15 * DEG,
  rollRad: 15 * DEG,
  bogieRad: 17 * DEG,
  differentialRad: 7 * DEG,
  tipOverRad: 45 * DEG,
  minClearanceM: 0,
})

/** Grades a solved pose against the limits: `fail` on tip-over or belly strike, `warn` on any other exceedance. */
export function checkLimits(pose: RoverPose, options: CheckLimitsOptions = {}): LimitVerdict {
  const limits = { ...DEFAULT_ROVER_LIMITS, ...options.limits }
  for (const [name, value] of Object.entries(limits)) {
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new RoverError(
        'INVALID_LIMITS',
        `checkLimits: ${name} is ${value}; pass a finite number of at least 0.`,
      )
    }
  }
  const values = {
    'tiltRad': pose.tiltRad,
    'pitchRad': pose.pitchRad,
    'rollRad': pose.rollRad,
    'bogie.left': pose.bogie.left,
    'bogie.right': pose.bogie.right,
    'differentialRad': pose.differentialRad,
    'bellyClearanceM': pose.bellyClearanceM,
  }
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) {
      throw new RoverError(
        'INVALID_POSE',
        `checkLimits: pose ${name} is ${value}; pass a pose from poseOnTerrain.`,
      )
    }
  }

  const flags: [LimitReason, boolean][] = [
    ['tilt', pose.tiltRad > limits.tiltRad],
    ['pitch', Math.abs(pose.pitchRad) > limits.pitchRad],
    ['roll', Math.abs(pose.rollRad) > limits.rollRad],
    ['bogie-left', Math.abs(pose.bogie.left) > limits.bogieRad],
    ['bogie-right', Math.abs(pose.bogie.right) > limits.bogieRad],
    ['differential', Math.abs(pose.differentialRad) > limits.differentialRad],
    ['clearance', pose.bellyClearanceM < limits.minClearanceM],
    ['tip-over', pose.tiltRad > limits.tipOverRad],
  ]
  const reasons = flags.filter(([, flagged]) => flagged).map(([reason]) => reason)
  const failed = reasons.includes('clearance') || reasons.includes('tip-over')
  return { level: failed ? 'fail' : reasons.length > 0 ? 'warn' : 'ok', reasons }
}
