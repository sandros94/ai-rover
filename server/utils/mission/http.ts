import type { H3Event } from 'nitro/h3'
import { defineHandler, HTTPError } from 'nitro/h3'
import { DbError } from '../../database/errors'
import { getActiveMission } from '../../repositories/missions'
import { useDB } from '../db'
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
  DbError: { NOT_FOUND: 404, ALREADY_SUBMITTED: 409, INVALID_STATE: 409 },
  LifecycleError: { NO_ACTIVE_MISSION: 404, NO_OPEN_ROUND: 409, AUTHOR_DRIVING: 403 },
  MissionError: { INVALID_INPUT: 400 },
  NavError: { INVALID_INPUT: 422, OUT_OF_DISK: 422 },
  TerrainError: { OUT_OF_BOUNDS: 422 },
  JudgeError: { NOT_CONFIGURED: 503, UPSTREAM: 502 },
}

/**
 * The HTTP answer for anything a mission route throws: typed errors carry their `code` and
 * message; anything else is logged and answered as a bare 500 so no internals leak.
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
 * A mission route: never cached, errors mapped by {@link httpErrorOf}, and the mission brought up
 * to date before the handler runs, so every read and write sees the state the lazy trigger
 * implies at `now`.
 */
export function defineMissionHandler<T>(
  handler: (
    event: H3Event,
    context: { missionId: string; store: JourneyStore; now: Date; tick: TickResult },
  ) => Promise<T>,
) {
  return defineHandler(async (event) => {
    event.res.headers.set('cache-control', 'no-store')
    try {
      const mission = await getActiveMission(useDB())
      if (!mission) {
        throw new LifecycleError('NO_ACTIVE_MISSION', 'No mission is active; land one first.')
      }
      const store = createJourneyStore()
      const now = requestNow(event)
      const tick = await tickMission(useDB(), { missionId: mission.id, store, now })
      return await handler(event, { missionId: mission.id, store, now, tick })
    } catch (error) {
      throw httpErrorOf(error)
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
