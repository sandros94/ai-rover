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
  LocksDiagnosis,
  MissionDiagnosis,
  RuntimeDiagnosis,
  StuckSession,
} from '#shared/utils/admin'
import { getActiveMission } from '../../repositories/missions'
import { useJevClient } from '../jev'
import { isMissionDue } from '../mission/background'
import { publicMissionState } from '../mission/state'
import { tickMission } from '../mission/tick'
import type { AdminContext, AdminSettings } from './access'
import { noStore, PLATFORM, readAdminBody } from './access'

/**
 * Each probe gives up after this long, so a hung dependency still leaves an answer. The probes
 * run side by side, so the answer comes within the longest, under the function's 60 s limit.
 */
const PROBE_TIMEOUT_MS = 20_000
/** The mission probe runs a whole tick, which a public read leaves to the background function. */
const MISSION_PROBE_TIMEOUT_MS = 50_000
/** A transaction open longer than this while waiting, idle or holding an advisory lock is stuck. */
const STUCK_AFTER_S = 5
/** Blob prefixes the app writes under. */
const BLOB_PREFIXES = ['missions/', 'terrain/']
/** The blob count stops at this. */
const MAX_BLOB_KEYS = 1000

class ProbeTimeout extends Error {
  override name = 'ProbeTimeout'
}

/**
 * Runs `probe` against the timeout, timing it; whatever it collected before failing stays
 * collected.
 */
async function run(
  probe: () => Promise<void>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; ms: number; error?: string; detail?: MissionDiagnosis['error'] }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs)
      }),
    ])
    return { ok: true, ms: ms() }
  } catch (error) {
    return { ok: false, ms: ms(), error: describe(error), detail: detailOf(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** The rows of `query`, as both platform drivers answer them. */
async function rowsOf<T>(db: DB, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as { rows: T[] }).rows
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
  let skipped: MissionDiagnosis['skipped']
  const result = await run(async () => {
    const db = connect()
    const mission = await getActiveMission(db)
    if (!mission) return
    active = true
    const now = new Date()
    // Awaited, unlike a public read's, so a failing tick is reported here with its step.
    if (isMissionDue(mission, now)) {
      const tick = await tickMission(db, {
        missionId: mission.id,
        store: open(),
        jev: useJevClient(),
        now,
        lock: 'try',
      })
      skipped = tick.skipped
    }
    await publicMissionState(db, { missionId: mission.id, now })
  }, MISSION_PROBE_TIMEOUT_MS)
  const { ok, ms } = result
  if (ok) return { ok, ms, active, ...(skipped && { skipped }) }
  return {
    ok,
    ms,
    active,
    ...(skipped && { skipped }),
    error: result.detail ?? { name: result.error ?? 'Error', message: '' },
  }
}

/** `connect` runs inside the probe: reaching the database can itself fail. */
export async function diagnoseDatabase(connect: () => DB): Promise<DatabaseDiagnosis> {
  const migrations: string[] = []
  const tables: Record<string, number> = {}
  const outcome = await run(async () => {
    const db = connect()
    const rows = <T>(query: ReturnType<typeof sql>) => rowsOf<T>(db, query)
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
  const { ok, ms, error } = outcome
  return { ok, ...(error && { error }), ms, migrations, tables }
}

/**
 * The sessions of the app's database: how many are in each state, the oldest open transaction,
 * and the {@link StuckSession}s. A tick killed while holding its mission lock leaves its session
 * idle in transaction until the database drops it, and every tick after it waits; this is where
 * that shows. Query text is never read: it can quote data.
 */
export async function diagnoseLocks(connect: () => DB): Promise<LocksDiagnosis> {
  const states: Record<string, number> = {}
  let oldestTransactionS: number | null = null
  const stuck: StuckSession[] = []
  const outcome = await run(async () => {
    const sessions = await rowsOf<Omit<StuckSession, 'ageS'> & { ageS: number | null }>(
      connect(),
      sql`select a.pid, a.state, a.wait_event_type as "waitEventType",
            extract(epoch from clock_timestamp() - a.xact_start)::float8 as "ageS",
            exists (
              select 1 from pg_locks l
              where l.pid = a.pid and l.locktype = 'advisory' and l.granted
            ) as "holdsAdvisoryLock"
          from pg_stat_activity a
          where a.datname = current_database() and a.state is not null`,
    )
    for (const session of sessions) {
      states[session.state] = (states[session.state] ?? 0) + 1
      const { ageS } = session
      if (ageS === null) continue
      oldestTransactionS = Math.max(oldestTransactionS ?? 0, ageS)
      const waiting = session.waitEventType === 'Lock'
      const idle = session.state.startsWith('idle in transaction')
      if (ageS > STUCK_AFTER_S && (waiting || idle || session.holdsAdvisoryLock)) {
        stuck.push({ ...session, ageS })
      }
    }
    stuck.sort((a, b) => b.ageS - a.ageS)
  })
  const { ok, ms, error } = outcome
  return { ok, ...(error && { error }), ms, states, oldestTransactionS, stuck }
}

export async function diagnoseBlobs(open: () => JourneyStore): Promise<BlobsDiagnosis> {
  let keys = 0
  const outcome = await run(async () => {
    const store = open()
    for (const prefix of BLOB_PREFIXES) keys += (await store.listKeys(prefix)).length
  })
  const { ok, ms, error } = outcome
  return { ok, ...(error && { error }), ms, keys: ok ? Math.min(keys, MAX_BLOB_KEYS) : 0 }
}

export function diagnoseRuntime(settings: AdminSettings): RuntimeDiagnosis {
  const region = process.env.AWS_REGION
  return {
    node: process.version,
    ...(region && { region }),
    hasSessionKey: settings.sessionKey !== '',
    hasTypesafeToken:
      settings.typesafeToken !== '' ||
      Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_BASE_URL),
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
    const [database, locks, blobs, mission] = await Promise.all([
      diagnoseDatabase(context.db),
      diagnoseLocks(context.db),
      diagnoseBlobs(context.store),
      diagnoseMission(context.db, context.store),
    ])
    return {
      database,
      locks,
      blobs,
      mission,
      runtime: diagnoseRuntime(context.settings()),
    } satisfies Diagnosis
  })
}

/** {@link defineAdminDiagnoseHandlerWith} over the platform's configuration, database and blobs. */
export const defineAdminDiagnoseHandler = () => defineAdminDiagnoseHandlerWith(PLATFORM)
