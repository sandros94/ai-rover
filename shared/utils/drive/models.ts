import { AUTONAV_EFFECTIVE_MPS } from '../rover/speed'

/** Rover speed on the ground; omitted fields take the defaults below. */
export interface SpeedModel {
  /**
   * Flat-ground drive speed, m/s. Default `AUTONAV_EFFECTIVE_MPS` (0.033, Perseverance's 120 m/h
   * under AutoNav): the rover thinks while driving, so this is its speed, not an average over stops.
   */
  cruiseSpeedMps?: number
  /** Fraction of `cruiseSpeedMps` lost at the slope limit, linear in tan(slope). Default 0.5. */
  slopeSlowdown?: number
  /** Turn-in-place rate, rad/s. Default 3°/s. */
  turnRateRadPerS?: number
}

/**
 * The rover stops only for a reason, and each stop is an event: turns in place (timed by the
 * speed model's turn rate), an assessment before every replan, and periodic imaging.
 */
export interface StopModel {
  /** Ground distance between imaging stops, metres; none at the goal. Default 25. */
  imagingEveryM?: number
  /** Length of an imaging stop, seconds. Default 30. */
  imagingStopS?: number
  /** Standstill while the rover assesses newly found blocking ground before replanning, seconds. Default 20. */
  assessStopS?: number
}

const DEG = Math.PI / 180

/** The speed model a drive uses for omitted fields. */
export const DEFAULT_SPEED_MODEL: Readonly<Required<SpeedModel>> = Object.freeze({
  cruiseSpeedMps: AUTONAV_EFFECTIVE_MPS,
  slopeSlowdown: 0.5,
  // UNVERIFIED: no published Perseverance turn-in-place rate was found; 3°/s is a judgement call.
  turnRateRadPerS: 3 * DEG,
})

/**
 * The stop model a drive uses for omitted fields. UNVERIFIED, all three: the references give no
 * periodic imaging stop (AutoNav images while driving) and no assessment time; a stop "when it
 * cannot quickly determine a safe path" is documented, and ENav's planning cycle takes 3–4 s,
 * scoring every candidate path more than 3 min. The values are judgement calls that keep 100 m
 * on flat ground near 0.032 m/s overall, inside the 0.026–0.033 m/s the record drives averaged.
 */
export const DEFAULT_STOP_MODEL: Readonly<Required<StopModel>> = Object.freeze({
  imagingEveryM: 25,
  imagingStopS: 30,
  assessStopS: 20,
})

/**
 * Speed over ground at a slope `ratio` (tan slope over tan of the slope limit), m/s: the cruise
 * speed less `slopeSlowdown` of it at the limit, linear in between and held beyond. Drives and
 * the planner's time estimate both move by it.
 */
export function groundSpeedMps(
  ratio: number,
  model: Pick<Required<SpeedModel>, 'cruiseSpeedMps' | 'slopeSlowdown'> = DEFAULT_SPEED_MODEL,
): number {
  return model.cruiseSpeedMps * (1 - model.slopeSlowdown * Math.min(1, ratio))
}
