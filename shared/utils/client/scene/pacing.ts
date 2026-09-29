/**
 * How long after the last input the view still counts as handled, milliseconds: orbit damping
 * and a focus ease settle within it.
 */
export const INTERACTION_TAIL_MS = 1000

/**
 * When the scene draws a frame it has been asked for. While the user handles the view (orbit,
 * zoom, pan, pointer over the scene, a focus easing in) every frame is drawn, at the display's
 * rate; otherwise at most `frameCap()` a second, since nothing in the scene moves faster than a
 * few centimetres a second. Times are `performance.now()` milliseconds.
 */
export interface FramePacer {
  /** Input on the view at `now`: draw at the display's rate for {@link INTERACTION_TAIL_MS}. */
  interact(now: number, forMs?: number): void
  interacting(now: number): boolean
  /** Whether a frame asked for at `now` may be drawn now. */
  due(now: number): boolean
  /** A frame was drawn at `now`. */
  drawn(now: number): void
}

/**
 * How early a frame may land on its deadline and still count, milliseconds: display frames jitter
 * by about a millisecond, and a 60 cap on a 60 Hz display must not drop every other one.
 */
const SLACK_MS = 2

export function framePacer(frameCap: () => number): FramePacer {
  let until = -Infinity
  /** When the next frame is due. Deadlines step by the cap's interval, so the rate holds on a display whose frames do not divide it. */
  let next = -Infinity
  return {
    interact(now, forMs = INTERACTION_TAIL_MS) {
      until = Math.max(until, now + forMs)
    },
    interacting: (now) => now < until,
    due(now) {
      if (now < until) return true
      const interval = 1000 / frameCap()
      return now >= next - Math.min(SLACK_MS, interval / 4)
    },
    drawn(now) {
      const interval = 1000 / frameCap()
      next += interval
      // After a pause, or frames drawn faster while the view was handled, start over from now.
      if (next < now || next > now + interval) next = now + interval
    },
  }
}
