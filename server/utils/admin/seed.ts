import { sql } from 'drizzle-orm'
import { defineHandler, HTTPError, readBody } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { secureCompare } from 'unsecure'
import * as v from 'valibot'
import type { DB } from '../../database/db'
import { mission } from '../../database/schema'
import { useDB } from '../db'
import type { JourneyStore } from '../journey/store'
import { createJourneyStore } from '../journey/store'
import { createMissionAtStop } from '../mission/create'
import { httpErrorOf } from '../mission/http'
import { BAD_INPUT } from '../mission/validation'

/** What the admin routes reach beyond the request; tests pass their own. */
export interface AdminContext {
  /** The configured admin token; empty disables the admin routes. */
  token: () => string
  db: () => DB
  store: () => JourneyStore
}

const PLATFORM: AdminContext = {
  token: () => useRuntimeConfig().adminToken,
  db: useDB,
  store: () => createJourneyStore(),
}

const finite = v.pipe(v.number(), v.finite())

const SeedBody = v.object({
  token: v.string(),
  /** World seed; default `mars`. */
  seed: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)), 'mars'),
  /** Stop 0, world metres; default the origin. */
  x: v.optional(finite, 0),
  y: v.optional(finite, 0),
})

export interface SeedAnswer {
  missionId: string
  stopId: string
  roundId: string
  worldHash: string
}

const NO_STORE = { 'cache-control': 'no-store', 'netlify-cdn-cache-control': 'no-store' }

function noStore(event: { res: { headers: Headers } }) {
  for (const [name, value] of Object.entries(NO_STORE)) event.res.headers.set(name, value)
}

/** `GET /api/admin/status`: whether an admin token is configured, and nothing else. */
export function defineAdminStatusHandlerWith(context: AdminContext) {
  return defineHandler((event) => {
    noStore(event)
    return { configured: context.token() !== '' }
  })
}

/**
 * `POST /api/admin/seed`: lands the first mission at `{ x, y }` of the world `seed`, with the
 * default world and rules. Answers 404 while no admin token is configured, so the route does not
 * exist to anyone, 403 for a token that does not match, and 409 once any mission exists: there
 * is no reset here.
 */
export function defineAdminSeedHandlerWith(context: AdminContext) {
  return defineHandler(async (event) => {
    noStore(event)
    const expected = context.token()
    if (!expected) throw new HTTPError({ status: 404, message: 'Not found.' })
    const body = await readBody<unknown>(event)
    const received = (body as { token?: unknown } | null | undefined)?.token
    if (!secureCompare(expected, typeof received === 'string' ? received : undefined)) {
      throw new HTTPError({ status: 403, message: 'The admin token does not match.' })
    }
    const parsed = v.safeParse(SeedBody, body)
    if (!parsed.success) throw new HTTPError(BAD_INPUT.onError(parsed))
    const { seed, x, y } = parsed.output

    const db = context.db()
    try {
      const landed = await db.transaction(async (tx) => {
        // Serialises landings, so two at once cannot both find the database empty.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('jev-mission-landing'))`)
        const [existing] = await tx.select({ id: mission.id }).from(mission).limit(1)
        if (existing) {
          throw new HTTPError({
            status: 409,
            message: `A mission already exists (${existing.id}); seeding lands only the first.`,
            body: { missionId: existing.id },
          })
        }
        return createMissionAtStop(tx, { store: context.store(), seed, at: { x, y } })
      })
      event.res.status = 201
      return {
        missionId: landed.mission.id,
        stopId: landed.stop.id,
        roundId: landed.round.id,
        worldHash: landed.mission.worldHash,
      } satisfies SeedAnswer
    } catch (error) {
      throw httpErrorOf(error)
    }
  })
}

/** {@link defineAdminStatusHandlerWith} over the platform's configuration. */
export const defineAdminStatusHandler = () => defineAdminStatusHandlerWith(PLATFORM)

/** {@link defineAdminSeedHandlerWith} over the platform's configuration, database and blobs. */
export const defineAdminSeedHandler = () => defineAdminSeedHandlerWith(PLATFORM)
