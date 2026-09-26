import directory from '#dev-migrations'
import { defineHandler, HTTPError, readBody } from 'nitro/h3'
import * as v from 'valibot'
import { TerrainError } from '#shared/utils/terrain'
import { createJourneyStore } from '#server/utils/journey/store'
import {
  assertLoopback,
  DatabaseRefusedError,
  prepareLocalDatabase,
  RemoteDatabaseError,
  resetLocalDatabase,
} from '../utils/migrate'
import { MissionExistsError, seedLocalMission } from '../utils/seed'
import { databaseStatus } from '../utils/status'

const PREFIX = '/__jev/db'

const finite = v.pipe(v.number(), v.finite())

const SeedSchema = v.optional(
  v.object({
    seed: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
    x: v.optional(finite),
    y: v.optional(finite),
    force: v.optional(v.boolean()),
  }),
  {},
)

type Route = (url: string | undefined, body: () => Promise<unknown>) => Promise<unknown>

const ROUTES: Record<string, Route> = {
  'GET /status': (url) => databaseStatus(url, directory),
  'POST /migrate': async (url) => {
    assertLoopback(url)
    await prepareLocalDatabase(url, directory)
    return databaseStatus(url, directory)
  },
  'POST /reset': async (url) => {
    await resetLocalDatabase(url, directory)
    return databaseStatus(url, directory)
  },
  'POST /seed': async (url, body) => {
    const input = v.safeParse(SeedSchema, await body())
    if (!input.success) {
      throw new HTTPError(
        input.issues
          .map((issue) => `${v.getDotPath(issue) ?? 'body'}: ${issue.message}`)
          .join('; '),
        { status: 400 },
      )
    }
    return seedLocalMission(url, directory, input.output)
  },
  'POST /journey/clear': async (url) => {
    assertLoopback(url)
    const store = createJourneyStore()
    const keys = await store.listKeys()
    for (const key of keys) await store.delete(key)
    return { deleted: keys.length }
  },
}

/** The Database tab's JSON routes. */
export default defineHandler(async (event) => {
  const route = ROUTES[`${event.req.method} ${event.url.pathname.slice(PREFIX.length)}`]
  if (!route) throw HTTPError.status(404)
  try {
    return await route(process.env.NETLIFY_DB_URL, () => readBody(event))
  } catch (error) {
    if (error instanceof RemoteDatabaseError) throw new HTTPError(error.message, { status: 403 })
    if (error instanceof MissionExistsError) throw new HTTPError(error.message, { status: 409 })
    if (error instanceof DatabaseRefusedError) throw new HTTPError(error.message, { status: 503 })
    if (error instanceof TerrainError) throw new HTTPError(error.message, { status: 400 })
    throw error
  }
})
