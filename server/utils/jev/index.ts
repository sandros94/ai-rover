import { useRuntimeConfig } from 'nitro/runtime-config'
import { jevCacheOver } from '../../repositories/judgments'
import { useDB } from '../db'
import type { JevClient } from './client'
import { createJevClient, JEV_SERVER_LIMITS, jevCredentialsOf } from './client'

// Nitro auto-imports every file under `server/utils`, so this folder has no barrel re-exports.

let shared: JevClient | undefined

/** {@link jevCredentialsOf} with the project's key from the runtime config. */
export function jevCredentials(): { apiKey: string | undefined; baseURL: string } {
  return jevCredentialsOf(useRuntimeConfig().typesafeToken)
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
