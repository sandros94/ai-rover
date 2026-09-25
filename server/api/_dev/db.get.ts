// TODO(dev-only): probes the emulated platform database through the app's own connection.
import { sql } from 'drizzle-orm'
import { defineHandler, HTTPError } from 'nitro/h3'
import { useDb } from '../../utils/db'

interface Row {
  version?: string
  table_name?: string
}

export default defineHandler(async () => {
  if (!import.meta.dev) throw HTTPError.status(404)
  const db = useDb()
  const version = (await db.execute(sql`select version() as version`)) as { rows: Row[] }
  const tables = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
  )) as { rows: Row[] }
  return { version: version.rows[0]?.version, tables: tables.rows.map((r) => r.table_name) }
})
