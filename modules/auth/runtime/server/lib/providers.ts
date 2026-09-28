import type { AuthProvider } from '../../types'
import type { OAuthAppConfig } from './code-flow'
import type { OriginPolicy } from './origins'
import { isLoopbackOrigin } from './origins'

export interface ProvidersConfig {
  origins: Pick<OriginPolicy, 'allows'>
  github: OAuthAppConfig
  discord: OAuthAppConfig
}

/**
 * The sign-in providers a visitor on `origin` is offered: none on an origin sign-in may not
 * redirect to; GitHub and Discord once their apps are configured; AT Protocol on HTTPS or loopback, the only
 * origins its authorization servers accept for a public client.
 */
export function providersFor(origin: string, config: ProvidersConfig): AuthProvider[] {
  if (!config.origins.allows(origin)) return []
  const providers: AuthProvider[] = []
  if (configured(config.github)) providers.push('github')
  if (configured(config.discord)) providers.push('discord')
  if (origin.startsWith('https://') || isLoopbackOrigin(origin)) providers.push('atproto')
  return providers
}

function configured(app: OAuthAppConfig): boolean {
  return Boolean(app.clientId && app.clientSecret)
}
