import type { SQLExecutor } from '@netlify/database-dev'
import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { DB } from '#server/database/db'

/**
 * The platform's migration applier running over a Drizzle database, so it writes through the
 * same connection the app reads from.
 */
export function executorOver(db: DB): SQLExecutor {
  return {
    // One call per file: the applier hands over whole multi-statement migrations, which only the
    // simple query protocol (a query without parameters) accepts.
    exec: (text) => db.execute(sql.raw(text)),
    async query<T>(text: string, params: unknown[] = []) {
      const result = (await db.execute(rebindPlaceholders(text, params))) as { rows: T[] }
      return { rows: result.rows }
    },
    transaction: (run) => db.transaction((tx) => run(executorOver(tx))),
  }
}

/**
 * `text` with each `$n` turned into a Drizzle parameter carrying `params[n - 1]`: the applier
 * numbers its own placeholders and Drizzle renumbers every parameter it binds. Only for the
 * applier's queries, which carry no `$n` inside string literals or dollar-quoted bodies.
 */
export function rebindPlaceholders(text: string, params: readonly unknown[]): SQL {
  const parts = text.split(/\$(\d+)/)
  const chunks: SQL[] = []
  for (let k = 0; k < parts.length; k++) {
    if (k % 2 === 0) {
      chunks.push(sql.raw(parts[k]!))
      continue
    }
    const n = Number(parts[k])
    if (n < 1 || n > params.length) {
      throw new RangeError(
        `rebindPlaceholders: $${n} has no value; the query was given ${params.length} parameter(s).`,
      )
    }
    chunks.push(sql`${sql.param(params[n - 1])}`)
  }
  return sql.join(chunks)
}
