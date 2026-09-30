import type { FogState, GridRect } from '#shared/utils/client'
import { REVEAL_FADE_MS, revealTimes, updateRevealTimes } from '#shared/utils/client'
import type { HeightGrid } from '#shared/utils/terrain'

/** Fog redraws per second while ground fades in: reveals arrive every metre, not every frame. */
const REDRAW_HZ = 10

/** The fog to draw now, and what changed since the last one. */
export interface RevealFrame {
  fog: FogState & { revealedAt: Float64Array; now: number }
  /** Rectangles of vertices that changed or are still fading; absent means redraw everything. */
  rects?: GridRect[]
}

/**
 * The fog over `grid` as `seen` grows: vertices newly seen fade in over {@link REVEAL_FADE_MS},
 * and while any fade runs a new frame is given at most {@link REDRAW_HZ} times a second with the
 * rectangles to redraw, one per change still fading, so a long drive never grows one rectangle
 * over its whole path. Vertices newly seen that `settled` flags (one byte per vertex, as `seen`)
 * appear settled, in a frame given at once. A new grid, or a first `seen`, gives a frame without
 * a rectangle; no `seen`, or one not matching the grid, gives none.
 */
export function useRevealFade(
  seen: () => Uint8Array | undefined,
  grid: () => HeightGrid | undefined,
  settled: () => Uint8Array | undefined = () => undefined,
) {
  const frame = shallowRef<RevealFrame>()
  let times: Float64Array | undefined
  let shown: Uint8Array | undefined
  let fading: { rect: GridRect; until: number }[] = []
  let lastTick = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined

  function reset(): void {
    clearTimeout(timer)
    timer = undefined
    times = undefined
    shown = undefined
    fading = []
  }

  function tick(): void {
    timer = undefined
    if (!times || !shown) return
    const now = performance.now()
    lastTick = now
    frame.value = { fog: { seen: shown, revealedAt: times, now }, rects: fading.map((f) => f.rect) }
    // A change whose fade ended has just been drawn settled; it needs no more frames.
    fading = fading.filter((f) => f.until > now)
    if (fading.length > 0) schedule()
  }

  function schedule(): void {
    if (timer) return
    timer = setTimeout(tick, Math.max(0, lastTick + 1000 / REDRAW_HZ - performance.now()))
  }

  // Synchronous, so a frame never pairs a new grid with the previous grid's flags.
  watch(
    [seen, grid, settled] as const,
    ([flags, ground, base], previous) => {
      if (!flags || !ground || flags.length !== ground.width * ground.height) {
        reset()
        frame.value = undefined
        return
      }
      const now = performance.now()
      if (!times || !shown || ground !== previous?.[1] || times.length !== flags.length) {
        reset()
        times = revealTimes(flags)
        shown = flags
        frame.value = { fog: { seen: flags, revealedAt: times, now } }
        return
      }
      shown = flags
      const fits = base?.length === flags.length ? base : undefined
      const changed = updateRevealTimes(times, flags, now, ground.width, fits)
      if (!changed) return
      fading.push({ rect: changed, until: now + REVEAL_FADE_MS })
      // Settled ground is drawn in the same frame as whatever it arrived with.
      if (fits && fits !== previous?.[2]) {
        clearTimeout(timer)
        tick()
      } else schedule()
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(reset)

  return frame
}
