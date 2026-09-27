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
  MissionDiagnosis,
  RuntimeDiagnosis,
} from '#shared/utils/admin'
import { getActiveMission } from '../../repositories/missions'
import { useJevClient } from '../jev'
import { syncMission } from '../mission/http'
import { publicMissionState } from '../mission/state'
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
async function run(
  probe: () => Promise<void>,
): Promise<{ ok: boolean; error?: string; detail?: MissionDiagnosis['error'] }> {
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
    return { ok: false, error: describe(error), detail: detailOf(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Everything an operator needs to name the failing step; only ever sent behind the admin token. */
function detailOf(error: unknown): MissionDiagnosis['error'] {
  const name = error instanceof Error ? error.constructor.name : typeof error
  const postgres = postgresErrorOf(error)
  /*
   * A Postgres failure is named by its SQLSTATE alone: its text quotes the statement and can
   * quote the connection string. Other failures (a driver, a missing feature, a type error) have
   * no code, so their text is the only lead, redacted.
   */
  const message = postgres
    ? ''
    : redact(
        error instanceof Error
          ? [error.message, ...causes(error).map((c) => c.message)].filter(Boolean).join(' <- ')
          : String(error),
      )
  const at = error instanceof Error ? error.stack?.split('\n')[1]?.trim() : undefined
  return { name, ...(postgres && { code: postgres.code }), message, ...(at && { at }) }
}

/** Connection strings, credentials and host names never leave the server, even for operators. */
function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/password[^,;.)\n]*/gi, 'password <redacted>')
    .replace(
      /\b(?:[a-z0-9-]+\.)+(?:internal|local|neon\.tech|netlify\.app|amazonaws\.com)(?::\d+)?/gi,
      '<host>',
    )
}

function causes(error: Error): Error[] {
  const out: Error[] = []
  let cause: unknown = error.cause
  while (cause instanceof Error && out.length < 5) {
    out.push(cause)
    cause = cause.cause
  }
  return out
}

/** Class name, plus the Postgres code when one is along the cause chain. */
function describe(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error
  const postgres = postgresErrorOf(error)
  return postgres ? `${name} (${postgres.code})` : name
}

/**
 * Runs what `GET /api/mission` runs, step by step, and reports the failing step with its full
 * error: the route itself answers only a generic 500 to the public.
 */
export async function diagnoseMission(
  connect: () => DB,
  open: () => JourneyStore,
): Promise<MissionDiagnosis> {
  let active = false
  const result = await run(async () => {
    const db = connect()
    const mission = await getActiveMission(db)
    if (!mission) return
    active = true
    const now = new Date()
    await syncMission(db, {
      mission,
      access: 'read',
      store: open(),
      jev: useJevClient(),
      now,
    })
    await publicMissionState(db, { missionId: mission.id, now })
  })
  if (result.ok) return { ok: true, active }
  return {
    ok: false,
    active,
    error: result.detail ?? { name: result.error ?? 'Error', message: '' },
  }
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
  return { ok: outcome.ok, ...(outcome.error && { error: outcome.error }), migrations, tables }
}

export async function diagnoseBlobs(open: () => JourneyStore): Promise<BlobsDiagnosis> {
  let keys = 0
  const outcome = await run(async () => {
    const store = open()
    for (const prefix of BLOB_PREFIXES) keys += (await store.listKeys(prefix)).length
  })
  return {
    ok: outcome.ok,
    ...(outcome.error && { error: outcome.error }),
    keys: outcome.ok ? Math.min(keys, MAX_BLOB_KEYS) : 0,
  }
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
    const mission = await diagnoseMission(context.db, context.store)
    return {
      database,
      blobs,
      mission,
      runtime: diagnoseRuntime(context.settings()),
    } satisfies Diagnosis
  })
}

/** {@link defineAdminDiagnoseHandlerWith} over the platform's configuration, database and blobs. */
export const defineAdminDiagnoseHandler = () => defineAdminDiagnoseHandlerWith(PLATFORM)
