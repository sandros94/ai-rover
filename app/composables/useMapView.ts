/** Closed set: the flat map, or the scene. */
export type MapViewMode = '2d' | '3d'

/** Browser storage key of the visitor's last choice. */
export const MAP_VIEW_KEY = 'jev-rover:map-view'

/**
 * The map view the visitor last chose, the scene by default. Read from `localStorage` once mounted, so
 * server and first client render agree; storage that is blocked or absent (private windows,
 * previews) only means the choice is not remembered.
 */
export function useMapView() {
  const view = ref<MapViewMode>('3d')
  onMounted(() => {
    try {
      if (localStorage.getItem(MAP_VIEW_KEY) === '2d') view.value = '2d'
    } catch {
      // Storage unavailable: keep the default.
    }
    watch(view, (next) => {
      try {
        localStorage.setItem(MAP_VIEW_KEY, next)
      } catch {
        // Storage unavailable: the choice lasts for this page only.
      }
    })
  })
  return view
}
