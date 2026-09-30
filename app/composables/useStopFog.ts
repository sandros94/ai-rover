import { liftSeen } from '#shared/utils/client'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'
import type { RevealFrame } from '~/composables/useRevealFade'

/** Fog updates per second: reveals arrive every metre, not every frame. */
export const REVEAL_HZ = 10

/**
 * A reveal group as the fog reads it: the disk vertices the drive saw and when, in sim seconds; a
 * group without a time is never settled.
 */
export interface FogReveal {
  t?: number
  vertices: ArrayLike<number>
}

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

/** How many groups of `reveals`, in time order, lie at or before `t`. */
function countUntil(reveals: readonly FogReveal[], t: number): number {
  let lo = 0
  let hi = reveals.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((reveals[mid]!.t ?? Infinity) <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The fog over a stop's disk: the stop's `seen` flags with the drive's `reveals` (in time order)
 * lifted, their reveal fade, and the line of sight over them from `eye`. It depends on the ground
 * and the rover, never on how the disk is drawn, so one serves every view of the stop.
 *
 * Reveals up to `settledUntil` (sim seconds; none by default) happened before playback got there,
 * as when it opens mid-drive or seeks: they are lifted as soon as they are given and drawn
 * settled, so the ground a frame jumped to stands on is drawn true with that frame. The reveals
 * playback reaches as it plays are taken at most {@link REVEAL_HZ} times a second and fade in; a
 * list that drops groups (a seek back) is taken at once.
 */
export function useStopFog(source: {
  seen: () => Uint8Array | undefined
  reveals: () => readonly FogReveal[]
  settledUntil?: () => number
  ground: () => { grid: HeightGrid; origin: GridCell } | undefined
  eye: () => { x: number; y: number } | undefined
  sight: () => { mastHeight: number; radiusM: number } | undefined
}) {
  const settledUntil = () => source.settledUntil?.() ?? -Infinity
  const throttled = useThrottled(source.reveals, REVEAL_HZ)
  const reveals = computed(() => {
    const latest = source.reveals()
    const held = throttled.value
    const until = settledUntil()
    const jumped =
      latest.length < held.length || countUntil(latest, until) > countUntil(held, until)
    return jumped ? latest : held
  })
  /** The stop's flags with the settled reveals lifted: rebuilt only when those change. */
  let based: { flags: Uint8Array; count: number; last?: FogReveal; lifted: Uint8Array } | undefined
  const settled = computed(() => {
    const flags = source.seen()
    if (!flags) return undefined
    const list = reveals.value
    const count = countUntil(list, settledUntil())
    const last = list[count - 1]
    if (based?.flags !== flags || based.count !== count || based.last !== last) {
      based = { flags, count, last, lifted: liftSeen(flags, list.slice(0, count)) }
    }
    return based.lifted
  })
  const seen = computed(() => {
    const base = settled.value
    const list = reveals.value
    return base && liftSeen(base, list.slice(countUntil(list, settledUntil())))
  })
  const fade = useRevealFade(
    () => seen.value,
    () => source.ground()?.grid,
    () => settled.value,
  )
  const sight = useCurrentSight(() => seen.value, source.ground, source.eye, source.sight)
  return computed<StopFog>(() => ({
    stopSeen: source.seen(),
    seen: seen.value,
    fade: fade.value,
    sight: sight.value,
  }))
}
