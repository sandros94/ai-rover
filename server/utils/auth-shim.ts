// TODO(dev-only): stands in for the session until the auth wave; replace every caller's
// requireUserId(event) with the signed-in user and delete this file.
import { eq } from 'drizzle-orm'
import type { H3Event } from 'nitro/h3'
import { HTTPError } from 'nitro/h3'
import { userAccount } from '../database/schema'
import { createUser } from '../repositories/users'
import { useDB } from './db'

const HANDLE = /^[a-z0-9-]{1,32}$/

/**
 * The acting user, named by the `x-dev-user` header as a handle and created on first use.
 * Refused outside `nuxt dev`, so no deployed build accepts anonymous submissions or likes.
 */
export async function requireUserId(event: H3Event): Promise<string> {
  if (!import.meta.dev) {
    throw new HTTPError({ status: 401, message: 'Sign in to submit or like.' })
  }
  const handle = event.req.headers.get('x-dev-user')?.trim().toLowerCase()
  if (!handle || !HANDLE.test(handle)) {
    throw new HTTPError({
      status: 401,
      message: 'Name the acting user in the x-dev-user header: 1 to 32 of a-z, 0-9 and "-".',
    })
  }
  const db = useDB()
  const [found] = await db
    .select({ id: userAccount.id })
    .from(userAccount)
    .where(eq(userAccount.handle, `dev:${handle}`))
    .limit(1)
  if (found) return found.id
  return (await createUser(db, { displayName: handle, handle: `dev:${handle}` })).id
}
