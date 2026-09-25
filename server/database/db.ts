import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { relations } from './schema'

/**
 * Any Drizzle Postgres database over this schema: the platform's in production, PGlite in tests.
 * A transaction is one too, so repository calls compose inside `db.transaction`.
 */
export type DB = PgAsyncDatabase<PgQueryResultHKT, typeof relations>
