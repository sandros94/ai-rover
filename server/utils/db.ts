import { getDatabase } from '@netlify/database'
import { drizzle } from 'drizzle-orm/netlify-db'
import type { Db } from '../database/db'
import { relations } from '../database/schema'

let shared: Db | undefined

/**
 * The platform database, connected on first call; importing this file opens nothing. The
 * platform picks the connector per environment (a pooled server connection, or HTTP plus a
 * WebSocket pool inside Functions), and the driver follows it.
 */
export function useDB(): Db {
  shared ??= drizzle({ client: getDatabase(), relations })
  return shared
}
