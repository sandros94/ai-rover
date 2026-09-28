import type { MaybeRefOrGetter } from 'vue'
import type { DisplayClock } from '#shared/utils/client'
import { createDisplayClock } from '#shared/utils/client'

/**
 * The clock the dashboard shows, playback and countdowns alike: the browser's until the first
 * server offset estimate (server minus browser clock, see `useMissionState`), then the server's,
 * slewing toward each later estimate instead of stepping to it.
 */
export function useDisplayClock(serverOffsetMs: MaybeRefOrGetter<number | null>): DisplayClock {
  // Date.now() may be stepped by the system; the offset re-reads it against the monotonic clock.
  const monotonicToEpoch = () => Date.now() - performance.now()
  const clock = createDisplayClock({
    monotonic: () => performance.now(),
    offsetMs: monotonicToEpoch(),
  })
  watch(
    () => toValue(serverOffsetMs),
    (offset) => {
      if (offset !== null) clock.setOffset(offset + monotonicToEpoch())
    },
    { immediate: true },
  )
  return clock
}
