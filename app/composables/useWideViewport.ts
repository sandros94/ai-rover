import type { Ref } from 'vue'

/** Viewports at least this wide float panels; narrower ones stack them in bottom sheets. */
export const WIDE_VIEWPORT_QUERY = '(min-width: 768px)'

/**
 * Whether the viewport is wide enough for floating panels, following resizes. False on the
 * server and until mounted, so the first client render matches the server's.
 */
export function useWideViewport(): Ref<boolean> {
  const wide = ref(false)
  let query: MediaQueryList | undefined
  const onChange = (event: MediaQueryListEvent) => (wide.value = event.matches)
  onMounted(() => {
    query = window.matchMedia(WIDE_VIEWPORT_QUERY)
    wide.value = query.matches
    query.addEventListener('change', onChange)
  })
  onBeforeUnmount(() => query?.removeEventListener('change', onChange))
  return wide
}
