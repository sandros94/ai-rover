import { getDatabase } from '@netlify/database'
import { drizzle as drizzleOverNeonPool } from 'drizzle-orm/neon-serverless'
import { drizzle as drizzleOverPgPool } from 'drizzle-orm/node-postgres'
import type { DB } from '../database/db'
import { relations } from '../database/schema'

let shared: DB | undefined

/**
 * The platform database, connected on first call; importing this file opens nothing.
 *
 * Every query goes through the connection's pool, never through the platform's HTTP client: in
 * Functions the platform pairs an HTTP client with a WebSocket pool, and Drizzle's own driver
 * for that pair sends plain queries to the HTTP client in a call form the client no longer
 * accepts, while transactions went through the pool and worked. Running everything over the
 * pool keeps one code path, with transactions and advisory locks available everywhere.
 */
export function useDB(): DB {
  if (!shared) {
    const connection = getDatabase()
    shared =
      connection.driver === 'serverless'
        ? drizzleOverNeonPool({ client: connection.pool, relations })
        : drizzleOverPgPool({ client: connection.pool, relations })
  }
  return shared
}
