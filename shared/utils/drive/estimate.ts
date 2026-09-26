import type { Motion } from '../nav/motions'
import type { NavMetrics } from '../nav/plan'
import { DEFAULT_SPEED_MODEL, DEFAULT_STOP_MODEL } from './segment'

/**
 * A planned route's drive time under the default speed and stop models, whole minutes: the path
 * at cruise speed, an imaging stop per `imagingEveryM` of path and the plan's turns in place. Slope
 * slowdown, slip and assessments are left out: they depend on ground the plan has not driven.
 * 0 when the route was not reached.
 */
export function estimatedDriveMinutes(plan: {
  metrics: Pick<NavMetrics, 'reached' | 'pathLengthM'>
  motions: readonly Motion[]
}): number {
  const { reached, pathLengthM } = plan.metrics
  if (!reached) return 0
  const { cruiseSpeedMps, turnRateRadPerS } = DEFAULT_SPEED_MODEL
  const { imagingEveryM, imagingStopS } = DEFAULT_STOP_MODEL
  let turnedRad = 0
  for (const motion of plan.motions)
    if (motion.type === 'turn') turnedRad += Math.abs(motion.angleRad)
  const seconds =
    pathLengthM / cruiseSpeedMps +
    Math.floor(pathLengthM / imagingEveryM) * imagingStopS +
    turnedRad / turnRateRadPerS
  return Math.round(seconds / 60)
}
