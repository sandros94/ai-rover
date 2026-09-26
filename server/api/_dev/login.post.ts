// TODO(dev-only): signs a throwaway local user in without a provider, for curl and browser smoke.
import { eq } from 'drizzle-orm'
import { defineHandler, HTTPError, readValidatedBody } from 'nitro/h3'
import * as v from 'valibot'
import { userAccount } from '../../database/schema'
import { createUser } from '../../repositories/users'
import { useDB } from '../../utils/db'

const BodySchema = v.object({ handle: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,32}$/)) })

/** Finds or creates `dev:<handle>` and sets the real session cookie for it; 404 outside `nuxt dev`. */
export default defineHandler(async (event) => {
  if (!import.meta.dev) throw HTTPError.status(404)
  const { handle } = await readValidatedBody(event, BodySchema)
  const db = useDB()
  const [found] = await db
    .select({ id: userAccount.id, displayName: userAccount.displayName })
    .from(userAccount)
    .where(eq(userAccount.handle, `dev:${handle}`))
    .limit(1)
  const user = found ?? (await createUser(db, { displayName: handle, handle: `dev:${handle}` }))
  await setUserSession(event, {
    user: { id: user.id, displayName: user.displayName, handle: `dev:${handle}`, providers: [] },
  })
  return { id: user.id, handle: `dev:${handle}` }
})
