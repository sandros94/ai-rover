import { defineHandler } from 'nitro/h3'
import { requestProviders } from '../utils/auth'

/*
 * A server render fetches its data in-process, from an internal address that is never an
 * allowed origin; the render reads the providers from here instead, decided on the visitor's.
 */
export default defineHandler((event) => {
  event.context.authProviders = requestProviders(event)
})
