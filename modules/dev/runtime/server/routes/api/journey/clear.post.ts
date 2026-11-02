import { clearLocalJourney } from '../../../utils/journey'
import { defineDevWriteHandler } from '../../../utils/write'

/**
 * Deletes every key of the local journey store. Accepted only from the dev server's own pages
 * (403 otherwise); refuses (403) while the database is not on this machine.
 */
export default defineDevWriteHandler(() => clearLocalJourney(process.env.NETLIFY_DB_URL))
