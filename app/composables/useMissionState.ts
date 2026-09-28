/** How often the mission state is refreshed while the tab is visible. */
export const MISSION_POLL_MS = 5000

import { createClockOffsetEstimate, serverClockOffset } from '#shared/utils/client'

const fetchMission = () => $fetch('/api/mission')

/** `/api/mission` as it arrives: dates as ISO strings. */
export type MissionStateJson = Awaited<ReturnType<typeof fetchMission>>

/**
 * Polls the public mission state every {@link MISSION_POLL_MS} while the tab is visible, and
 * not at all while it is hidden. `serverOffsetMs` estimates server minus browser clock over the
 * last polls (see `createClockOffsetEstimate`), null before the first answer, for playing slices
 * against the server's release times. The answer may come from the CDN, a few seconds old: every
 * request revalidates past the browser's own cache, and the offset counts the answer's age.
 */
export function useMissionState() {
  const state = shallowRef<MissionStateJson | null>(null)
  const error = shallowRef<unknown>(null)
  const serverOffsetMs = ref<number | null>(null)
  const estimate = createClockOffsetEstimate()
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = false

  async function refresh(): Promise<void> {
    const sentAt = Date.now()
    try {
      const response = await $fetch.raw<MissionStateJson>('/api/mission', { cache: 'no-cache' })
      const data = response._data!
      serverOffsetMs.value = estimate.add(
        serverClockOffset({
          serverNow: String(data.now),
          age: response.headers.get('age'),
          sentAt,
          receivedAt: Date.now(),
        }),
      )
      state.value = data
      error.value = null
    } catch (caught) {
      error.value = caught
    }
  }

  // The next request is scheduled after the previous answer, so a slow one never overlaps.
  async function cycle(): Promise<void> {
    await refresh()
    if (active) timer = setTimeout(cycle, MISSION_POLL_MS)
  }

  function start(): void {
    if (active) return
    active = true
    void cycle()
  }

  function stop(): void {
    active = false
    clearTimeout(timer)
    timer = undefined
  }

  function onVisibility(): void {
    if (document.visibilityState === 'visible') start()
    else stop()
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
  })

  return { state, error, serverOffsetMs, refresh }
}
