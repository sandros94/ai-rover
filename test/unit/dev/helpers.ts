import { sql } from 'drizzle-orm'
import { createTestDatabase } from 'nuxt-pglite/testing'
import { useDB } from '#server/utils/db'
import { PGLITE_CONFIG } from '../db/helpers'

/**
 * A local database built from the app's PGlite config (every generated migration applied),
 * served over the wire protocol, that the app's own `useDB()` reaches: `useDB()` resolves
 * `NETLIFY_DB_URL` once per module instance, so a test file starts one database and resets it
 * between tests by emptying every table of the `public` schema.
 */
export async function startLocalDatabase(): Promise<{
  url: string
  reset: () => Promise<void>
  stop: () => Promise<void>
}> {
  const test = await createTestDatabase({ config: PGLITE_CONFIG, socket: true, exportEnv: false })
  // Served over the socket, so it has a URL.
  const url = test.url!
  process.env.NETLIFY_DB_URL = url
  return {
    url,
    async reset() {
      const tables = await useDB().execute<{ name: string }>(
        sql`select tablename as name from pg_tables where schemaname = 'public'`,
        'objects',
      )
      if (tables.length === 0) return
      const names = sql.join(
        tables.map(({ name }) => sql`${sql.identifier('public')}.${sql.identifier(name)}`),
        sql`, `,
      )
      await useDB().execute(sql`truncate ${names} restart identity cascade`)
    },
    async stop() {
      // The pool would otherwise see its sockets closed by `close()` and raise on idle clients.
      await (useDB() as unknown as { $client: { end(): Promise<void> } }).$client.end()
      await test.close()
      delete process.env.NETLIFY_DB_URL
    },
  }
}
