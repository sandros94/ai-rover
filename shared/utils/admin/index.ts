/** What `POST /api/admin/diagnose` answers: one section per dependency, each failing alone. */
export interface DatabaseDiagnosis {
  ok: boolean
  /** The failing error's class and Postgres code; never its message, which may carry the DSN. */
  error?: string
  /** Names recorded in `netlify.migrations`; empty until the table exists. */
  migrations: string[]
  /** Row counts of the app's tables that exist, by table name. */
  tables: Record<string, number>
}

export interface BlobsDiagnosis {
  ok: boolean
  error?: string
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
  /** Whether an active mission row exists. */
  active: boolean
  /** Error class, Postgres code and message of the failing step, plus the first stack line. */
  error?: { name: string; code?: string; message: string; at?: string }
}

export interface Diagnosis {
  database: DatabaseDiagnosis
  blobs: BlobsDiagnosis
  mission: MissionDiagnosis
  runtime: RuntimeDiagnosis
}
