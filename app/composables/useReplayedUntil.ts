/** Browser storage key of the end of the latest drive replayed to its end. */
export const REPLAYED_UNTIL_KEY = 'jev-rover:replayed-until'

function stored(): string | null {
  try {
    const raw = localStorage.getItem(REPLAYED_UNTIL_KEY)
    return raw && Number.isFinite(Date.parse(raw)) ? raw : null
  } catch {
    return null
  }
}

/**
 * How far this browser has replayed the journey: the end (ISO) of the latest drive a replay
 * played to its end, read once mounted so server and first client render agree. `mark` only
 * ever moves it forward; storage that is blocked or absent only means it is not remembered.
 */
export function useReplayedUntil() {
  const until = ref<string | null>(null)
  onMounted(() => {
    until.value = stored()
  })

  function mark(endedAt: string): void {
    const current = stored() ?? until.value
    if (current && Date.parse(current) >= Date.parse(endedAt)) return
    until.value = endedAt
    try {
      localStorage.setItem(REPLAYED_UNTIL_KEY, endedAt)
    } catch {
      // Storage unavailable: remembered for this page only.
    }
  }

  return { until, mark }
}
