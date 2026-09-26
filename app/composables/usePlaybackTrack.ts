import { KEYFRAME_FIELDS, KEYFRAME_STRIDE } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import type { useSegmentPlayback } from './useSegmentPlayback'

/** Instrument updates per second: enough to read, cheap next to the map's per-frame overlay. */
export const INSTRUMENT_HZ = 10
/** Most points of the driven path drawn; longer drives are thinned evenly. */
export const DRIVEN_POINTS = 400

const X = KEYFRAME_FIELDS.indexOf('x')
const Y = KEYFRAME_FIELDS.indexOf('y')
const QX = KEYFRAME_FIELDS.indexOf('qx')
const QY = KEYFRAME_FIELDS.indexOf('qy')
const QZ = KEYFRAME_FIELDS.indexOf('qz')
const QW = KEYFRAME_FIELDS.indexOf('qw')

/**
 * What the map and the instruments read from a playing segment: a snapshot sampled at
 * {@link INSTRUMENT_HZ}, the rover at the playback frame (the one layer that moves every frame),
 * the route followed at the playback time and the path driven so far.
 */
export function usePlaybackTrack(playback: ReturnType<typeof useSegmentPlayback>) {
  const snapshot = useThrottled(
    () => ({
      frame: playback.frame.value,
      keyframes: playback.keyframes.value,
      events: playback.events.value,
      reveals: playback.reveals.value,
      heldReveals: playback.heldReveals.value,
      t: playback.simTime.value,
      liveTime: playback.liveTime.value,
      heldUntil: playback.heldUntil.value,
      mode: playback.mode.value,
      rate: playback.rate.value,
    }),
    INSTRUMENT_HZ,
  )

  const rover = computed(() => {
    const f = playback.frame.value
    if (!f) return undefined
    const [x, y, z, w] = [f[QX]!, f[QY]!, f[QZ]!, f[QW]!]
    // Yaw of the world-from-body quaternion Rz(heading) · Ry(pitch) · Rx(roll).
    return {
      x: f[X]!,
      y: f[Y]!,
      headingRad: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
    }
  })

  /** The latest replan's route, else the opening plan. */
  const plan = computed<MapPoint[]>(() => {
    const replan = snapshot.value.events.findLast(
      (e) => e.type === 'replan' && Array.isArray(e.details?.polyline),
    )
    if (replan) return replan.details!.polyline as MapPoint[]
    return playback.manifest.value?.plan.polyline ?? []
  })

  const driven = computed<MapPoint[]>(() => {
    const block = snapshot.value.keyframes
    if (!block || block.count < 2) return []
    const step = Math.max(1, Math.ceil(block.count / DRIVEN_POINTS))
    const points: MapPoint[] = []
    for (let k = 0; k < block.count; k += step) {
      points.push({
        x: block.data[k * KEYFRAME_STRIDE + X]!,
        y: block.data[k * KEYFRAME_STRIDE + Y]!,
      })
    }
    const last = (block.count - 1) * KEYFRAME_STRIDE
    points.push({ x: block.data[last + X]!, y: block.data[last + Y]! })
    return points
  })

  return { snapshot, rover, plan, driven }
}
