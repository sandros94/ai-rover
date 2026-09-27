import { currentSight } from '#shared/utils/client'
import type { GridCell, HeightGrid } from '#shared/utils/terrain'

/** Shortest time between two sight computations while the rover moves, milliseconds. */
export const SIGHT_INTERVAL_MS = 500
/**
 * A move longer than this between two positions given is a jump (a seek, a new segment), not
 * driving: the sight follows it at once. Playback moves the rover centimetres per frame.
 */
export const SIGHT_JUMP_M = 5

/**
 * What the rover has in line of sight now over the revealed ground `seen` (one byte per vertex
 * of `ground`'s grid), from `eye` in world metres, by {@link currentSight}. While the eye moves,
 * or ground and reveals arrive, it is recomputed at most every {@link SIGHT_INTERVAL_MS} when the
 * browser is idle; a new grid, a jump of the eye or new sight options recompute it at once.
 * Undefined while any input is missing or `seen` does not fit the grid.
 */
export function useCurrentSight(
  seen: () => Uint8Array | undefined,
  ground: () => { grid: HeightGrid; origin: GridCell } | undefined,
  eye: () => { x: number; y: number } | undefined,
  options: () => { mastHeight: number; radiusM: number } | undefined,
) {
  const sight = shallowRef<Uint8Array>()
  let lastRun = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  let idle: (() => void) | undefined

  function cancel(): void {
    clearTimeout(timer)
    timer = undefined
    idle?.()
    idle = undefined
  }

  function compute(): void {
    cancel()
    lastRun = performance.now()
    const flags = seen()
    const at = ground()
    const from = eye()
    const sightOptions = options()
    if (!flags || !at || !from || !sightOptions) {
      sight.value = undefined
      return
    }
    const { grid, origin } = at
    if (flags.length !== grid.width * grid.height) {
      sight.value = undefined
      return
    }
    const cell = {
      i: Math.round(from.x / grid.cellSize) - origin.i,
      j: Math.round(from.y / grid.cellSize) - origin.j,
    }
    sight.value = currentSight(grid, flags, cell, sightOptions)
  }

  function schedule(): void {
    if (timer !== undefined || idle !== undefined) return
    timer = setTimeout(
      () => {
        timer = undefined
        idle = whenIdle(() => {
          idle = undefined
          compute()
        })
      },
      Math.max(0, lastRun + SIGHT_INTERVAL_MS - performance.now()),
    )
  }

  onMounted(() => {
    watch(
      [seen, ground, eye, options] as const,
      ([, at, from, sightOptions], previous) => {
        const [, before, was, previousOptions] = previous ?? []
        const jumped =
          !previous ||
          at?.grid !== before?.grid ||
          !from !== !was ||
          (!!from && !!was && Math.hypot(from.x - was.x, from.y - was.y) > SIGHT_JUMP_M) ||
          sightOptions?.mastHeight !== previousOptions?.mastHeight ||
          sightOptions?.radiusM !== previousOptions?.radiusM
        if (jumped) compute()
        else schedule()
      },
      { immediate: true },
    )
  })
  onScopeDispose(cancel)

  return sight
}

/** Runs `run` when the browser is next idle, soon regardless; returns its cancel. */
function whenIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: SIGHT_INTERVAL_MS / 2 })
    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(run, 0)
  return () => clearTimeout(handle)
}
