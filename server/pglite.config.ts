import { fileURLToPath } from 'node:url'
import { definePGliteConfig } from 'nuxt-pglite/core'
import { applyMigrations } from 'nuxt-pglite/migrations'

const migrations = fileURLToPath(new URL('../netlify/database/migrations', import.meta.url))

/**
 * The local PGlite database: every generated migration applied on creation, recorded in
 * `netlify.migrations` as Netlify Database records the ones it applies at deploy.
 */
export default definePGliteConfig({
  init: (pg) => applyMigrations(pg, migrations),
})
