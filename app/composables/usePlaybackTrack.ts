import type { DrivenPoint } from '#shared/utils/client'
import { drivenPath } from '#shared/utils/client'
import { KEYFRAME_FIELDS, latestRoute } from '#shared/utils/drive'
import type { MapPoint } from '#shared/utils/mission'
import type { useSegmentPlayback } from './useSegmentPlayback'

/** What a track reads of playback: one live or replayed segment, or a playlist's current one. */
export type PlaybackSource = Pick<
  ReturnType<typeof useSegmentPlayback>,
  | 'manifest'
  | 'frame'
  | 'keyframes'
  | 'totals'
  | 'pathBefore'
  | 'events'
  | 'reveals'
  | 'heldReveals'
  | 'simTime'
  | 'liveTime'
  | 'heldUntil'
  | 'mode'
  | 'rate'
  | 'paused'
>

/** Instrument updates per second: enough to read, cheap next to the map's per-frame overlay. */
export const INSTRUMENT_HZ = 10

const X = KEYFRAME_FIELDS.indexOf('x')
const Y = KEYFRAME_FIELDS.indexOf('y')
const QX = KEYFRAME_FIELDS.indexOf('qx')
const QY = KEYFRAME_FIELDS.indexOf('qy')
const QZ = KEYFRAME_FIELDS.indexOf('qz')
const QW = KEYFRAME_FIELDS.indexOf('qw')
const SPEED = KEYFRAME_FIELDS.indexOf('speed')

/**
 * What the map and the instruments read from a playing segment: a snapshot sampled at
 * {@link INSTRUMENT_HZ}, the rover at the playback frame (the one layer that moves every frame),
 * the route followed at the playback time, the path driven so far (the traces' light path before
 * the loaded window, its keyframes within), and the rover's speed and share of the opening plan's
 * path driven, at the snapshot's rate.
 */
export function usePlaybackTrack(playback: PlaybackSource) {
  const snapshot = useThrottled(
    () => ({
      frame: playback.frame.value,
      keyframes: playback.keyframes.value,
      totals: playback.totals.value,
      pathBefore: playback.pathBefore.value,
      events: playback.events.value,
      reveals: playback.reveals.value,
      heldReveals: playback.heldReveals.value,
      t: playback.simTime.value,
      liveTime: playback.liveTime.value,
      heldUntil: playback.heldUntil.value,
      mode: playback.mode.value,
      rate: playback.rate.value,
      paused: playback.paused.value,
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

  /** The latest replan's route, else the one in force at the window's start, else the opening plan. */
  const plan = computed<MapPoint[]>(
    () =>
      latestRoute(snapshot.value.events) ??
      snapshot.value.totals?.route ??
      playback.manifest.value?.plan.polyline ??
      [],
  )

  const driven = computed<DrivenPoint[]>(() => {
    const { keyframes, pathBefore } = snapshot.value
    const points = drivenPath(keyframes, pathBefore)
    return points.length < 2 ? [] : points
  })

  const motion = computed(() => {
    const frame = snapshot.value.frame
    if (!frame) return undefined
    const pathM = playback.manifest.value?.plan.metrics.pathLengthM
    let drivenM = 0
    const line = driven.value
    for (let k = 1; k < line.length; k++) {
      drivenM += Math.hypot(line[k]!.x - line[k - 1]!.x, line[k]!.y - line[k - 1]!.y)
    }
    return {
      speedMps: frame[SPEED]!,
      progress: pathM ? Math.min(1, drivenM / pathM) : null,
    }
  })

  return { snapshot, rover, plan, driven, motion }
}
