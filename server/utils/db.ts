import { getDatabase } from '@netlify/database'
import { drizzle } from 'drizzle-orm/netlify-db'
import type { DB } from '../database/db'
import { relations } from '../database/schema'

let shared: DB | undefined

/**
 * The platform database, connected on first call; importing this file opens nothing. The
 * platform picks the connector per environment (a pooled server connection, or HTTP plus a
 * WebSocket pool inside Functions), and the driver follows it.
 */
export function useDB(): DB {
  shared ??= drizzle({ client: getDatabase(), relations })
  return shared
}
