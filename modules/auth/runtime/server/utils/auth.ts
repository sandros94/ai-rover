import type { H3Event } from 'nitro/h3'
import { defineHandler } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import type { AuthProvider, SignedInSession, UserSession } from '../../types'
import { createAtprotoHandler } from '../lib/atproto/handler'
import type { AuthContext } from '../lib/context'
import { createAuthContext } from '../lib/context'
import type { DiscordConfig } from '../lib/discord'
import { createDiscordHandler } from '../lib/discord'
import type { GitHubConfig } from '../lib/github'
import { createGitHubHandler } from '../lib/github'
import type { OAuthHandlerOptions } from '../lib/oauth'
import { providersFor } from '../lib/providers'

let shared: AuthContext | undefined

/**
 * The server's auth context, built on first use from `runtimeConfig.sessionKey`
 * (`NUXT_SESSION_KEY`) and `runtimeConfig.oauth.origins` (`NUXT_OAUTH_ORIGINS`).
 */
export function useAuthContext(): AuthContext {
  if (!shared) {
    const config = useRuntimeConfig()
    shared = createAuthContext({
      key: config.sessionKey,
      origins: config.oauth.origins,
      dev: Boolean(import.meta.dev),
    })
  }
  return shared
}

/** The sign-in providers offered on the origin `event` was addressed to. */
export function requestProviders(event: H3Event): AuthProvider[] {
  return providersFor(new URL(event.req.url).origin, {
    origins: useAuthContext().origins,
    github: useRuntimeConfig().oauth.github,
    discord: useRuntimeConfig().oauth.discord,
  })
}

export function getUserSession(event: H3Event): Promise<UserSession> {
  return useAuthContext().sessions.get(event)
}

export function setUserSession(event: H3Event, data: UserSession): Promise<UserSession> {
  return useAuthContext().sessions.set(event, data)
}

export function replaceUserSession(event: H3Event, data: UserSession): Promise<UserSession> {
  return useAuthContext().sessions.replace(event, data)
}

export function clearUserSession(event: H3Event): Promise<void> {
  return useAuthContext().sessions.clear(event)
}

/** The signed-in session, or a 401. */
export function requireUserSession(event: H3Event): Promise<SignedInSession> {
  return useAuthContext().sessions.require(event)
}

export interface OAuthEventHandlerOptions<Config> extends OAuthHandlerOptions {
  /** Overrides of the runtime config, and the `fetch` the flow uses (for tests). */
  config?: Partial<Config> & { fetch?: typeof globalThis.fetch }
}

/** GitHub sign-in at the route it is mounted on; answers 404 until the client id and secret are set. */
export function defineOAuthGitHubEventHandler(options: OAuthEventHandlerOptions<GitHubConfig>) {
  let handler: ReturnType<typeof createGitHubHandler> | undefined
  return defineHandler((event) => {
    handler ??= createGitHubHandler(
      contextFor(options.config?.fetch),
      () => ({ ...useRuntimeConfig().oauth.github, ...options.config }),
      options,
    )
    return handler(event)
  })
}

/** Discord sign-in at the route it is mounted on; answers 404 until the client id and secret are set. */
export function defineOAuthDiscordEventHandler(options: OAuthEventHandlerOptions<DiscordConfig>) {
  let handler: ReturnType<typeof createDiscordHandler> | undefined
  return defineHandler((event) => {
    handler ??= createDiscordHandler(
      contextFor(options.config?.fetch),
      () => ({ ...useRuntimeConfig().oauth.discord, ...options.config }),
      options,
    )
    return handler(event)
  })
}

/** AT Protocol sign-in; must be mounted at `/api/auth/atproto`, the published redirect URI. */
export function defineOAuthAtprotoEventHandler(options: OAuthEventHandlerOptions<object>) {
  let handler: ReturnType<typeof createAtprotoHandler> | undefined
  return defineHandler((event) => {
    handler ??= createAtprotoHandler(contextFor(options.config?.fetch), options)
    return handler(event)
  })
}

function contextFor(fetch: typeof globalThis.fetch | undefined): AuthContext {
  const context = useAuthContext()
  return fetch ? { ...context, fetch } : context
}
