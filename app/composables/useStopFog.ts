import { liftSeen } from '#shared/utils/client'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import type { RevealFrame } from '~/composables/useRevealFade'

/** Fog updates per second: reveals arrive every metre, not every frame. */
export const REVEAL_HZ = 10

/**
 * A stop's fog as its views draw it, its parts together as {@link useStopFog} gives them: each
 * undefined while its inputs are missing, `fade` also while `seen` does not fit the grid.
 */
export interface StopFog {
  /** The stop's own seen flags, one byte per disk vertex, before the drive's reveals. */
  stopSeen: Uint8Array | undefined
  /** `stopSeen` with the playing drive's reveals lifted. */
  seen: Uint8Array | undefined
  /** `seen` as drawn now, newly seen ground fading in, by {@link useRevealFade}. */
  fade: RevealFrame | undefined
  /** What the rover has in line of sight now over `seen`, by {@link useCurrentSight}. */
  sight: Uint8Array | undefined
}

/**
 * The fog over a stop's disk: the stop's `seen` flags with the drive's `reveals` lifted (taken
 * at most {@link REVEAL_HZ} times a second), their reveal fade, and the line of sight over them
 * from `eye`. It depends on the ground and the rover, never on how the disk is drawn, so one
 * serves every view of the stop.
 */
export function useStopFog(source: {
  seen: () => Uint8Array | undefined
  reveals: () => readonly { vertices: ArrayLike<number> }[]
  ground: () => { grid: HeightGrid; origin: GridCell } | undefined
  eye: () => { x: number; y: number } | undefined
  sight: () => { mastHeight: number; radiusM: number } | undefined
}) {
  const reveals = useThrottled(source.reveals, REVEAL_HZ)
  const seen = computed(() => {
    const flags = source.seen()
    return flags && liftSeen(flags, reveals.value)
  })
  const fade = useRevealFade(
    () => seen.value,
    () => source.ground()?.grid,
  )
  const sight = useCurrentSight(() => seen.value, source.ground, source.eye, source.sight)
  return computed<StopFog>(() => ({
    stopSeen: source.seen(),
    seen: seen.value,
    fade: fade.value,
    sight: sight.value,
  }))
}
