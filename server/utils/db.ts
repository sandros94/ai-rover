import type { ServerlessDatabaseConnection } from '@netlify/database'
import { getDatabase } from '@netlify/database'
import { drizzle } from 'drizzle-orm/netlify-db'
import type { DB } from '../database/db'
import { relations } from '../database/schema'

type HttpClient = ServerlessDatabaseConnection['httpClient']

/**
 * `http` with Drizzle's `http(text, params, options)` calls routed to `http.query()`: Drizzle's
 * `netlify-db` adapter (1.0.0-rc.5) calls Neon's HTTP client that way, a form
 * `@neondatabase/serverless` 1.x accepts only through `query()`, so without it every query in a
 * Function fails with "This function can now be called only as a tagged-template function".
 * Under `nuxt dev` the connection is `pg` over the wire and never reaches the HTTP client. Drop it
 * once Drizzle routes the call itself.
 */
function queryable(http: HttpClient): HttpClient {
  type Rest = Parameters<HttpClient['query']> extends [string, ...infer R] ? R : never
  const call = (text: TemplateStringsArray | string, ...rest: Rest) =>
    typeof text === 'string' ? http.query(text, ...rest) : http(text, ...rest)
  return Object.assign(call, {
    query: http.query.bind(http),
    transaction: http.transaction,
    unsafe: http.unsafe.bind(http),
  })
}

let shared: DB | undefined

/**
 * The platform database, connected on first call; importing this file opens nothing.
 * `getDatabase()` reads `NETLIFY_DB_URL` and picks the driver from `NETLIFY_DB_DRIVER`: Neon's
 * serverless driver in Functions, `pg` otherwise, as the development socket exports. Throws
 * `MissingDatabaseConnectionError` while `NETLIFY_DB_URL` is unset.
 */
export function useDB(): DB {
  if (!shared) {
    const connection = getDatabase()
    shared = drizzle({
      client:
        connection.driver === 'serverless'
          ? { ...connection, httpClient: queryable(connection.httpClient) }
          : connection,
      relations,
    })
  }
  return shared
}
