import { useRuntimeConfig } from 'nitro/runtime-config'
import { jevCacheOver } from '../../repositories/judgments'
import { useDB } from '../db'
import type { JevClient } from './client'
import { createJevClient } from './client'

// Nitro auto-imports every file under `server/utils`, so this folder has no barrel re-exports.

let shared: JevClient | undefined

/**
 * The server's Jev client, created on first use from `runtimeConfig.typesafeToken`
 * (`NUXT_TYPESAFE_TOKEN`) with its answers cached in the database. Throws `NOT_CONFIGURED` while
 * no key is set, and tries again on the next call.
 */
export function useJevClient(): JevClient {
  shared ??= createJevClient({
    apiKey: useRuntimeConfig().typesafeToken,
    cache: jevCacheOver(useDB()),
  })
  return shared
}
