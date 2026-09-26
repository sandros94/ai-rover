import { readdirSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetlifyDB, resetDatabase } from '@netlify/database-dev'
import { useDB } from '#server/utils/db'
import { executorOver } from '~~/modules/dev/runtime/server/utils/executor'
import { MIGRATIONS_DIR } from '../db/helpers'

/**
 * A local database the app's own `useDB()` reaches: `useDB()` resolves `NETLIFY_DB_URL` once per
 * module instance, so a test file starts one database and resets it between tests.
 */
export async function startLocalDatabase(): Promise<{
  url: string
  reset: () => Promise<void>
  stop: () => Promise<void>
}> {
  const server = new NetlifyDB({ logger: () => {} })
  const url = await server.start()
  process.env.NETLIFY_DB_URL = url
  return {
    url,
    reset: () => resetDatabase(executorOver(useDB())),
    async stop() {
      // The pool would otherwise see its sockets destroyed by `stop()` and raise on idle clients.
      await (useDB() as unknown as { $client: { end(): Promise<void> } }).$client.end()
      await server.stop()
      delete process.env.NETLIFY_DB_URL
    },
  }
}

/** A disposable copy of the generated migrations, free to edit or delete. */
export async function copyMigrations(): Promise<{ dir: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'jev-migrations-'))
  const dir = join(root, 'migrations')
  await cp(MIGRATIONS_DIR, dir, { recursive: true })
  return { dir, remove: () => rm(root, { recursive: true, force: true }) }
}

export const INIT = '20260925213758_init'

/** Every generated migration, in the order the applier runs them. */
export const MIGRATIONS = readdirSync(MIGRATIONS_DIR).toSorted()
