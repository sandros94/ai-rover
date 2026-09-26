import { eq } from 'drizzle-orm'
import { defineHandler, readValidatedBody } from 'nitro/h3'
import * as v from 'valibot'
import { userAccount } from '#server/database/schema'
import { createUser } from '#server/repositories/users'
import { useDB } from '#server/utils/db'

const BodySchema = v.object({ handle: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,32}$/)) })

/** Finds or creates `dev:<handle>` and sets the real session cookie for it, no provider involved. */
export default defineHandler(async (event) => {
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
