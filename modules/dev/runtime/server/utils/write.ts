import type { H3Event } from 'nitro/h3'
import { defineHandler, HTTPError } from 'nitro/h3'
import { assertLoopback, RemoteDatabaseError } from './loopback'
import { isSameOrigin } from './origin'

/**
 * A dev route that writes the local database or journey store. Accepted only from the dev
 * server's own pages, so another site open in the same browser cannot make it write (403);
 * refuses (403) while `NETLIFY_DB_URL` is not on this machine. `handler` runs only once both
 * pass; a `RemoteDatabaseError` it throws is answered 403 too, any other error as is.
 */
export function defineDevWriteHandler<T>(handler: (event: H3Event) => T | Promise<T>) {
  return defineHandler(async (event) => {
    if (!isSameOrigin(event.req)) {
      throw new HTTPError(
        `${event.req.method} ${event.url.pathname} is accepted only from the dev server's own pages.`,
        { status: 403 },
      )
    }
    try {
      assertLoopback(process.env.NETLIFY_DB_URL)
      return await handler(event)
    } catch (error) {
      if (error instanceof RemoteDatabaseError) throw new HTTPError(error.message, { status: 403 })
      throw error
    }
  })
}
