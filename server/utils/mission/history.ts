import type { DB } from '../../database/db'
import type { Segment } from '../../database/schema'
import { listSettledSegments } from '../../repositories/segments'
import { listStops } from '../../repositories/stops'
import type { JourneyStore } from '../journey/store'
import { parseStoredSegmentManifest } from '#shared/utils/drive'
import type { MapPoint, MissionHistory } from '#shared/utils/mission'
import { drivenPath, POCKET_PATH_RADIUS_M } from '#shared/utils/mission'
import { RECENT_STOPS } from '#shared/utils/nav'
import type { StopDisk } from '#shared/utils/terrain'
import { LifecycleError } from './errors'

/**
 * The mission's public history as a goal planned over `disk` needs it: the paths its settled
 * segments drove that can come within the pocket radius of the survey, and its latest stops, most
 * recent first. `driven` is a drive whose ending is being settled: it counts as driven to `end`.
 */
export async function missionHistory(
  db: DB,
  options: {
    store: JourneyStore
    missionId: string
    disk: Pick<StopDisk, 'center' | 'radius'>
    driven?: { segment: Pick<Segment, 'id' | 'fromStopId' | 'manifestKey'>; end: MapPoint }
  },
): Promise<MissionHistory> {
  const { store, missionId, disk, driven } = options
  const stops = await listStops(db, missionId)
  const at = new Map(stops.map((stop) => [stop.id, stop]))
  const segments = (await listSettledSegments(db, missionId)).map((s) => ({
    segment: { id: s.id, fromStopId: s.fromStopId, manifestKey: s.manifestKey },
    end: s.end,
  }))
  if (driven) segments.push(driven)
  // Every stop's survey has this disk's radius, and a planned path stays within its survey.
  const reach = 2 * disk.radius + POCKET_PATH_RADIUS_M
  const near = segments.filter(({ segment }) => {
    const from = at.get(segment.fromStopId)!
    return Math.hypot(from.x - disk.center.x, from.y - disk.center.y) <= reach
  })
  const drivenPaths = await Promise.all(
    near.map(async ({ segment, end }) => {
      const manifest = await store.getJson(segment.manifestKey)
      if (manifest === null) {
        throw new LifecycleError(
          'NOT_PUBLISHED',
          `Segment ${segment.id} has no manifest at "${segment.manifestKey}" in the journey store; settle it with the store it was published to.`,
        )
      }
      return drivenPath(parseStoredSegmentManifest(manifest).plan.polyline, end)
    }),
  )
  // One more than Jev is shown: the summary leaves out the stop a plan starts from.
  const recentStops = stops
    .toReversed()
    .slice(0, RECENT_STOPS + 1)
    .map(({ x, y }) => ({ x, y }))
  return { drivenPaths, recentStops }
}
