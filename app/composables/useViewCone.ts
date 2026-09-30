import type { CameraPose, ViewFootprint } from '#shared/utils/client/scene'
import { HAZE_FAR_M, viewFootprint } from '#shared/utils/client/scene'
import type { MapViewMode } from './useMapView'

/**
 * The ground the main 3D view's camera shows, for a floating 2D map of the same stop to draw,
 * held by the page that holds both. The camera reports its pose (`report`, to the main stage's
 * `reportCamera`) only while the main view is 3D and the floating map is mounted (`shown` and
 * `hidden`, from its mount and unmount); the footprint is then `footprint`, handed to that map
 * alone, and undefined otherwise. The ground is taken level at the camera's target, and nothing
 * past the scene's haze.
 */
export function useViewCone(view: MaybeRefOrGetter<MapViewMode>) {
  /** The floating maps mounted: a panel's content can remount before the old one leaves. */
  const maps = ref(0)
  const report = computed(() => toValue(view) === '3d' && maps.value > 0)
  const pose = shallowRef<CameraPose>()
  watch(report, (reporting) => {
    if (!reporting) pose.value = undefined
  })
  const footprint = computed<ViewFootprint | undefined>(() => {
    const current = report.value ? pose.value : undefined
    return current && viewFootprint(current, current.target.z, HAZE_FAR_M)
  })
  return {
    report,
    footprint,
    onCamera(next: CameraPose): void {
      if (report.value) pose.value = next
    },
    shown(): void {
      maps.value++
    },
    hidden(): void {
      maps.value = Math.max(0, maps.value - 1)
    },
  }
}
