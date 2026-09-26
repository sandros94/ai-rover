import { H3 } from 'nitro/h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserSessions } from '~~/modules/auth/runtime/server/lib/session'
import {
  createUserSessions,
  SESSION_MAX_AGE_SECONDS,
} from '~~/modules/auth/runtime/server/lib/session'
import { createSessionRoutes } from '~~/modules/auth/runtime/server/lib/routes'
import { sessionKey } from '~~/modules/auth/runtime/server/lib/key'
import { cookieHeader, KEY, openCookie, ORIGIN, setCookies } from './helpers'

const USER = {
  id: '0190a000-0000-7000-8000-000000000001',
  displayName: 'Ada',
  avatarUrl: 'https://avatars.test/ada.png',
  handle: 'ada',
  providers: ['github' as const],
}

function appOver(sessions: UserSessions) {
  const routes = createSessionRoutes(sessions)
  return new H3()
    .post('/login', async (event) => {
      await sessions.set(event, { user: USER })
      return 'ok'
    })
    .get('/me', (event) => sessions.get(event))
    .get('/private', async (event) => (await sessions.require(event)).user.id)
    .get('/api/_auth/session', routes.get)
    .delete('/api/_auth/session', routes.clear)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('user session', () => {
  it('round-trips through the real cookie with small flat claims', async () => {
    const app = appOver(createUserSessions({ key: KEY, dev: false }))
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    const cookie = setCookies(login)['__Host-jev-session']!
    expect(cookie.attributes).toMatchObject({
      path: '/',
      httponly: true,
      secure: true,
      samesite: 'Lax',
    })
    const claims = await openCookie(cookie.value)
    expect(claims).toMatchObject({
      sub: USER.id,
      providers: ['github'],
      displayName: 'Ada',
      avatarUrl: USER.avatarUrl,
      handle: 'ada',
    })
    expect(typeof claims.loggedInAt).toBe('number')
    expect(claims.exp).toBe((claims.iat as number) + SESSION_MAX_AGE_SECONDS)

    const me = await app.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    expect(await me.json()).toEqual({ user: USER, loggedInAt: claims.loggedInAt })
  })

  it('reads empty without a cookie and refuses a protected route with 401', async () => {
    const app = appOver(createUserSessions({ key: KEY, dev: false }))
    expect(await (await app.request(`${ORIGIN}/me`)).json()).toEqual({})
    expect((await app.request(`${ORIGIN}/private`)).status).toBe(401)
  })

  it('ignores a cookie sealed with another key', async () => {
    const other = appOver(createUserSessions({ key: KEY, dev: false }))
    const login = await other.request(`${ORIGIN}/login`, { method: 'POST' })
    const { generateJWK } = await import('unjwt/jwk')
    const app = appOver(
      createUserSessions({ key: JSON.stringify(await generateJWK('A256GCM')), dev: false }),
    )
    const me = await app.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    expect(await me.json()).toEqual({})
  })

  it('clears the cookie', async () => {
    const app = appOver(createUserSessions({ key: KEY, dev: false }))
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    const cleared = await app.request(`${ORIGIN}/api/_auth/session`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader(login) },
    })
    expect(cleared.status).toBe(200)
    const me = await app.request(`${ORIGIN}/api/_auth/session`, {
      headers: { cookie: cookieHeader(login, cleared) },
    })
    expect(await me.json()).toEqual({})
  })

  it('reflects the cookie at GET /api/_auth/session', async () => {
    const app = appOver(createUserSessions({ key: KEY, dev: false }))
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    const res = await app.request(`${ORIGIN}/api/_auth/session`, {
      headers: { cookie: cookieHeader(login) },
    })
    expect((await res.json()).user).toEqual(USER)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('slides past 75% of maxAge and keeps loggedInAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const app = appOver(createUserSessions({ key: KEY, dev: false }))
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    const first = await openCookie(setCookies(login)['__Host-jev-session']!.value)

    vi.setSystemTime(new Date('2026-09-02T00:00:00Z'))
    const early = await app.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    expect(setCookies(early)['__Host-jev-session']).toBeUndefined()

    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'))
    const late = await app.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    const refreshed = await openCookie(setCookies(late)['__Host-jev-session']!.value)
    expect(refreshed.iat).toBeGreaterThan(first.iat as number)
    expect(refreshed.jti).not.toBe(first.jti)
    expect(refreshed.loggedInAt).toBe(first.loggedInAt)
  })

  it('keeps loggedInAt when the same user updates the session, resets it for another', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const sessions = createUserSessions({ key: KEY, dev: false })
    const app = appOver(sessions)
      .post('/rename', async (event) => {
        await sessions.set(event, { user: { ...USER, displayName: 'Ada L.' } })
        return 'ok'
      })
      .post('/switch', async (event) => {
        await sessions.replace(event, { user: { ...USER, id: 'someone-else' } })
        return 'ok'
      })
    const login = await app.request(`${ORIGIN}/login`, { method: 'POST' })
    const first = await openCookie(setCookies(login)['__Host-jev-session']!.value)

    vi.setSystemTime(new Date('2026-09-01T01:00:00Z'))
    const renamed = await app.request(`${ORIGIN}/rename`, {
      method: 'POST',
      headers: { cookie: cookieHeader(login) },
    })
    const second = await openCookie(setCookies(renamed)['__Host-jev-session']!.value)
    expect(second).toMatchObject({ displayName: 'Ada L.', loggedInAt: first.loggedInAt })

    const switched = await app.request(`${ORIGIN}/switch`, {
      method: 'POST',
      headers: { cookie: cookieHeader(login, renamed) },
    })
    const third = await openCookie(setCookies(switched)['__Host-jev-session']!.value)
    expect(third.sub).toBe('someone-else')
    expect(third.loggedInAt).toBeGreaterThan(first.loggedInAt as number)
  })
})

describe('session key', () => {
  it('refuses to define the session without a key outside dev', () => {
    expect(() => createUserSessions({ key: '', dev: false })).toThrow(/NUXT_SESSION_KEY/)
  })

  it('refuses a key that is not a 256-bit oct JWK', () => {
    expect(() =>
      createUserSessions({ key: JSON.stringify({ kty: 'oct', k: 'c2hvcnQ' }), dev: false }),
    ).toThrow(/NUXT_SESSION_KEY/)
    expect(() => createUserSessions({ key: '{"kty":"oct","k":', dev: false })).toThrow(/JWK/)
  })

  it('uses a JWK as given', async () => {
    const jwk = JSON.parse(KEY)
    expect(await sessionKey(KEY, false)()).toEqual({ kty: 'oct', k: jwk.k, alg: 'A256GCM' })
  })

  it('derives a stable 256-bit key from a secret of at least 32 characters', async () => {
    const secret = 'x7Qp2mVr9LkT4nWc8ZsB3hJd6FgY1aEu5RoK'.padEnd(40, 'q')
    const first = sessionKey(secret, false)
    const a = await first()
    expect(a).toMatchObject({ kty: 'oct', alg: 'A256GCM' })
    expect(a.k).toMatch(/^[\w-]{43}$/)
    expect(await first()).toBe(a)
    expect(await sessionKey(secret, false)()).toEqual(a)
    const other = await sessionKey(`${secret.slice(0, -1)}r`, false)()
    expect(other.k).not.toBe(a.k)
  })

  it('seals and opens sessions with a derived key across restarts', async () => {
    const secret = 'Tg4hW9qLz2Nc7Vb1Xm5Rk8Pd3Js6Fy0Ae'
    const a = appOver(createUserSessions({ key: secret, dev: false }))
    const b = appOver(createUserSessions({ key: secret, dev: false }))
    const login = await a.request(`${ORIGIN}/login`, { method: 'POST' })
    const me = await b.request(`${ORIGIN}/me`, { headers: { cookie: cookieHeader(login) } })
    expect((await me.json()).user).toEqual(USER)
  })

  it('refuses a secret shorter than 32 characters, naming both accepted forms', () => {
    for (const key of ['hunter2', 'a'.repeat(20), 'b'.repeat(31)]) {
      expect(() => createUserSessions({ key, dev: false })).toThrow(
        /NUXT_SESSION_KEY.*JWK.*at least 32 characters/,
      )
    }
    expect(() =>
      createUserSessions({ key: 'jev-rover development session key', dev: false }),
    ).toThrow(/public development seed/)
  })

  it('derives a stable dev key, warns once, and drops the __Host- prefix and Secure in dev', async () => {
    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fresh = await import('~~/modules/auth/runtime/server/lib/session')
    const a = appOver(fresh.createUserSessions({ key: '', dev: true }))
    const b = appOver(fresh.createUserSessions({ key: '', dev: true }))
    const login = await a.request('http://localhost:3000/login', { method: 'POST' })
    const cookie = setCookies(login)['jev-session']!
    expect(cookie.attributes.secure).toBeUndefined()
    expect(cookie.attributes.httponly).toBe(true)
    const me = await b.request('http://localhost:3000/me', {
      headers: { cookie: cookieHeader(login) },
    })
    expect((await me.json()).user).toEqual(USER)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/NUXT_SESSION_KEY/)
  })
})
