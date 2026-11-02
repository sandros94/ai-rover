import { defineHandler } from 'nitro/h3'
import { useAuthSession } from '../../utils/session'

/** Signs out: expires the session cookie. */
export default defineHandler(async (event) => {
  event.res.headers.set('cache-control', 'no-store')
  await (await useAuthSession(event)).clear()
  return { loggedOut: true }
})
