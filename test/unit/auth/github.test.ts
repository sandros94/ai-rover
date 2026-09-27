import { H3 } from 'nitro/h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { createUser, findUserByIdentity, linkIdentity } from '#server/repositories/users'
import { completeSignIn } from '#server/utils/sign-in'
import type { AuthContext } from '~~/modules/auth/runtime/server/lib/context'
import { createGitHubHandler } from '~~/modules/auth/runtime/server/lib/github'
import { createTestDb } from '../db/helpers'
import type { Route } from './helpers'
import { cookieHeader, json, mockFetch, openCookie, ORIGIN, setCookies, testAuth } from './helpers'

const CONFIG = { clientId: 'Iv1.test', clientSecret: 'shh' }

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())
afterEach(() => vi.useRealTimers())

function github(user: Record<string, unknown>, onToken?: Route) {
  return mockFetch({
    'POST https://github.com/login/oauth/access_token': (request) =>
      onToken?.(request) ?? json({ access_token: 'gho_secret', token_type: 'bearer', scope: '' }),
    'GET https://api.github.com/user': (request) =>
      request.headers.get('authorization') === 'Bearer gho_secret'
        ? json(user)
        : json({ message: 'Bad credentials' }, { status: 401 }),
  })
}

function appOver(auth: AuthContext) {
  return new H3()
    .get(
      '/api/auth/github',
      createGitHubHandler(auth, CONFIG, {
        onSuccess: (event, result) =>
          completeSignIn(event, { db, sessions: auth.sessions }, result),
      }),
    )
    .post('/test/login-as/:id', async (event) => {
      const id = event.context.params!.id!
      await auth.sessions.set(event, {
        user: { id, displayName: 'Existing', providers: ['atproto'] },
      })
      return 'ok'
    })
}

/** Starts a flow and returns the authorize URL and the flow cookie response. */
async function start(app: H3, query = '', cookie = '') {
  const res = await app.request(`${ORIGIN}/api/auth/github${query}`, { headers: { cookie } })
  expect(res.status).toBe(302)
  return { res, location: new URL(res.headers.get('location')!) }
}

describe('GitHub sign-in', () => {
  it('redirects to the authorize URL and seals the state in a short-lived cookie', async () => {
    const app = appOver(testAuth(github({}).fetch))
    const { res, location } = await start(app)
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: 'Iv1.test',
      redirect_uri: `${ORIGIN}/api/auth/github`,
      state: expect.stringMatching(/^[\w-]{32,}$/),
      scope: '',
      allow_signup: 'true',
    })
    const flow = setCookies(res)['__Host-rover-oauth']!
    expect(flow.attributes).toMatchObject({ httponly: true, secure: true, samesite: 'Lax' })
    expect(Number(flow.attributes['max-age'])).toBe(600)
    const sealed = await openCookie(flow.value)
    expect(sealed).toMatchObject({ provider: 'github', state: location.searchParams.get('state') })
  })

  it('refuses an origin outside NUXT_OAUTH_ORIGINS', async () => {
    const app = appOver(testAuth(github({}).fetch, 'https://elsewhere.test'))
    const res = await app.request(`${ORIGIN}/api/auth/github`)
    expect(res.status).toBe(403)
  })

  it('answers 404 while no client id is configured', async () => {
    const auth = testAuth(github({}).fetch)
    const app = new H3().get(
      '/api/auth/github',
      createGitHubHandler(auth, { clientId: '', clientSecret: '' }, { onSuccess: () => 'no' }),
    )
    expect((await app.request(`${ORIGIN}/api/auth/github`)).status).toBe(404)
  })

  it('refuses a callback whose state does not match the sealed one', async () => {
    const mock = github({ id: 1, login: 'x' })
    const app = appOver(testAuth(mock.fetch))
    const { res } = await start(app)
    const callback = await app.request(`${ORIGIN}/api/auth/github?code=abc&state=forged`, {
      headers: { cookie: cookieHeader(res) },
    })
    expect(callback.status).toBe(400)
    expect(mock.calls).toHaveLength(0)
  })

  it('refuses a callback once the flow cookie is older than 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const mock = github({ id: 1, login: 'x' })
    const app = appOver(testAuth(mock.fetch))
    const { res, location } = await start(app)
    vi.setSystemTime(new Date('2026-09-01T00:10:01Z'))
    const callback = await app.request(
      `${ORIGIN}/api/auth/github?code=abc&state=${location.searchParams.get('state')}`,
      { headers: { cookie: cookieHeader(res) } },
    )
    expect(callback.status).toBe(400)
    expect(mock.calls).toHaveLength(0)
  })

  it('refuses a callback without the flow cookie', async () => {
    const app = appOver(testAuth(github({ id: 1, login: 'x' }).fetch))
    const callback = await app.request(`${ORIGIN}/api/auth/github?code=abc&state=any`)
    expect(callback.status).toBe(400)
  })

  it('creates the user and identity, sets the session, and discards the token', async () => {
    const mock = github({
      id: 9001,
      login: 'octo',
      name: null,
      avatar_url: 'https://gh.test/o.png',
    })
    const app = appOver(testAuth(mock.fetch))
    const { res, location } = await start(app, '?redirect=/missions/1')
    const state = location.searchParams.get('state')!
    const callback = await app.request(`${ORIGIN}/api/auth/github?code=abc&state=${state}`, {
      headers: { cookie: cookieHeader(res) },
    })
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/missions/1')

    const tokenRequest = mock.calls[0]!
    expect(tokenRequest.headers.get('accept')).toBe('application/json')
    expect(Object.fromEntries(new URLSearchParams(await tokenRequest.text()))).toEqual({
      client_id: 'Iv1.test',
      client_secret: 'shh',
      code: 'abc',
      redirect_uri: `${ORIGIN}/api/auth/github`,
    })

    const user = await findUserByIdentity(db, { provider: 'github', subject: '9001' })
    expect(user).toMatchObject({
      displayName: 'octo',
      handle: 'octo',
      avatarUrl: 'https://gh.test/o.png',
    })
    const cookies = setCookies(callback)
    expect(cookies['__Host-rover-oauth']!.value).toBe('')
    const claims = await openCookie(cookies['__Host-rover-session']!.value)
    expect(claims).toMatchObject({ sub: user!.id, providers: ['github'], handle: 'octo' })
    expect(JSON.stringify(claims)).not.toContain('gho_secret')
  })

  it('reuses the user on a second sign-in with the same subject', async () => {
    const profile = { id: 4242, login: 'again', name: 'Again', avatar_url: null }
    const app = appOver(testAuth(github(profile).fetch))
    const ids: unknown[] = []
    for (let k = 0; k < 2; k++) {
      const { res, location } = await start(app)
      const callback = await app.request(
        `${ORIGIN}/api/auth/github?code=c${k}&state=${location.searchParams.get('state')}`,
        { headers: { cookie: cookieHeader(res) } },
      )
      ids.push((await openCookie(setCookies(callback)['__Host-rover-session']!.value)).sub)
    }
    expect(ids[0]).toBe(ids[1])
  })

  it('links the identity to the signed-in user when the flow asked to link', async () => {
    const existing = await createUser(db, { displayName: 'Existing' })
    await linkIdentity(db, existing.id, { provider: 'atproto', subject: 'did:plc:existing' })
    const app = appOver(testAuth(github({ id: 777, login: 'linker', name: 'L' }).fetch))
    const login = await app.request(`${ORIGIN}/test/login-as/${existing.id}`, { method: 'POST' })
    const { res, location } = await start(app, '?link=1', cookieHeader(login))
    const callback = await app.request(
      `${ORIGIN}/api/auth/github?code=abc&state=${location.searchParams.get('state')}`,
      { headers: { cookie: cookieHeader(login, res) } },
    )
    expect(callback.status).toBe(302)
    expect(await findUserByIdentity(db, { provider: 'github', subject: '777' })).toMatchObject({
      id: existing.id,
    })
    const claims = await openCookie(setCookies(callback)['__Host-rover-session']!.value)
    expect(claims).toMatchObject({ sub: existing.id, providers: ['atproto', 'github'] })
  })

  it('keeps redirects same-origin', async () => {
    const app = appOver(testAuth(github({ id: 5, login: 'r' }).fetch))
    for (const target of ['https://evil.test/', '//evil.test/', '/\\evil.test']) {
      const { res, location } = await start(app, `?redirect=${encodeURIComponent(target)}`)
      const callback = await app.request(
        `${ORIGIN}/api/auth/github?code=abc&state=${location.searchParams.get('state')}`,
        { headers: { cookie: cookieHeader(res) } },
      )
      expect(callback.headers.get('location')).toBe('/')
    }
  })

  it('answers 502 when GitHub refuses the code', async () => {
    const mock = github({}, () => json({ error: 'bad_verification_code' }))
    const app = appOver(testAuth(mock.fetch))
    const { res, location } = await start(app)
    const callback = await app.request(
      `${ORIGIN}/api/auth/github?code=abc&state=${location.searchParams.get('state')}`,
      { headers: { cookie: cookieHeader(res) } },
    )
    expect(callback.status).toBe(502)
  })
})
