import { readValidatedBody } from 'nitro/h3'
import * as v from 'valibot'
import { findOrCreateDevUser } from '../../utils/login'
import { defineDevWriteHandler } from '../../utils/write'

const BodySchema = v.object({ handle: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,32}$/)) })

/**
 * Finds or creates `dev:<handle>` and sets the real session cookie for it, no provider involved.
 * Accepted only from the dev server's own pages (403 otherwise); refuses (403) while the
 * database is not on this machine.
 */
export default defineDevWriteHandler(async (event) => {
  const { handle } = await readValidatedBody(event, BodySchema)
  const user = await findOrCreateDevUser(process.env.NETLIFY_DB_URL, handle)
  await setUserSession(event, {
    user: { id: user.id, displayName: user.displayName, handle: `dev:${handle}`, providers: [] },
  })
  return { id: user.id, handle: `dev:${handle}` }
})
