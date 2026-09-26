import { purgeCache } from '@netlify/functions'
import type { H3Event } from 'nitro/h3'
import { defineHandler, HTTPError } from 'nitro/h3'
import type { DB } from '../../database/db'
import { DbError } from '../../database/errors'
import type { Mission } from '../../database/schema'
import { getActiveMission } from '../../repositories/missions'
import { useDB } from '../db'
import { useJevClient } from '../jev'
import type { JevClient } from '../jev/client'
import { JudgeError } from '../jev/errors'
import type { JourneyStore } from '../journey/store'
import { createJourneyStore } from '../journey/store'
import { MissionError } from '#shared/utils/mission'
import { NavError } from '#shared/utils/nav'
import { TerrainError } from '#shared/utils/terrain'
import { LifecycleError } from './errors'
import type { TickResult } from './tick'
import { tickMission } from './tick'

/** Status per typed error code; codes absent here are server faults and answer 500. */
const STATUS: Record<string, Record<string, number>> = {
  DbError: { NOT_FOUND: 404, ALREADY_SUBMITTED: 409, INVALID_STATE: 409, ROUND_CHANGED: 409 },
  LifecycleError: { NO_ACTIVE_MISSION: 404, NO_OPEN_ROUND: 409, MISSION_PAUSED: 423 },
  MissionError: { INVALID_INPUT: 400 },
  NavError: { INVALID_INPUT: 422, OUT_OF_DISK: 422 },
  TerrainError: { OUT_OF_BOUNDS: 422 },
  JudgeError: { NOT_CONFIGURED: 503, UPSTREAM: 502 },
}

/**
 * The HTTP answer for anything a mission route throws: typed errors carry their `code` and
 * message; anything else is logged and answered as a bare 500 so no internals leak. An upstream
 * Jev failure answers its fixed message and logs its cause.
 */
export function httpErrorOf(error: unknown): HTTPError {
  if (HTTPError.isError(error)) return error
  const typed =
    error instanceof DbError ||
    error instanceof LifecycleError ||
    error instanceof MissionError ||
    error instanceof NavError ||
    error instanceof TerrainError ||
    error instanceof JudgeError
  const status = typed ? STATUS[error.name]?.[error.code] : undefined
  if (typed && status) {
    if (error instanceof JudgeError && error.code === 'UPSTREAM') {
      console.error('[jev] judgment service failed:', error.cause)
    }
    return new HTTPError({
      status,
      message: error.message,
      body: { code: error.code },
      cause: error,
    })
  }
  console.error(error)
  return new HTTPError({ status: 500, message: 'Internal server error.' })
}

/**
 * The server's Jev client, created only when a tick has something to judge, so routes keep
 * working without a TypeSafe key until a settlement needs one.
 */
const LAZY_JEV: JevClient = {
  judgeSubmission: (summary, options) => useJevClient().judgeSubmission(summary, options),
}

/**
 * What a mission route does to the mission. `read`: brings it up to date only when something is
 * due, so a poll takes no lock while nothing happens. `write`: always brings it up to date first,
 * under the lock, and purges the cached public state afterwards.
 */
export type MissionAccess = 'read' | 'write'

/** `public`: the same answer for everyone, cached briefly by browsers and the CDN. */
export type MissionCache = 'public' | 'none'

/**
 * Response headers for a mission route's answer. A `public` one is kept `maxAgeS` (default 5)
 * and served stale while it revalidates.
 */
export function missionCacheHeaders(
  missionId: string,
  cache: MissionCache,
  options: { maxAgeS?: number } = {},
): Record<string, string> {
  if (cache === 'none') {
    return { 'cache-control': 'no-store', 'netlify-cdn-cache-control': 'no-store' }
  }
  const control = `public, max-age=${options.maxAgeS ?? 5}, stale-while-revalidate=30`
  return {
    'cache-control': control,
    'netlify-cdn-cache-control': `${control}, durable`,
    'netlify-cache-tag': `mission-${missionId}`,
  }
}

/**
 * Drops the CDN's copies of the mission's public state. Only Netlify has that cache; a failed
 * purge is logged and leaves the copies to expire within their short lifetime.
 */
export async function purgeMissionCache(missionId: string): Promise<void> {
  if (!process.env.NETLIFY) return
  try {
    await purgeCache({ tags: [`mission-${missionId}`] })
  } catch (error) {
    console.error(`[mission] purging the cache of mission ${missionId} failed:`, error)
  }
}

/**
 * Brings the mission up to `now` as a route of `access` needs; null when a read found nothing
 * due and did not tick. A read reads the recorded next due instant without any lock.
 */
export async function syncMission(
  db: DB,
  options: {
    mission: Pick<Mission, 'id' | 'nextDueAt'>
    access: MissionAccess
    store: JourneyStore
    jev: JevClient
    now: Date
  },
): Promise<TickResult | null> {
  const { mission, access, store, jev, now } = options
  const due = mission.nextDueAt !== null && mission.nextDueAt.getTime() <= now.getTime()
  if (access === 'read' && !due) return null
  return tickMission(db, { missionId: mission.id, store, jev, now })
}

function changed(tick: TickResult | null): boolean {
  return tick !== null && Object.values(tick).some((step) => step !== null)
}

/**
 * A mission route: errors mapped by {@link httpErrorOf}, and the mission brought up to date
 * before the handler runs per `access`, so every read and write sees the state the lazy trigger
 * implies at `now`. A write, or a read whose tick changed something, purges the cached public
 * state once done. Only a successful answer of a `public` route is cacheable.
 */
export function defineMissionHandler<T, A extends MissionAccess>(
  options: { access: A; cache: MissionCache; maxAgeS?: number },
  handler: (
    event: H3Event,
    context: {
      missionId: string
      store: JourneyStore
      /** Created only when a judgment is needed, so routes work without a key until then. */
      jev: JevClient
      now: Date
      tick: A extends 'write' ? TickResult : TickResult | null
    },
  ) => Promise<T>,
) {
  return defineHandler(async (event) => {
    const noStore = missionCacheHeaders('', 'none')
    for (const [name, value] of Object.entries(noStore)) event.res.headers.set(name, value)
    let purge: string | undefined
    try {
      const mission = await getActiveMission(useDB())
      if (!mission) {
        throw new LifecycleError('NO_ACTIVE_MISSION', 'No mission is active; land one first.')
      }
      const store = createJourneyStore()
      const now = requestNow(event)
      const tick = await syncMission(useDB(), {
        mission,
        access: options.access,
        store,
        jev: LAZY_JEV,
        now,
      })
      if (options.access === 'write' || changed(tick)) purge = mission.id
      const result = await handler(event, {
        missionId: mission.id,
        store,
        jev: LAZY_JEV,
        now,
        tick: tick as A extends 'write' ? TickResult : TickResult | null,
      })
      const headers = missionCacheHeaders(mission.id, options.cache, options)
      for (const [name, value] of Object.entries(headers)) event.res.headers.set(name, value)
      return result
    } catch (error) {
      throw httpErrorOf(error)
    } finally {
      if (purge) await purgeMissionCache(purge)
    }
  })
}

/**
 * The instant a request acts at. Under `nuxt dev` a `now` query parameter (ISO 8601 or epoch
 * milliseconds) replaces the clock, to walk a mission through time; elsewhere it is ignored.
 */
export function requestNow(event: H3Event): Date {
  // TODO(dev-only): the clock override goes with the other dev-only affordances before launch.
  const raw = import.meta.dev ? event.url.searchParams.get('now') : null
  if (raw === null) return new Date()
  const at = new Date(/^\d+$/.test(raw) ? Number(raw) : raw)
  if (Number.isNaN(at.getTime())) {
    throw new HTTPError({
      status: 400,
      message: `The now parameter "${raw}" is not a date; pass ISO 8601 or epoch milliseconds.`,
    })
  }
  return at
}
