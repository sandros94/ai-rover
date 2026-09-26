import { purgeCache } from '@netlify/functions'
import type { H3Event } from 'nitro/h3'
import { defineHandler, HTTPError } from 'nitro/h3'
import type { UserSessions } from '../../../modules/auth/runtime/server/lib/session'
import { useAuthContext } from '../../../modules/auth/runtime/server/utils/auth'
import type { DB } from '../../database/db'
import { DbError, isMissingUserViolation } from '../../database/errors'
import type { Mission, UserAccount } from '../../database/schema'
import { getActiveMission } from '../../repositories/missions'
import { findUser } from '../../repositories/users'
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
  DbError: {
    NOT_FOUND: 404,
    ALREADY_SUBMITTED: 409,
    INVALID_STATE: 409,
    ROUND_CHANGED: 409,
    USER_GONE: 401,
  },
  LifecycleError: { NO_ACTIVE_MISSION: 404, NO_OPEN_ROUND: 409, MISSION_PAUSED: 423 },
  MissionError: { INVALID_INPUT: 400 },
  NavError: { INVALID_INPUT: 422, OUT_OF_DISK: 422 },
  TerrainError: { OUT_OF_BOUNDS: 422 },
  JudgeError: { NOT_CONFIGURED: 503, UPSTREAM: 502 },
}

/** What a signed-in visitor whose account was deleted is told. */
export const USER_GONE_MESSAGE = 'Your account no longer exists; sign in again.'

/**
 * The HTTP answer for anything a mission route throws: typed errors carry their `code` and
 * message; anything else is logged and answered as a bare 500 so no internals leak. An upstream
 * Jev failure answers its fixed message and logs its cause. A write refused because its user's
 * account is gone answers as {@link DbError} `USER_GONE`.
 */
export function httpErrorOf(thrown: unknown): HTTPError {
  if (HTTPError.isError(thrown)) return thrown
  const error = isMissingUserViolation(thrown)
    ? new DbError('USER_GONE', USER_GONE_MESSAGE, { cause: thrown })
    : thrown
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

/** What mission routes reach beyond the request; tests pass their own. */
export interface MissionRouteContext {
  db: () => DB
  sessions: () => Pick<UserSessions, 'require' | 'clear'>
  store: () => JourneyStore
}

const PLATFORM: MissionRouteContext = {
  db: useDB,
  sessions: () => useAuthContext().sessions,
  store: () => createJourneyStore(),
}

/**
 * The signed-in user's account, read once per request: 401 when signed out, and `USER_GONE`
 * when the session names an account that no longer exists.
 */
export async function requireSessionUser(
  db: DB,
  event: H3Event,
  sessions: Pick<UserSessions, 'require'>,
): Promise<UserAccount> {
  const { user } = await sessions.require(event)
  const account = await findUser(db, user.id)
  if (!account) throw new DbError('USER_GONE', USER_GONE_MESSAGE)
  return account
}

/**
 * A mission route: errors mapped by {@link httpErrorOf}, and the mission brought up to date
 * before the handler runs per `access`, so every read and write sees the state the lazy trigger
 * implies at `now`. A write, or a read whose tick changed something, purges the cached public
 * state once done. Only a successful answer of a `public` route is cacheable. With `user`, the
 * signed-in account is resolved before anything else and handed over; an answer of `USER_GONE`,
 * from there or from a write, also clears the session so the browser signs in afresh.
 */
export function defineMissionHandler<T, A extends MissionAccess, U extends boolean = false>(
  options: { access: A; cache: MissionCache; maxAgeS?: number; user?: U },
  handler: MissionRouteHandler<T, A, U>,
) {
  return defineMissionHandlerWith(PLATFORM, options, handler)
}

export type MissionRouteHandler<T, A extends MissionAccess, U extends boolean> = (
  event: H3Event,
  context: {
    missionId: string
    store: JourneyStore
    /** Created only when a judgment is needed, so routes work without a key until then. */
    jev: JevClient
    now: Date
    tick: A extends 'write' ? TickResult : TickResult | null
    /** The signed-in account, for a route defined with `user`. */
    user: U extends true ? UserAccount : null
  },
) => Promise<T>

/** {@link defineMissionHandler} over `platform` instead of the platform's database and blobs. */
export function defineMissionHandlerWith<T, A extends MissionAccess, U extends boolean = false>(
  platform: MissionRouteContext,
  options: { access: A; cache: MissionCache; maxAgeS?: number; user?: U },
  handler: MissionRouteHandler<T, A, U>,
) {
  return defineHandler(async (event) => {
    const noStore = missionCacheHeaders('', 'none')
    for (const [name, value] of Object.entries(noStore)) event.res.headers.set(name, value)
    let purge: string | undefined
    try {
      const db = platform.db()
      const user = options.user ? await requireSessionUser(db, event, platform.sessions()) : null
      const mission = await getActiveMission(db)
      if (!mission) {
        throw new LifecycleError('NO_ACTIVE_MISSION', 'No mission is active; land one first.')
      }
      const store = platform.store()
      const now = requestNow(event)
      const tick = await syncMission(db, {
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
        user: user as U extends true ? UserAccount : null,
      })
      const headers = missionCacheHeaders(mission.id, options.cache, options)
      for (const [name, value] of Object.entries(headers)) event.res.headers.set(name, value)
      return result
    } catch (error) {
      const answer = httpErrorOf(error)
      if ((answer.body as { code?: unknown } | undefined)?.code !== 'USER_GONE') throw answer
      await platform.sessions().clear(event)
      // An error answer carries its own headers, not the event's: the cleared cookie rides on it.
      const cleared = event.res.headers.getSetCookie().map((cookie) => ['set-cookie', cookie])
      throw new HTTPError({
        status: answer.status,
        message: answer.message,
        body: answer.body,
        headers: cleared as [string, string][],
        cause: answer.cause,
      })
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
