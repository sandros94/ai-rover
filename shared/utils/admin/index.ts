/**
 * What `POST /api/admin/diagnose` answers: one section per dependency, each failing alone. `ms`
 * is how long a section's probe ran, whether it succeeded, failed or timed out.
 */
export interface DatabaseDiagnosis {
  ok: boolean
  /** The failing error's class and Postgres code; never its message, which may carry the DSN. */
  error?: string
  ms: number
  /** Names recorded in `netlify.migrations`; empty until the table exists. */
  migrations: string[]
  /** Row counts of the app's tables that exist, by table name. */
  tables: Record<string, number>
}

/** A session of the database that has held a transaction open for longer than it should. */
export interface StuckSession {
  pid: number
  /** `pg_stat_activity.state`, such as `idle in transaction`. */
  state: string
  /** `Lock` while it waits on a lock; null while it runs or idles. */
  waitEventType: string | null
  /** Age of its open transaction, seconds. */
  ageS: number
  /** Whether it holds an advisory lock, as a tick holds its mission's. */
  holdsAdvisoryLock: boolean
}

/** The sessions of the app's database, from `pg_stat_activity`; never their query text. */
export interface LocksDiagnosis {
  ok: boolean
  error?: string
  ms: number
  /** Sessions by state. */
  states: Record<string, number>
  /** Age of the oldest open transaction, seconds; null when none is open. */
  oldestTransactionS: number | null
  /**
   * Sessions whose transaction has been open over 5 s while they wait on a lock, idle in it, or
   * hold an advisory lock; oldest first.
   */
  stuck: StuckSession[]
}

export interface BlobsDiagnosis {
  ok: boolean
  error?: string
  ms: number
  /** Keys under `missions/` and `terrain/`, at most 1000. */
  keys: number
}

export interface RuntimeDiagnosis {
  node: string
  region?: string
  hasSessionKey: boolean
  hasTypesafeToken: boolean
  originsConfigured: boolean
}

/**
 * The public mission read run end to end (find the active mission, bring it up to date, project
 * it), so an operator sees why `/api/mission` fails. Answered only to the admin token, so the
 * error message may be shown in full.
 */
export interface MissionDiagnosis {
  ok: boolean
  ms: number
  /** Whether an active mission row exists. */
  active: boolean
  /**
   * Why the probe's tick left something due undone: `busy` while another tick held the mission
   * lock, `changed` when the mission moved while the tick prepared.
   */
  skipped?: 'busy' | 'changed'
  /** Error class, Postgres code and message of the failing step, plus the first stack line. */
  error?: { name: string; code?: string; message: string; at?: string }
}

export interface Diagnosis {
  database: DatabaseDiagnosis
  locks: LocksDiagnosis
  blobs: BlobsDiagnosis
  mission: MissionDiagnosis
  runtime: RuntimeDiagnosis
}

/**
 * Where a repair of the stops stands between calls: the position of the next stop to check, and
 * the revealed mask key of every stop checked so far whose stored mask was wrong, so the stops
 * after it are computed from the right one before any stop row points at it.
 */
export interface StopRepairCursor {
  next: number
  /** Stop id → key of its corrected revealed mask. */
  corrected: Record<string, string>
}

/** One stop as `POST /api/admin/repair-stops` found it. */
export interface StopRepairEntry {
  index: number
  stopId: string
  /** World vertices in the mask the stop names. */
  stored: number
  /** World vertices in the mask computed again from the landing. */
  recomputed: number
  /** In the recomputed mask and not in the stored one. */
  missing: number
  /** In the stored mask and not in the recomputed one. */
  extra: number
  /**
   * Whether the stored manifest describes the stop and its pack holds exactly the chunks it
   * lists; null when the manifest names no pack.
   */
  packMatches: boolean | null
  /** The stop names other objects than it should: the right ones are published under `manifestKey`. */
  stale: boolean
  /** The manifest key the stop names once repaired; the one it names when not stale. */
  manifestKey: string
  /** This call pointed the stop at the right objects. */
  applied: boolean
}

/**
 * What `POST /api/admin/repair-stops` answers: the stops checked by this call, in index order,
 * and the cursor to pass to the next call; null once every stop is checked.
 */
export interface StopRepairReport {
  apply: boolean
  /** Stops of the mission. */
  total: number
  stops: StopRepairEntry[]
  cursor: StopRepairCursor | null
}
