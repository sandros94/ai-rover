import type { MaybeRefOrGetter } from 'vue'
import type { MapPoint } from '#shared/utils/mission'
import type { usePlanPreview } from './usePlanPreview'

/**
 * The pick-and-confirm flow over a route preview: hovering previews unless a point is picked or
 * a submission is highlighted, a tap picks, confirming submits the picked point and keeps the
 * server's refusal (its reason or error code) to show. A new highlight drops the pick. A
 * `round-changed` refusal keeps the pick and reports the state stale, so the preview plans again
 * from the round as it now is before the user confirms again.
 */
export function usePickSubmit(
  preview: ReturnType<typeof usePlanPreview>,
  options: {
    highlight: MaybeRefOrGetter<{ id: string; goal: MapPoint } | null>
    onSubmitted: () => void
    onStale: () => void
  },
) {
  const picked = ref<MapPoint | null>(null)
  const submitting = ref(false)
  const refusal = ref<{ reason: string; message: string } | null>(null)

  function onHover(point: MapPoint | null): void {
    if (picked.value || toValue(options.highlight)) return
    if (point) preview.request(point)
  }

  function onPick(point: MapPoint): void {
    picked.value = point
    refusal.value = null
    preview.requestNow(point)
  }

  function cancel(): void {
    picked.value = null
    refusal.value = null
    preview.clear()
  }

  watch(
    () => toValue(options.highlight),
    (highlight) => {
      picked.value = null
      refusal.value = null
      if (highlight) preview.requestNow(highlight.goal)
      else preview.clear()
    },
  )

  async function confirm(): Promise<void> {
    if (!picked.value) return
    submitting.value = true
    refusal.value = null
    try {
      await $fetch('/api/mission/submissions', {
        method: 'POST',
        body: { goal: { x: picked.value.x, y: picked.value.y } },
      })
      cancel()
      options.onSubmitted()
    } catch (caught) {
      const data = (caught as { data?: { reason?: string; code?: string; message?: string } }).data
      refusal.value = {
        reason: data?.reason ?? data?.code ?? 'error',
        message: data?.message ?? (caught instanceof Error ? caught.message : String(caught)),
      }
      if (data?.reason === 'round-changed') options.onStale()
    } finally {
      submitting.value = false
    }
  }

  return { picked, submitting, refusal, onHover, onPick, cancel, confirm }
}
