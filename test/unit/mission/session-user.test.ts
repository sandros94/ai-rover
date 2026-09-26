import { eq } from 'drizzle-orm'
import { H3 } from 'nitro/h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { userAccount, userIdentity } from '#server/database/schema'
import { createUser } from '#server/repositories/users'
import { createMissionAtStop } from '#server/utils/mission/create'
import type { MissionRouteContext } from '#server/utils/mission/http'
import { defineMissionHandlerWith, USER_GONE_MESSAGE } from '#server/utils/mission/http'
import { createUserSessions } from '~~/modules/auth/runtime/server/lib/session'
import { cookieHeader, KEY, ORIGIN, setCookies } from '../auth/helpers'
import { createTestDb, memoryStore, T0 } from './helpers'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

let db: DB
let close: () => Promise<void>
const { store } = memoryStore()
const sessions = createUserSessions({ key: KEY, dev: false })
const platform: MissionRouteContext = { db: () => db, sessions: () => sessions, store: () => store }

beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  await createMissionAtStop(db, { store, seed: 'mars', at: { x: 0, y: 0 }, now: T0 })
})
afterAll(() => close())

const COOKIE = '__Host-jev-session'

/** A mission route for the signed-in user that names who it acted for. */
type Handler = (event: unknown, context: { user: { id: string } }) => Promise<string>

function appWith(handler = vi.fn<Handler>(async (_event, context) => context.user.id)) {
  const app = new H3()
    .post('/login/:id', async (event) => {
      const id = event.context.params!.id!
      await sessions.set(event, { user: { id, displayName: 'Ada', providers: ['github'] } })
      return 'ok'
    })
    .post(
      '/api/write',
      defineMissionHandlerWith(platform, { access: 'write', cache: 'none', user: true }, handler),
    )
    .get(
      '/api/read',
      defineMissionHandlerWith(platform, { access: 'read', cache: 'none', user: true }, handler),
    )
    .post(
      '/api/unresolved',
      defineMissionHandlerWith(platform, { access: 'write', cache: 'none' }, async () => {
        // A write for an account that does not exist, as a deletion racing the request makes.
        await db.insert(userIdentity).values({
          provider: 'github',
          subject: 'gone',
          userId: '0192f000-0000-7000-8000-00000000dead',
        })
        return 'written'
      }),
    )
  return { app, handler }
}

async function signIn(app: H3, id: string): Promise<Response> {
  return app.request(`${ORIGIN}/login/${id}`, { method: 'POST' })
}

describe('mission routes for the signed-in user', () => {
  it('hands the handler the account the session names, read once', async () => {
    const ada = await createUser(db, { displayName: 'Ada' })
    const { app, handler } = appWith()
    const login = await signIn(app, ada.id)
    const answer = await app.request(`${ORIGIN}/api/write`, {
      method: 'POST',
      headers: { cookie: cookieHeader(login) },
    })
    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe(ada.id)
    expect(handler.mock.calls[0]![1].user).toMatchObject({ id: ada.id, displayName: 'Ada' })
  })

  it('answers 401 when signed out, before the handler runs', async () => {
    const { app, handler } = appWith()
    const answer = await app.request(`${ORIGIN}/api/read`)
    expect(answer.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('answers 401 USER_GONE and clears the session when the account was deleted', async () => {
    const gone = await createUser(db, { displayName: 'Gone' })
    const { app, handler } = appWith()
    const login = await signIn(app, gone.id)
    await db.delete(userAccount).where(eq(userAccount.id, gone.id))
    for (const [method, path] of [
      ['POST', '/api/write'],
      ['GET', '/api/read'],
    ] as const) {
      const answer = await app.request(`${ORIGIN}${path}`, {
        method,
        headers: { cookie: cookieHeader(login) },
      })
      expect(answer.status).toBe(401)
      const body = await answer.json()
      expect(body).toMatchObject({ status: 401, message: USER_GONE_MESSAGE, code: 'USER_GONE' })
      const cleared = setCookies(answer)[COOKIE]
      expect(cleared).toBeDefined()
      expect(cleared!.value === '' || cleared!.attributes['max-age'] === '0').toBe(true)
      expect(cookieHeader(login, answer)).toBe('')
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('answers a write that meets a missing user foreign key as USER_GONE, never 500', async () => {
    const ada = await createUser(db, { displayName: 'Ada' })
    const { app } = appWith()
    const login = await signIn(app, ada.id)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const answer = await app.request(`${ORIGIN}/api/unresolved`, {
      method: 'POST',
      headers: { cookie: cookieHeader(login) },
    })
    expect(answer.status).toBe(401)
    expect(await answer.json()).toMatchObject({ message: USER_GONE_MESSAGE, code: 'USER_GONE' })
    expect(cookieHeader(login, answer)).toBe('')
    expect(logged).not.toHaveBeenCalled()
    logged.mockRestore()
  })
})
