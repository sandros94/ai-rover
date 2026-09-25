import { sql } from 'drizzle-orm'
import { useDB } from '#server/utils/db'
import type { JourneyStore } from '#server/utils/journey/store'
import { createJourneyStore, JOURNEY_STORE_NAME } from '#server/utils/journey/store'
import { databaseHost, isLoopback } from './loopback'
import { databaseRefusal } from './migrate'
import { listMigrations, migrationDigest } from './migrations'

export interface AppliedMigration {
  name: string
  /** When this machine recorded the digest, ISO 8601; null before it has one. */
  recordedAt: string | null
  digest: string | null
  /** The file's digest as it reads now; null once the file is gone. */
  fileDigest: string | null
  drifted: boolean
}

export interface DatabaseStatus {
  /** Host and port only. */
  url: string
  loopback: boolean
  /** Not refused and nothing pending. */
  ready: boolean
  refusal: string | null
  applied: AppliedMigration[]
  pending: string[]
  /** Rows per table of the `public` schema. */
  counts: Record<string, number>
  blobs: { store: string; keys: number }
}

/** What the Database tab shows. Reads nothing from a database that is not on this machine. */
export async function databaseStatus(
  url: string | undefined,
  directory: string,
  store: JourneyStore = createJourneyStore(),
): Promise<DatabaseStatus> {
  const refusal = await databaseRefusal()
  const blobs = { store: JOURNEY_STORE_NAME, keys: (await store.listKeys()).length }
  const base = { url: databaseHost(url), loopback: isLoopback(url), refusal, blobs }
  if (!base.loopback) return { ...base, ready: false, applied: [], pending: [], counts: {} }

  const db = useDB()
  const [tracking] = await rows<{ migrations: boolean; digests: boolean }>(
    sql`select to_regclass('netlify.migrations') is not null as migrations,
               to_regclass('jev_dev.migration_digest') is not null as digests`,
  )
  const ran = tracking?.migrations
    ? await rows<{ name: string; digest: string | null; recorded_ms: number | null }>(
        tracking.digests
          ? sql`select m.name, d.digest, extract(epoch from d.recorded_at) * 1000 as recorded_ms
                from netlify.migrations m left join jev_dev.migration_digest d on d.name = m.name
                order by m.name`
          : sql`select name, null as digest, null as recorded_ms from netlify.migrations order by name`,
      )
    : []
  const applied: AppliedMigration[] = []
  for (const row of ran) {
    const fileDigest = await migrationDigest(directory, row.name)
    applied.push({
      name: row.name,
      recordedAt: row.recorded_ms === null ? null : new Date(Number(row.recorded_ms)).toISOString(),
      digest: row.digest,
      fileDigest,
      drifted: fileDigest === null || (row.digest !== null && row.digest !== fileDigest),
    })
  }
  const done = new Set(applied.map((m) => m.name))
  const pending = (await listMigrations(directory)).filter((name) => !done.has(name))

  const counts: Record<string, number> = {}
  const tables = await rows<{ name: string }>(
    sql`select table_name as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  )
  for (const { name } of tables) {
    const [row] = await rows<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier('public')}.${sql.identifier(name)}`,
    )
    counts[name] = row?.n ?? 0
  }

  return { ...base, ready: refusal === null && pending.length === 0, applied, pending, counts }

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return ((await db.execute(query)) as { rows: T[] }).rows
  }
}
