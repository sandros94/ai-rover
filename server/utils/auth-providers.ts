import type { H3Event } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import type { AuthProvider } from '#shared/utils/sign-in'
import type { OAuthApp } from './oauth-sign-in'
import { atprotoServes, isConfigured, signInOrigins } from './oauth-sign-in'

export interface ProvidersConfig {
  /** The origins every provider signs in on: `NUXT_OAUTH_ORIGINS` and the site's main address. */
  origins: string[]
  /** The deploy's own addresses besides {@link origins}, where AT Protocol alone signs in. */
  deployOrigins?: string[]
  github: OAuthApp
  discord: OAuthApp
}

/**
 * The sign-in providers a visitor on `origin` is offered: none on an origin the sign-in routes
 * do not run on; GitHub and Discord once their apps are configured, on the origins every provider
 * signs in on; AT Protocol on those and the deploy's own addresses, when https (without a port)
 * or loopback, the only origins its authorization servers accept for a public client.
 */
export function providersFor(origin: string, config: ProvidersConfig): AuthProvider[] {
  const everyProvider = config.origins.includes(origin)
  if (!everyProvider && !config.deployOrigins?.includes(origin)) return []
  const providers: AuthProvider[] = []
  if (everyProvider && isConfigured(config.github)) providers.push('github')
  if (everyProvider && isConfigured(config.discord)) providers.push('discord')
  if (atprotoServes(origin)) providers.push('atproto')
  return providers
}

/** The sign-in providers offered on the origin `event` was addressed to. */
export function requestProviders(event: H3Event): AuthProvider[] {
  const { oauth } = useRuntimeConfig()
  return providersFor(new URL(event.req.url).origin, {
    ...signInOrigins(oauth),
    github: oauth.github,
    discord: oauth.discord,
  })
}
