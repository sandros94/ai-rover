import { useRuntimeConfig } from 'nitro/runtime-config'
import { jevCacheOver } from '../../repositories/judgments'
import { useDB } from '../db'
import type { JevClient } from './client'
import { createJevClient, JEV_SERVER_LIMITS, TYPESAFE_API_URL } from './client'

// Nitro auto-imports every file under `server/utils`, so this folder has no barrel re-exports.

let shared: JevClient | undefined

/**
 * Where the judgments come from, in order of preference: the project's own TypeSafe key
 * (`NUXT_TYPESAFE_TOKEN`) against the public API, else the hosting platform's AI gateway when it
 * injects `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL` into the runtime (billed to the hosting
 * account, no TypeSafe account needed), else nothing, which the client reports as
 * `NOT_CONFIGURED`.
 */
export function jevCredentials(): { apiKey: string | undefined; baseURL: string } {
  const own = useRuntimeConfig().typesafeToken?.trim()
  if (own) return { apiKey: own, baseURL: TYPESAFE_API_URL }
  const gatewayKey = process.env.TYPESAFE_API_KEY?.trim()
  const gatewayURL = process.env.TYPESAFE_BASE_URL?.trim()
  if (gatewayKey && gatewayURL) return { apiKey: gatewayKey, baseURL: gatewayURL }
  return { apiKey: undefined, baseURL: TYPESAFE_API_URL }
}

/**
 * The server's Jev client, created on first use from {@link jevCredentials} with its answers
 * cached in the database, under {@link JEV_SERVER_LIMITS}. Throws `NOT_CONFIGURED` while no key is available, and tries again on
 * the next call.
 */
export function useJevClient(): JevClient {
  shared ??= createJevClient({
    ...jevCredentials(),
    ...JEV_SERVER_LIMITS,
    cache: jevCacheOver(useDB()),
  })
  return shared
}
