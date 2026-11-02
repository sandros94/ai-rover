import { defineConfig } from 'drizzle-kit'

/**
 * Netlify applies every file in `out` at deploy, in lexicographic order, before publishing, so
 * migrations are generated here and never edited after they ship.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/database/schema.ts',
  out: './netlify/database/migrations',
  /** The development socket (`pglite.socket` in `nuxt.config.ts`), while `nuxt dev` runs. */
  dbCredentials: { url: 'postgres://postgres@127.0.0.1:5456/postgres' },
})
