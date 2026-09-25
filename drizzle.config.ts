import { defineConfig } from 'drizzle-kit'

/**
 * Netlify applies every file in `out` at deploy, in lexicographic order, before publishing, so
 * migrations are generated here and never edited after they ship.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/database/schema.ts',
  out: './netlify/database/migrations',
})
