import type { H3Event } from 'nitro/h3'
import { HTTPError, readBody } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { secureCompare } from 'unsecure'
import type { DB } from '../../database/db'
import { useDB } from '../db'
import type { JourneyStore } from '../journey/store'
import { createJourneyStore } from '../journey/store'

/** The server settings diagnostics report on, by presence only. */
export interface AdminSettings {
  sessionKey: string
  typesafeToken: string
  origins: string
}

/** What the admin routes reach beyond the request; tests pass their own. */
export interface AdminContext {
  /** The configured admin token; empty disables the admin routes. */
  token: () => string
  db: () => DB
  store: () => JourneyStore
  settings: () => AdminSettings
}

export const PLATFORM: AdminContext = {
  token: () => useRuntimeConfig().adminToken,
  db: useDB,
  store: () => createJourneyStore(),
  settings: () => {
    const config = useRuntimeConfig()
    return {
      sessionKey: config.sessionKey,
      typesafeToken: config.typesafeToken,
      origins: config.oauth.origins,
    }
  },
}

const NO_STORE = { 'cache-control': 'no-store', 'netlify-cdn-cache-control': 'no-store' }

export function noStore(event: H3Event) {
  for (const [name, value] of Object.entries(NO_STORE)) event.res.headers.set(name, value)
}

/**
 * The request body once it carries the admin token. Answers 404 while no admin token is
 * configured, so the route does not exist to anyone, and 403 for a token that does not match.
 */
export async function readAdminBody(event: H3Event, context: AdminContext): Promise<unknown> {
  const expected = context.token()
  if (!expected) throw new HTTPError({ status: 404, message: 'Not found.' })
  const body = await readBody<unknown>(event)
  const received = (body as { token?: unknown } | null | undefined)?.token
  if (!secureCompare(expected, typeof received === 'string' ? received : undefined)) {
    throw new HTTPError({ status: 403, message: 'The admin token does not match.' })
  }
  return body
}
