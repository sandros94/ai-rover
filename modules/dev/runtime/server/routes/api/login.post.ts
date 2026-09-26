import { defineHandler, HTTPError, readValidatedBody } from 'nitro/h3'
import * as v from 'valibot'
import { findOrCreateDevUser } from '../../utils/login'
import { RemoteDatabaseError } from '../../utils/migrate'

const BodySchema = v.object({ handle: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,32}$/)) })

/**
 * Finds or creates `dev:<handle>` and sets the real session cookie for it, no provider involved.
 * Refuses (403) while the database is not on this machine.
 */
export default defineHandler(async (event) => {
  const { handle } = await readValidatedBody(event, BodySchema)
  let user: Awaited<ReturnType<typeof findOrCreateDevUser>>
  try {
    user = await findOrCreateDevUser(process.env.NETLIFY_DB_URL, handle)
  } catch (error) {
    if (error instanceof RemoteDatabaseError) throw new HTTPError(error.message, { status: 403 })
    throw error
  }
  await setUserSession(event, {
    user: { id: user.id, displayName: user.displayName, handle: `dev:${handle}`, providers: [] },
  })
  return { id: user.id, handle: `dev:${handle}` }
})
