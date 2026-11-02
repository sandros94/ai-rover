import { H3 } from 'nitro/h3'
import { encrypt, decrypt } from 'unjwt/jwe'
import { generateJWK } from 'unjwt/jwk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthSessions } from '#server/utils/session'
import { createAuthSessions, signedInUser, signInSession } from '#server/utils/session'
import type { SessionUser } from '#shared/types/session'
import { cookieHeader, KEY, openSession, ORIGIN, setCookies, testSessions } from './helpers'

const COOKIE = '__Host-rover-session'
const DAY_S = 24 * 60 * 60

const USER: SessionUser = {
  id: '0190a000-0000-7000-8000-000000000001',
  displayName: 'Ada',
  avatarUrl: 'https://avatars.test/ada.png',
  handle: 'ada',
  providers: ['github'],
}

/** Routes over `sessions` as the app's own use them. */
function appOver(sessions: AuthSessions) {
  return new H3()
    .post('/login', async (event) => {
      await signInSession(await sessions.use(event), USER)
      return 'ok'
    })
    .post('/login-as/:id', async (event) => {
      await signInSession(await sessions.use(event), { ...USER, id: event.context.params!.id! })
      return 'ok'
    })
    .post('/rename', async (event) => {
      const session = await sessions.require(event)
      await session.update({ user: { ...session.data.user, displayName: 'Ada L.' } })
      return 'ok'
    })
    .get('/me', async (event) => {
      const session = await sessions.use(event)
      return session.id ? session.data : {}
    })
    .get('/private', async (event) => (await sessions.require(event)).data.user.id)
    .delete('/me', async (event) => {
      await (await sessions.use(event)).clear()
      return 'ok'
    })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the session', () => {
  it('round-trips the user through a __Host- cookie sealed as a session token', async () => {
    const app = appOver(testSessions())
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    const cookie = setCookies(login)[COOKIE]!
    expect(cookie.attributes).toMatchObject({
      path: '/',
      httponly: true,
      secure: true,
      samesite: 'Lax',
    })
    expect(cookie.attributes.domain).toBeUndefined()
    const { protectedHeader } = await decrypt(cookie.value, KEY)
    expect(protectedHeader).toMatchObject({ alg: 'dir', enc: 'A256GCM', typ: 'session+jwt' })
    const claims = await openSession(cookie.value)
    expect(claims.user).toEqual(USER)
    expect(typeof claims.loggedInAt).toBe('number')
    expect(claims.exp).toBe(claims.iat + 7 * DAY_S)

    const me = await app.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    expect(await me.json()).toEqual({ user: USER, loggedInAt: claims.loggedInAt })
  })

  it('reads empty without a cookie and refuses a protected route with 401', async () => {
    const app = appOver(testSessions())
    const me = await app.request(`${ORIGIN}/me`)
    expect(await me.json()).toEqual({})
    expect(me.headers.getSetCookie()).toEqual([])
    const refused = await app.request(`${ORIGIN}/private`)
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ message: 'Sign in first.' })
  })

  it('refuses and expires a cookie sealed with another key', async () => {
    const login = await appOver(testSessions()).request(`${ORIGIN}/login`, { method: 'POST' })
    const other = await generateJWK('A256GCM')
    const app = appOver(createAuthSessions({ key: async () => other, dev: false }))
    const me = await app.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    expect(await me.json()).toEqual({})
    expect(setCookies(me)[COOKIE]?.attributes['max-age']).toBe('0')
  })

  it('refuses a token sealed with the key but not as a session, such as an older cookie', async () => {
    const now = Math.floor(Date.now() / 1000)
    const older = await encrypt(
      { sub: USER.id, providers: ['github'], displayName: 'Ada', loggedInAt: Date.now() },
      KEY,
      { alg: 'dir', enc: 'A256GCM', expiresIn: 7 * DAY_S, protectedHeader: { typ: 'JWT' } },
    )
    const untyped = await encrypt({ user: USER, loggedInAt: Date.now(), jti: 'j', iat: now }, KEY, {
      alg: 'dir',
      enc: 'A256GCM',
      expiresIn: 7 * DAY_S,
    })
    const app = appOver(testSessions())
    for (const token of [older, untyped]) {
      const cookie = `${COOKIE}=${encodeURIComponent(token)}`
      const me = await app.request(`${ORIGIN}/me`, { headers: { cookie } })
      expect(await me.json()).toEqual({})
      expect((await app.request(`${ORIGIN}/private`, { headers: { cookie } })).status).toBe(401)
    }
  })

  it('clears the cookie', async () => {
    const app = appOver(testSessions())
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    const cleared = await app.request(`${ORIGIN}/me`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader(login) },
    })
    expect(setCookies(cleared)[COOKIE]?.attributes['max-age']).toBe('0')
    expect(cookieHeader(login, cleared)).toBe('')
    const me = await app.request(`${ORIGIN}/me`, {
      headers: { cookie: cookieHeader(login, cleared) },
    })
    expect(await me.json()).toEqual({})
  })

  it('re-issues a token once 75% of its 7 days have passed, keeping loggedInAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const app = appOver(testSessions())
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    const first = await openSession(setCookies(login)[COOKIE]!.value)

    // 125 hours: just under 75% of 168.
    vi.setSystemTime(new Date('2026-09-06T05:00:00Z'))
    const early = await app.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    expect(setCookies(early)[COOKIE]).toBeUndefined()

    // 127 hours.
    vi.setSystemTime(new Date('2026-09-06T07:00:00Z'))
    const late = await app.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    const refreshed = await openSession(setCookies(late)[COOKIE]!.value)
    expect(refreshed.iat).toBe(first.iat + 127 * 60 * 60)
    expect(refreshed.exp).toBe(refreshed.iat + 7 * DAY_S)
    expect(refreshed.jti).not.toBe(first.jti)
    expect(refreshed.user).toEqual(USER)
    expect(refreshed.loggedInAt).toBe(first.loggedInAt)
  })

  it('reads a token up to 5 s from the future, as another instance with a fast clock issues', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:04Z'))
    const app = appOver(testSessions())
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const me = await app.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    expect(await me.json()).toMatchObject({ user: USER })
  })

  it('keeps loggedInAt for the same user, and resets it when another user signs in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const app = appOver(testSessions())
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    const first = await openSession(setCookies(login)[COOKIE]!.value)

    vi.setSystemTime(new Date('2026-09-01T01:00:00Z'))
    const renamed = await app.request(`${ORIGIN}/rename`, {
      method: 'POST',
      headers: { cookie: cookieHeader(login) },
    })
    const second = await openSession(setCookies(renamed)[COOKIE]!.value)
    expect(second.user.displayName).toBe('Ada L.')
    expect(second.loggedInAt).toBe(first.loggedInAt)

    const again = await app.request(`${ORIGIN}/login`, {
      method: 'POST',
      headers: { cookie: cookieHeader(login, renamed) },
    })
    const third = await openSession(setCookies(again)[COOKIE]!.value)
    expect(third.user).toEqual(USER)
    expect(third.loggedInAt).toBe(first.loggedInAt)

    const switched = await app.request(`${ORIGIN}/login-as/someone-else`, {
      method: 'POST',
      headers: { cookie: cookieHeader(login, renamed, again) },
    })
    const cookies = setCookies(switched)
    expect(Object.keys(cookies)).toEqual([COOKIE])
    const fourth = await openSession(cookies[COOKIE]!.value)
    expect(fourth.user.id).toBe('someone-else')
    expect(fourth.loggedInAt).toBe(Date.parse('2026-09-01T01:00:00Z'))
  })

  it('names the signed-in user only for a session with an id', () => {
    const data = { user: USER, loggedInAt: 0 }
    expect(signedInUser({ id: 'jti', data })).toBe(USER)
    expect(signedInUser({ id: undefined, data })).toBeUndefined()
  })

  it('drops the __Host- prefix and Secure in dev', async () => {
    const app = appOver(createAuthSessions({ key: async () => KEY, dev: true }))
    const login = await app.request('http://localhost:3000/login', { method: 'POST' })
    const cookie = setCookies(login)['rover-session']!
    expect(cookie.attributes.secure).toBeUndefined()
    expect(cookie.attributes.httponly).toBe(true)
    const me = await app.request('http://localhost:3000/me', {
      headers: { cookie: cookieHeader(login) },
    })
    expect(await me.json()).toMatchObject({ user: USER })
  })

  it('asks for the key again after it failed', async () => {
    const key = vi
      .fn<() => Promise<typeof KEY>>()
      .mockRejectedValueOnce(new Error('no secret'))
      .mockResolvedValue(KEY)
    const app = appOver(createAuthSessions({ key, dev: false }))
    expect((await app.request(`${ORIGIN}/me`)).status).toBe(500)
    expect(await (await app.request(`${ORIGIN}/me`)).json()).toEqual({})
    expect(key).toHaveBeenCalledTimes(2)
  })
})
