import type { FlowCookie } from './flow'
import { createFlowCookie } from './flow'
import { sessionKey } from './key'
import type { OriginPolicy } from './origins'
import { originPolicy } from './origins'
import type { UserSessions } from './session'
import { createUserSessionsWithKey } from './session'

/** What every sign-in handler shares: the session, the flow cookie, the origins and `fetch`. */
export interface AuthContext {
  sessions: UserSessions
  flow: FlowCookie
  origins: OriginPolicy
  fetch: typeof globalThis.fetch
  dev: boolean
}

export interface AuthContextOptions {
  /** `NUXT_SESSION_KEY`. */
  key: string
  /** `NUXT_OAUTH_ORIGINS`. */
  origins: string
  dev: boolean
  fetch?: typeof globalThis.fetch
}

export function createAuthContext(options: AuthContextOptions): AuthContext {
  const key = sessionKey(options.key, options.dev)
  return {
    sessions: createUserSessionsWithKey(key, options.dev),
    flow: createFlowCookie(key, options.dev),
    origins: originPolicy(options.origins, options.dev),
    fetch: options.fetch ?? globalThis.fetch,
    dev: options.dev,
  }
}
