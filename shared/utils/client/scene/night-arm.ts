import type { ArmPose } from '../../rover/arm'
import { ARM_JOINTS, ARM_STOWED } from '../../rover/arm'
import { MARS_SOL_SECONDS } from '../instruments/sol-clock'
import { DEFAULT_LATITUDE_DEG, sunCrossings } from './sun'

/**
 * The arm at night: raised above and ahead of the front deck, the turret turned so the WATSON
 * camera's LEDs light the ground about 3 m ahead of the front wheels. A design choice for the
 * night view, not a configuration the rover drives in: Perseverance drives by day with its arm
 * stowed and carries no headlights. Within the URDF's limits, and clear of the mast, the deck
 * and the wheels over the suspension's travel (the model's tests measure it).
 */
export const ARM_NIGHT: ArmPose = {
  arm_1: -1.9437,
  arm_2: -1.2606,
  arm_3: -1.0837,
  arm_4: 1.2433,
  arm_5: 4.2319,
}

/**
 * The unstow, stowed to {@link ARM_NIGHT}, as keyframes in joint space the arm moves between in
 * straight lines:
 * 1. lift-off: the shoulder turns 40° and the elbow opens 30°, the wrist and turret tilting the
 *    turret up off its rest and the forearm off the deck;
 * 2. swing: the shoulder turns and raises into its night angles while the elbow opens most of
 *    the way and the wrist folds 20° more, which keeps the turret off the mast as it passes;
 * 3. elbow: the elbow opens to its night angle;
 * 4. aim: the wrist raises the turret and the turret turns WATSON onto the ground ahead.
 * A strict order (the shoulder alone, then the elbow alone) is not possible on this model: with
 * the elbow folded, the turret sweeps through the mast whichever way the shoulder swings. The
 * model's tests hold every link at least 3 cm clear of the mast, the deck and the wheels over
 * the suspension's travel along the whole path, once each is off its rest.
 */
export const ARM_UNSTOW: readonly ArmPose[] = [
  ARM_STOWED,
  { arm_1: 0.8742, arm_2: ARM_STOWED.arm_2, arm_3: -2.2973, arm_4: 2.7607, arm_5: 5.2099 },
  { arm_1: ARM_NIGHT.arm_1, arm_2: ARM_NIGHT.arm_2, arm_3: -1.3373, arm_4: 2.4117, arm_5: 5.2099 },
  { ...ARM_NIGHT, arm_4: 2.4117, arm_5: 5.2099 },
  ARM_NIGHT,
]

/**
 * How fast the joint that moves furthest in a leg turns, radians per second of the sol; the
 * others turn in proportion, so each leg's joints start and stop together. A design choice:
 * Perseverance's real unstow is a sequence of several minutes whose joint rates are not
 * published; 2°/s makes this one take a few minutes of the sol.
 */
export const ARM_JOINT_RATE = (2 * Math.PI) / 180

/** Each leg of {@link ARM_UNSTOW}: its end poses and the sol seconds it starts at and lasts. */
export const ARM_LEGS = ARM_UNSTOW.slice(1).reduce<
  { from: ArmPose; to: ArmPose; startS: number; durationS: number }[]
>((legs, to, k) => {
  const from = ARM_UNSTOW[k]!
  const last = legs.at(-1)
  const widest = Math.max(...ARM_JOINTS.map(({ node }) => Math.abs(to[node] - from[node])))
  legs.push({
    from,
    to,
    startS: last ? last.startS + last.durationS : 0,
    durationS: widest / ARM_JOINT_RATE,
  })
  return legs
}, [])

/** Sol seconds the whole unstow takes, and the stow at dawn the same. */
export const ARM_SEQUENCE_S = ARM_LEGS.at(-1)!.startS + ARM_LEGS.at(-1)!.durationS

/** The arm's pose `seconds` into the unstow: stowed at 0 and before, {@link ARM_NIGHT} from the end. */
export function armPoseAlong(seconds: number): ArmPose {
  const leg =
    ARM_LEGS.find(({ startS, durationS }) => seconds < startS + durationS) ?? ARM_LEGS.at(-1)!
  const s = Math.min(1, Math.max(0, (seconds - leg.startS) / leg.durationS))
  const pose = {} as ArmPose
  for (const { node } of ARM_JOINTS) {
    pose[node] = leg.from[node] + (leg.to[node] - leg.from[node]) * s
  }
  return pose
}

/**
 * How far along the unstow the arm is at `solFraction`, sol seconds from 0 (stowed) to
 * {@link ARM_SEQUENCE_S} (night pose): the unstow runs from the moment the sun's centre sets,
 * and the stow, the unstow played backwards, from the moment it rises. A function of the clock
 * alone, so a replay scrubbed to any moment draws the arm where it would be.
 */
export function armSequenceSeconds(
  solFraction: number,
  latitudeDeg = DEFAULT_LATITUDE_DEG,
): number {
  const { rise, set } = sunCrossings(latitudeDeg)
  const f = solFraction - Math.floor(solFraction)
  const since = (from: number) => ((f - from + 1) % 1) * MARS_SOL_SECONDS
  const night = f >= set || f < rise
  return night ? Math.min(ARM_SEQUENCE_S, since(set)) : Math.max(0, ARM_SEQUENCE_S - since(rise))
}

/** The arm's joint values at `solFraction`: stowed by day, raised by night, moving between. */
export function armPoseAt(solFraction: number, latitudeDeg = DEFAULT_LATITUDE_DEG): ArmPose {
  return armPoseAlong(armSequenceSeconds(solFraction, latitudeDeg))
}

/**
 * Brightness of the arm turret's lamp, 0 off to 1 full, with the sun `elevationDeg` above the
 * horizon: it comes on as the sun's centre sets and is full once the sun is 3° below.
 */
export function turretLampLevel(elevationDeg: number): number {
  return Math.min(1, Math.max(0, -elevationDeg / 3))
}
