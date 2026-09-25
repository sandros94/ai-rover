import type { SQLExecutor } from '@netlify/database-dev'
import { applyMigrations, resetDatabase } from '@netlify/database-dev'
import { useDB } from '#server/utils/db'
import { executorOver } from './executor'
import { databaseHost, isLoopback } from './loopback'
import { migrationDigest } from './migrations'

export const RESET_REMEDY =
  'Reset the local database from the Database tab in Nuxt DevTools, or stop the dev server, run `rm -rf .netlify`, start it again, then seed.'

/**
 * This machine's record of what each applied migration read when it ran. No migration creates
 * it and no deploy has it: the platform tracks names only, so an edit to an applied file would
 * otherwise go unnoticed until production disagrees.
 */
const DIGEST_TABLE = `
  CREATE SCHEMA IF NOT EXISTS jev_dev;
  CREATE TABLE IF NOT EXISTS jev_dev.migration_digest (
    name text PRIMARY KEY,
    digest text NOT NULL,
    recorded_at timestamptz DEFAULT now()
  )
`

/** Thrown by a writing surface asked to touch a database that is not on this machine. */
export class RemoteDatabaseError extends Error {
  constructor(url: string | undefined) {
    super(
      `NETLIFY_DB_URL points at ${databaseHost(url)}, not on this machine; the database was left untouched.`,
    )
    this.name = 'RemoteDatabaseError'
  }
}

/** Thrown by a writing surface while the local database refuses requests; carries the reason. */
export class DatabaseRefusedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'DatabaseRefusedError'
  }
}

/** Refuses unless `url` is on this machine. */
export function assertLoopback(url: string | undefined): void {
  if (!isLoopback(url)) throw new RemoteDatabaseError(url)
}

/**
 * Brings the local database up to the migrations in `directory` through the platform's applier:
 * null when it is ready, otherwise why it is refused. Refuses when a migration this database
 * already applied was edited or removed since, because the applier would silently skip it.
 */
export async function migrateLocalDatabase(
  url: string | undefined,
  directory: string,
): Promise<string | null> {
  if (!isLoopback(url)) {
    console.warn(`[database] ${new RemoteDatabaseError(url).message}`)
    return null
  }
  try {
    const executor = executorOver(useDB())
    await executor.exec(DIGEST_TABLE)
    const drift = await findDrift(executor, directory)
    if (drift.length > 0) {
      return `The local database no longer matches its migrations: ${drift.join('; ')}. ${RESET_REMEDY}`
    }
    const applied = await applyMigrations(executor, directory)
    for (const name of applied) {
      await recordDigest(executor, name, (await migrationDigest(directory, name))!)
    }
    if (applied.length > 0) {
      console.log(`[database] applied ${applied.length} migration(s): ${applied.join(', ')}`)
    }
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `The local database could not be brought up to its migrations: ${message}. ${RESET_REMEDY}`
  }
}

let current: Promise<string | null> | undefined

/**
 * Starts {@link migrateLocalDatabase} after whatever run is in flight and keeps its outcome for
 * {@link databaseRefusal}.
 */
export function prepareLocalDatabase(
  url: string | undefined,
  directory: string,
): Promise<string | null> {
  const previous = current ?? Promise.resolve(null)
  current = previous.then(() => migrateLocalDatabase(url, directory))
  return current
}

/** Why the local database refuses requests, or null when it is ready or was never prepared. */
export function databaseRefusal(): Promise<string | null> {
  return current ?? Promise.resolve(null)
}

/**
 * Drops every schema the platform's reset drops (all but the system ones, recreating `public`),
 * then prepares the database again: what `netlify database reset` does, without a restart.
 */
export async function resetLocalDatabase(
  url: string | undefined,
  directory: string,
): Promise<string | null> {
  assertLoopback(url)
  // Waits out a run in flight so the reset does not interleave with it.
  await databaseRefusal()
  await resetDatabase(executorOver(useDB()))
  return prepareLocalDatabase(url, directory)
}

async function findDrift(executor: SQLExecutor, directory: string): Promise<string[]> {
  const tracked = await executor.query<{ tracked: boolean }>(
    `SELECT to_regclass('netlify.migrations') IS NOT NULL AS tracked`,
  )
  if (!tracked.rows[0]?.tracked) return []
  const ran = await executor.query<{ name: string; digest: string | null }>(
    `SELECT m.name, d.digest FROM netlify.migrations m
     LEFT JOIN jev_dev.migration_digest d ON d.name = m.name
     ORDER BY m.name`,
  )
  const drift: string[] = []
  for (const { name, digest } of ran.rows) {
    const now = await migrationDigest(directory, name)
    if (now === null) drift.push(`${name} was removed after this database applied it`)
    else if (digest === null) await recordDigest(executor, name, now)
    else if (digest !== now) drift.push(`${name} was edited after this database applied it`)
  }
  return drift
}

async function recordDigest(executor: SQLExecutor, name: string, digest: string): Promise<void> {
  await executor.query(
    `INSERT INTO jev_dev.migration_digest (name, digest) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET digest = excluded.digest, recorded_at = now()`,
    [name, digest],
  )
}
