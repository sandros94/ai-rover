import { defineHandler } from 'nitro/h3'
import { requestProviders } from '../utils/auth'

/** The sign-in providers this origin offers, for the login page outside a server render. */
export default defineHandler((event) => {
  event.res.headers.set('cache-control', 'no-store')
  return { providers: requestProviders(event) }
})
