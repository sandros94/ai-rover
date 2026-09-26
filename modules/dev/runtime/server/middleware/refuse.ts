import { defineHandler, HTTPError } from 'nitro/h3'
import { databaseRefusal } from '../utils/migrate'

export default defineHandler(async (event) => {
  // The Database tab carries the remedy, so a refused database must not refuse it.
  if (event.url.pathname.startsWith('/__jev/db/')) return
  const refusal = await databaseRefusal()
  if (refusal) throw new HTTPError(refusal, { status: 503 })
})
