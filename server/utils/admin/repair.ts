import { defineHandler, HTTPError } from 'nitro/h3'
import * as v from 'valibot'
import type { DB } from '../../database/db'
import type { Stop } from '../../database/schema'
import { getActiveMission } from '../../repositories/missions'
import { getSegment } from '../../repositories/segments'
import { listStops, setStopObjects } from '../../repositories/stops'
import { primeStop } from '../journey/prime'
import { publishStop } from '../journey/publish'
import type { JourneyStore } from '../journey/store'
import { LifecycleError } from '../mission/errors'
import { httpErrorOf } from '../mission/http'
import { loadRecordReveals, loadRevealedMask, missionWorld, stopDisk } from '../mission/terrain'
import { underMissionLock } from '../mission/tick'
import { BAD_INPUT } from '../mission/validation'
import type { AdminContext } from './access'
import { noStore, PLATFORM, readAdminBody } from './access'
import type { StopRepairCursor, StopRepairEntry, StopRepairReport } from '#shared/utils/admin'
import { parseJourneyKey } from '#shared/utils/drive'
import { MissionError, rebuildStopMasks } from '#shared/utils/mission'
import {
  createRevealedMask,
  decodeDiskPack,
  decodeRevealedMask,
  encodeRevealedMask,
  parseStopManifest,
  revealedVertexCount,
  revealedVerticesMissing,
} from '#shared/utils/terrain'

/**
 * A call starts no further stop past this: each takes a disk, its pack read back and, when it is
 * stale, its objects published again, a few seconds in all, and the whole call must answer within
 * the platform's limit for a synchronous function.
 */
export const REPAIR_BUDGET_MS = 20_000

/**
 * Checks the active mission's stops in index order from `cursor` (the landing when absent), each
 * against its mask computed again from the landing with the functions settlement uses (see
 * `rebuildStopMasks`), and its manifest and pack against the stop itself. A stop whose objects
 * differ has the right ones published under the keys they name (`stopKeys`), which no row names
 * yet, so a dry run changes nothing anyone is served; with `apply`, the stop row is pointed at
 * them in a transaction holding the mission lock, and they are primed in the CDN. Objects stay
 * immutable: those an old reference names stay stored.
 *
 * Stops are checked until `budgetMs` has passed, at least one per call; the answer carries the
 * cursor for the next call while stops remain. A call cut short can be sent again with the same
 * cursor: the objects it published are found stored, and pointing a row at them again changes
 * nothing. Rounds planned over a stale mask are left as they are.
 */
export async function repairStops(
  db: DB,
  options: {
    store: JourneyStore
    apply: boolean
    cursor?: StopRepairCursor
    budgetMs?: number
  },
): Promise<StopRepairReport> {
  const { store, apply, cursor, budgetMs = REPAIR_BUDGET_MS } = options
  const began = Date.now()
  const mission = await getActiveMission(db)
  if (!mission)
    throw new LifecycleError('NO_ACTIVE_MISSION', 'No mission is active; land one first.')
  const world = missionWorld(mission)
  const radius = mission.config.rules.stopRadiusM
  const stops = await listStops(db, mission.id)
  const from = cursor?.next ?? 0
  const corrected = new Map(Object.entries(cursor?.corrected ?? {}))
  checkCursor(mission.id, stops, { from, corrected })

  const segments = await Promise.all(
    stops.flatMap((stop) => (stop.fromSegmentId ? [getSegment(db, stop.fromSegmentId)] : [])),
  )
  const byId = new Map(segments.map((segment) => [segment.id, segment]))
  const rows = new Map(stops.map((stop) => [stop.id, stop]))
  const entries: StopRepairEntry[] = []
  let next = from
  for await (const { stop, mask, disk } of rebuildStopMasks({
    stops,
    segments,
    empty: createRevealedMask(world),
    diskOf: (stop) => stopDisk(world, stop, { radius }),
    revealsOf: (segment) => loadRecordReveals(store, byId.get(segment.id)!),
    chunkSize: world.config.chunkSize,
    from,
    maskOf: async (stop) => {
      const key = corrected.get(stop.id)
      return key
        ? decodeRevealedMask(await required(store, key))
        : loadRevealedMask(store, rows.get(stop.id)!)
    },
  })) {
    const row = rows.get(stop.id)!
    const stored = await required(store, row.revealedKey)
    const storedMask = decodeRevealedMask(stored)
    const maskMatches = equalBytes(stored, encodeRevealedMask(mask))
    const packMatches = await ownDisk(store, row)
    const stale = !maskMatches || packMatches === false
    let manifestKey = row.manifestKey
    let applied = false
    if (stale) {
      const { keys } = await publishStop(store, {
        world,
        disk,
        mask,
        missionId: mission.id,
        reachedBy: row.fromSegmentId,
      })
      manifestKey = keys.manifestKey
      corrected.set(row.id, keys.revealedKey)
      if (apply) {
        await underMissionLock(db, { missionId: mission.id, lock: 'wait' }, (tx) =>
          setStopObjects(tx, row.id, keys),
        )
        applied = true
        void primeStop(keys)
      }
    }
    entries.push({
      index: row.index,
      stopId: row.id,
      stored: revealedVertexCount(storedMask),
      recomputed: revealedVertexCount(mask),
      missing: revealedVerticesMissing(mask, storedMask),
      extra: revealedVerticesMissing(storedMask, mask),
      packMatches,
      stale,
      manifestKey,
      applied,
    })
    next++
    if (Date.now() - began >= budgetMs) break
  }
  // A stop settled while this call ran is checked by the next one.
  const total = (await listStops(db, mission.id)).length
  return {
    apply,
    total,
    stops: entries,
    cursor: next < total ? { next, corrected: Object.fromEntries(corrected) } : null,
  }
}

/** Refuses a cursor that names a position past the stops or keys outside the mission's stops. */
function checkCursor(
  missionId: string,
  stops: readonly Stop[],
  cursor: { from: number; corrected: Map<string, string> },
): void {
  const { from, corrected } = cursor
  if (from > stops.length) {
    throw new MissionError(
      'INVALID_INPUT',
      `The cursor starts at stop position ${from}, past the mission's ${stops.length} stops; pass the cursor the previous call answered.`,
    )
  }
  const checked = new Set(stops.slice(0, from).map((stop) => stop.id))
  const prefix = `missions/${missionId}/revealed/`
  for (const [stopId, key] of corrected) {
    if (!checked.has(stopId) || !key.startsWith(prefix) || parseJourneyKey(key)?.kind !== 'stop') {
      throw new MissionError(
        'INVALID_INPUT',
        `The cursor corrects stop ${stopId} with "${key}", which is not a checked stop of mission ${missionId} and one of its masks; pass the cursor the previous call answered.`,
      )
    }
  }
}

async function required(store: JourneyStore, key: string): Promise<Uint8Array> {
  const bytes = await store.getInflated(key)
  if (!bytes) {
    throw new LifecycleError('NOT_PUBLISHED', `Nothing is stored at "${key}" in the journey store.`)
  }
  return bytes
}

/**
 * Whether the stop's manifest describes this stop and its pack holds exactly the chunks it
 * lists, in its order; null when it describes the stop and names no pack. The chunk list itself is
 * not held against today's disk: stops settled under an earlier survey rule list the chunks that
 * rule covered, which is no damage.
 */
async function ownDisk(
  store: JourneyStore,
  row: Pick<Stop, 'id' | 'x' | 'y' | 'manifestKey'>,
): Promise<boolean | null> {
  const stored = await store.getJson(row.manifestKey)
  if (stored === null) {
    throw new LifecycleError(
      'NOT_PUBLISHED',
      `Stop ${row.id} has no manifest at "${row.manifestKey}" in the journey store.`,
    )
  }
  const manifest = parseStopManifest(stored)
  if (manifest.stop.x !== row.x || manifest.stop.y !== row.y) return false
  if (!manifest.packKey) return null
  const pack = await store.getInflated(manifest.packKey)
  if (!pack) return false
  const packed = decodeDiskPack(pack)
  return (
    packed.length === manifest.chunks.length &&
    packed.every(({ cx, cy }, n) => cx === manifest.chunks[n]!.cx && cy === manifest.chunks[n]!.cy)
  )
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let k = 0; k < a.byteLength; k++) if (a[k] !== b[k]) return false
  return true
}

const CursorSchema = v.object({
  next: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  corrected: v.record(v.pipe(v.string(), v.uuid()), v.pipe(v.string(), v.maxLength(256))),
})

const RepairBody = v.object({
  token: v.string(),
  /** Point the stale stops at the right objects; a dry run when false. */
  apply: v.optional(v.boolean(), false),
  cursor: v.optional(CursorSchema),
})

/**
 * `POST /api/admin/repair-stops`: {@link repairStops} on the active mission, one bounded step
 * per call. Refuses as `readAdminBody` does; answers 400 for a malformed body or cursor.
 */
export function defineAdminRepairStopsHandlerWith(context: AdminContext) {
  return defineHandler(async (event) => {
    noStore(event)
    const body = await readAdminBody(event, context)
    const parsed = v.safeParse(RepairBody, body)
    if (!parsed.success) throw new HTTPError(BAD_INPUT.onError(parsed))
    const { apply, cursor } = parsed.output
    try {
      return await repairStops(context.db(), { store: context.store(), apply, cursor })
    } catch (error) {
      throw httpErrorOf(error)
    }
  })
}

/** {@link defineAdminRepairStopsHandlerWith} over the platform's configuration, database and blobs. */
export const defineAdminRepairStopsHandler = () => defineAdminRepairStopsHandlerWith(PLATFORM)
