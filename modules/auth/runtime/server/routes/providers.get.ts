import { defineHandler } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import type { AuthProvider } from '../../types'
import { isLoopbackOrigin } from '../lib/origins'
import { useAuthContext } from '../utils/auth'

/** The sign-in providers this origin offers, for the login page. */
export default defineHandler((event) => {
  const { github } = useRuntimeConfig().oauth
  const origin = new URL(event.req.url).origin
  const providers: AuthProvider[] = []
  if (useAuthContext().origins.allows(origin)) {
    if (github.clientId && github.clientSecret) providers.push('github')
    if (origin.startsWith('https://') || isLoopbackOrigin(origin)) providers.push('atproto')
  }
  event.res.headers.set('cache-control', 'no-store')
  return { providers }
})
