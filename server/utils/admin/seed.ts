import { defineHandler, HTTPError, readBody } from 'nitro/h3'
import * as v from 'valibot'
import { createMissionAtStop } from '../mission/create'
import { httpErrorOf } from '../mission/http'
import { BAD_INPUT } from '../mission/validation'
import type { AdminContext } from './access'
import { noStore, PLATFORM, requireAdmin } from './access'

const finite = v.pipe(v.number(), v.finite())

const SeedBody = v.object({
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

/**
 * `POST /api/admin/seed`: lands a mission at `{ x, y }` of the world `seed`, with the default
 * world and rules. Answers 404 to anyone but an admin, and 409 (`MISSION_ACTIVE`) while a
 * mission is active: the landing itself refuses then.
 */
export function defineAdminSeedHandlerWith(context: AdminContext) {
  return defineHandler(async (event) => {
    noStore(event)
    await requireAdmin(event, context)
    const parsed = v.safeParse(SeedBody, (await readBody<unknown>(event)) ?? {})
    if (!parsed.success) throw new HTTPError(BAD_INPUT.onError(parsed))
    const { seed, x, y } = parsed.output
    try {
      const landed = await createMissionAtStop(context.db(), {
        store: context.store(),
        seed,
        at: { x, y },
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

/** {@link defineAdminSeedHandlerWith} over the platform's configuration, database and blobs. */
export const defineAdminSeedHandler = () => defineAdminSeedHandlerWith(PLATFORM)
