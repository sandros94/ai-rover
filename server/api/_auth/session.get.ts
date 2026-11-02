import { defineHandler } from 'nitro/h3'
import type { SessionData } from '#shared/types/session'
import { useAuthSession } from '../../utils/session'

/** The session as the client sees it, `{}` when signed out; never cached. */
export default defineHandler(async (event): Promise<SessionData | Record<string, never>> => {
  event.res.headers.set('cache-control', 'no-store')
  const session = await useAuthSession(event)
  return session.id ? session.data : {}
})
