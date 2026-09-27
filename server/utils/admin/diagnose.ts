import { count, getTableName, sql } from 'drizzle-orm'
import { defineHandler } from 'nitro/h3'
import type { DB } from '../../database/db'
import { postgresErrorOf } from '../../database/errors'
import { schema } from '../../database/schema'
import type { JourneyStore } from '../journey/store'
import type {
  BlobsDiagnosis,
  DatabaseDiagnosis,
  Diagnosis,
  RuntimeDiagnosis,
} from '#shared/utils/admin'
import type { AdminContext, AdminSettings } from './access'
import { noStore, PLATFORM, readAdminBody } from './access'

/** Each probe gives up after this long, so a hung dependency still leaves an answer. */
const PROBE_TIMEOUT_MS = 5000
/** Blob prefixes the app writes under. */
const BLOB_PREFIXES = ['missions/', 'terrain/']
/** The blob count stops at this. */
const MAX_BLOB_KEYS = 1000

class ProbeTimeout extends Error {
  override name = 'ProbeTimeout'
}

/** Runs `probe` against the timeout; whatever it collected before failing stays collected. */
async function run(probe: () => Promise<void>): Promise<{ ok: boolean; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout()), PROBE_TIMEOUT_MS)
      }),
    ])
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describe(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Class name, plus the Postgres code when one is along the cause chain. */
function describe(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error
  const postgres = postgresErrorOf(error)
  return postgres ? `${name} (${postgres.code})` : name
}

/** `connect` runs inside the probe: reaching the database can itself fail. */
export async function diagnoseDatabase(connect: () => DB): Promise<DatabaseDiagnosis> {
  const migrations: string[] = []
  const tables: Record<string, number> = {}
  const outcome = await run(async () => {
    const db = connect()
    const rows = async <T>(query: ReturnType<typeof sql>) =>
      ((await db.execute(query)) as { rows: T[] }).rows
    const [tracking] = await rows<{ present: boolean }>(
      sql`select to_regclass('netlify.migrations') is not null as present`,
    )
    if (tracking?.present) {
      const ran = await rows<{ name: string }>(
        sql`select name from netlify.migrations order by name`,
      )
      migrations.push(...ran.map((row) => row.name))
    }
    const present = new Set(
      (
        await rows<{ name: string }>(
          sql`select table_name as name from information_schema.tables
              where table_schema = 'public' and table_type = 'BASE TABLE'`,
        )
      ).map((row) => row.name),
    )
    for (const table of Object.values(schema)) {
      const name = getTableName(table)
      if (!present.has(name)) continue
      const [row] = await db.select({ n: count() }).from(table)
      tables[name] = row?.n ?? 0
    }
  })
  return { ...outcome, migrations, tables }
}

export async function diagnoseBlobs(open: () => JourneyStore): Promise<BlobsDiagnosis> {
  let keys = 0
  const outcome = await run(async () => {
    const store = open()
    for (const prefix of BLOB_PREFIXES) keys += (await store.listKeys(prefix)).length
  })
  return { ...outcome, keys: outcome.ok ? Math.min(keys, MAX_BLOB_KEYS) : 0 }
}

export function diagnoseRuntime(settings: AdminSettings): RuntimeDiagnosis {
  const region = process.env.AWS_REGION
  return {
    node: process.version,
    ...(region && { region }),
    hasSessionKey: settings.sessionKey !== '',
    hasTypesafeToken: settings.typesafeToken !== '',
    originsConfigured: settings.origins.trim() !== '',
  }
}

/**
 * `POST /api/admin/diagnose`: whether the database, blobs and settings this deployment needs are
 * reachable and present. Refuses as {@link readAdminBody} does; past that it always answers 200,
 * each failing section carrying its own error.
 */
export function defineAdminDiagnoseHandlerWith(context: AdminContext) {
  return defineHandler(async (event) => {
    noStore(event)
    await readAdminBody(event, context)
    const [database, blobs] = await Promise.all([
      diagnoseDatabase(context.db),
      diagnoseBlobs(context.store),
    ])
    return { database, blobs, runtime: diagnoseRuntime(context.settings()) } satisfies Diagnosis
  })
}

/** {@link defineAdminDiagnoseHandlerWith} over the platform's configuration, database and blobs. */
export const defineAdminDiagnoseHandler = () => defineAdminDiagnoseHandlerWith(PLATFORM)
