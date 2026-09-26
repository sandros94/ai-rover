import type { H3Event } from 'nitro/h3'
import type { UserSessions } from './session'

/** `GET` and `DELETE /api/_auth/session`: the session as the client sees it, never cached. */
export function createSessionRoutes(sessions: UserSessions) {
  return {
    get: async (event: H3Event) => {
      event.res.headers.set('cache-control', 'no-store')
      return sessions.get(event)
    },
    clear: async (event: H3Event) => {
      event.res.headers.set('cache-control', 'no-store')
      await sessions.clear(event)
      return { loggedOut: true }
    },
  }
}
