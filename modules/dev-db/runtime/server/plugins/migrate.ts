import directory from '#dev-migrations'
import { definePlugin } from 'nitro'
import { prepareLocalDatabase } from '../utils/migrate'

// Not awaited: the server starts at once and the refusal middleware holds requests until the
// migrations have run.
export default definePlugin(() => {
  void prepareLocalDatabase(process.env.NETLIFY_DB_URL, directory).then((refusal) => {
    if (refusal) console.error(`[database] ${refusal}`)
  })
})
