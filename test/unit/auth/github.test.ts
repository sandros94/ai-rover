import { H3 } from 'nitro/h3'
import { hash } from 'unsecure/hash'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import {
  createUser,
  findUserByIdentity,
  linkIdentity,
  listIdentities,
} from '#server/repositories/users'
import type { OAuthSignInContext } from '#server/utils/oauth-sign-in'
import { createGitHubSignIn } from '#server/utils/oauth-sign-in'
import { signInSession } from '#server/utils/session'
import { createTestDb } from '../db/helpers'
import type { Route } from './helpers'
import {
  cookieHeader,
  json,
  mockFetch,
  openCookie,
  openSession,
  ORIGIN,
  setCookies,
  testSignInContext,
} from './helpers'

const CONFIG = { clientId: 'Iv1.test', clientSecret: 'shh' }
const ROUTE = `${ORIGIN}/api/auth/github`

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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

function appOver(context: OAuthSignInContext) {
  return new H3()
    .all('/api/auth/github', createGitHubSignIn(CONFIG, context))
    .post('/test/login-as/:id', async (event) => {
      const id = event.context.params!.id!
      await signInSession(await context.sessions.use(event), {
        id,
        displayName: 'Existing',
        providers: ['atproto'],
      })
      return 'ok'
    })
}

/** Starts a flow and returns the authorize URL and the flow cookie response. */
async function start(app: H3, query = '', init: RequestInit = {}) {
  const res = await app.request(`${ROUTE}${query}`, init)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  expect(location.origin).toBe('https://github.com')
  return { res, location }
}

/** A form submitted from a page on `origin`, the app's own by default. */
function formPost(cookie: string, origin = ORIGIN): RequestInit {
  return {
    method: 'POST',
    headers: {
      'cookie': cookie,
      'origin': origin,
      'sec-fetch-site': origin === ORIGIN ? 'same-origin' : 'cross-site',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: '',
  }
}

/** Returns to the route as GitHub would, with `answer` and the state of `location`. */
function callback(app: H3, location: URL, cookie: string, answer = 'code=abc') {
  return app.request(`${ROUTE}?${answer}&state=${location.searchParams.get('state')}`, {
    headers: { cookie },
  })
}

describe('GitHub sign-in', () => {
  it('redirects to the authorize URL with PKCE and no scope, sealing the flow in a cookie', async () => {
    const app = appOver(testSignInContext(db, github({}).fetch))
    const { res, location } = await start(app)
    expect(location.pathname).toBe('/login/oauth/authorize')
    const params = Object.fromEntries(location.searchParams)
    expect(params).toEqual({
      response_type: 'code',
      client_id: 'Iv1.test',
      redirect_uri: ROUTE,
      state: expect.stringMatching(/^[\w-]{32,}$/),
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: 'S256',
    })
    const flow = setCookies(res)['__Host-unauth-flow']!
    expect(flow.attributes).toMatchObject({
      httponly: true,
      secure: true,
      samesite: 'Lax',
      path: '/',
    })
    // Ten minutes, as an `Expires` date.
    const lifetime = Date.parse(flow.attributes.expires as string) - Date.now()
    expect(Math.abs(lifetime - 600_000)).toBeLessThan(2_000)
    const { record } = (await openCookie(flow.value)) as { record: Record<string, string> }
    expect(record).toMatchObject({ provider: 'github', state: params.state, redirectUri: ROUTE })
    expect(await hash(record.verifier!, { algorithm: 'SHA-256', returnAs: 'base64url' })).toBe(
      params.code_challenge,
    )
  })

  it('takes the callback on whichever listed origin the request came to', async () => {
    const preview = 'https://preview--rover.test'
    const app = appOver(testSignInContext(db, github({}).fetch, [ORIGIN, preview]))
    const res = await app.request(`${preview}/api/auth/github`)
    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.get('redirect_uri')).toBe(`${preview}/api/auth/github`)
  })

  it("refuses the deploy's own address, where AT Protocol alone signs in", async () => {
    const mock = github({})
    const app = appOver({
      ...testSignInContext(db, mock.fetch, ['https://main.test']),
      deployOrigins: ['https://rover.test'],
    })
    const res = await app.request(ROUTE)
    expect(res.headers.get('location')).toBe('/login?error=sign-in-failed')
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/\(sign-in-failed\): 421 /), {
      origin: 'https://rover.test',
    })
    expect(mock.calls).toHaveLength(0)
  })

  it('refuses an origin outside NUXT_OAUTH_ORIGINS', async () => {
    const mock = github({})
    const app = appOver(testSignInContext(db, mock.fetch, ['https://elsewhere.test']))
    const res = await app.request(ROUTE)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=sign-in-failed')
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/\(sign-in-failed\): 421 .*not served on this address/),
      { origin: 'https://rover.test' },
    )
    expect(console.error).not.toHaveBeenCalled()
    expect(setCookies(res)['__Host-unauth-flow']).toBeUndefined()
    expect(mock.calls).toHaveLength(0)
  })

  it('answers 404 while no client id is configured', async () => {
    const context = testSignInContext(db, github({}).fetch)
    const app = new H3().all(
      '/api/auth/github',
      createGitHubSignIn({ clientId: '', clientSecret: '' }, context),
    )
    expect((await app.request(ROUTE)).status).toBe(404)
  })

  it('answers 405 to methods other than GET and POST', async () => {
    const app = appOver(testSignInContext(db, github({}).fetch))
    expect((await app.request(ROUTE, { method: 'PUT' })).status).toBe(405)
  })

  it('refuses a callback whose state does not match, leaving the real one to complete', async () => {
    const mock = github({ id: 1, login: 'x' })
    const app = appOver(testSignInContext(db, mock.fetch))
    const { res, location } = await start(app)
    const forged = await app.request(`${ROUTE}?code=abc&state=forged`, {
      headers: { cookie: cookieHeader(res) },
    })
    expect(forged.headers.get('location')).toBe('/login?error=state-mismatch')
    expect(mock.calls).toHaveLength(0)
    const real = await callback(app, location, cookieHeader(res, forged))
    expect(real.headers.get('location')).toBe('/')
  })

  it('refuses a callback once the flow cookie is older than 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const mock = github({ id: 1, login: 'x' })
    const app = appOver(testSignInContext(db, mock.fetch))
    const { res, location } = await start(app)
    vi.setSystemTime(new Date('2026-09-01T00:10:01Z'))
    const answer = await callback(app, location, cookieHeader(res))
    expect(answer.headers.get('location')).toBe('/login?error=state-mismatch')
    expect(mock.calls).toHaveLength(0)
  })

  it('refuses a callback without the flow cookie', async () => {
    const app = appOver(testSignInContext(db, github({ id: 1, login: 'x' }).fetch))
    const answer = await app.request(`${ROUTE}?code=abc&state=any`)
    expect(answer.headers.get('location')).toBe('/login?error=state-mismatch')
  })

  it('answers a denied authorization as refused, ending the flow', async () => {
    const mock = github({})
    const app = appOver(testSignInContext(db, mock.fetch))
    const { res, location } = await start(app)
    const answer = await callback(app, location, cookieHeader(res), 'error=access_denied')
    expect(answer.headers.get('location')).toBe('/login?error=refused')
    expect(setCookies(answer)['__Host-unauth-flow']!.attributes['max-age']).toBe('0')
    expect(mock.calls).toHaveLength(0)
  })

  it('lands with the provider code when GitHub refuses the code', async () => {
    const mock = github({}, () => json({ error: 'bad_verification_code' }))
    const app = appOver(testSignInContext(db, mock.fetch))
    const { res, location } = await start(app)
    const answer = await callback(app, location, cookieHeader(res))
    expect(answer.headers.get('location')).toBe('/login?error=provider')
  })

  it('creates the user and identity, sets the session, and discards the token', async () => {
    const mock = github({
      id: 9001,
      login: 'octo',
      name: 'Octo Cat',
      avatar_url: 'https://gh.test/o.png',
    })
    const app = appOver(testSignInContext(db, mock.fetch))
    const { res, location } = await start(app, '?redirect=/missions/1')
    const answer = await callback(app, location, cookieHeader(res))
    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe('/missions/1')

    const { record } = (await openCookie(setCookies(res)['__Host-unauth-flow']!.value)) as {
      record: Record<string, string>
    }
    const tokenRequest = mock.calls[0]!
    expect(tokenRequest.headers.get('accept')).toContain('application/json')
    expect(Object.fromEntries(new URLSearchParams(await tokenRequest.text()))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'Iv1.test',
      client_secret: 'shh',
      code: 'abc',
      redirect_uri: ROUTE,
      code_verifier: record.verifier,
    })

    // Named by the login, whatever display name the profile carries.
    const user = await findUserByIdentity(db, { provider: 'github', subject: '9001' })
    expect(user).toMatchObject({
      displayName: 'octo',
      handle: 'octo',
      avatarUrl: 'https://gh.test/o.png',
    })
    const cookies = setCookies(answer)
    expect(cookies['__Host-unauth-flow']!.attributes['max-age']).toBe('0')
    const claims = await openSession(cookies['__Host-rover-session']!.value)
    expect(claims.user).toMatchObject({ id: user!.id, providers: ['github'], handle: 'octo' })
    expect(JSON.stringify(claims)).not.toContain('gho_secret')
    expect(JSON.stringify(await listIdentities(db, user!.id))).not.toContain('gho_secret')
  })

  it('reuses the user on a second sign-in with the same subject', async () => {
    const profile = { id: 4242, login: 'again', name: 'Again', avatar_url: null }
    const app = appOver(testSignInContext(db, github(profile).fetch))
    const ids: unknown[] = []
    for (let k = 0; k < 2; k++) {
      const { res, location } = await start(app)
      const answer = await callback(app, location, cookieHeader(res), `code=c${k}`)
      ids.push((await openSession(setCookies(answer)['__Host-rover-session']!.value)).user.id)
    }
    expect(ids[0]).toBe(ids[1])
  })

  it('links the identity to the signed-in user from a same-origin form', async () => {
    const existing = await createUser(db, { displayName: 'Existing' })
    await linkIdentity(db, existing.id, {
      provider: 'atproto',
      subject: 'did:plc:existing',
      profile: { displayName: 'Existing', avatarUrl: null, handle: null },
    })
    const app = appOver(testSignInContext(db, github({ id: 777, login: 'linker' }).fetch))
    const login = await app.request(`${ORIGIN}/test/login-as/${existing.id}`, { method: 'POST' })
    const { res, location } = await start(
      app,
      '?redirect=/settings&link=',
      formPost(cookieHeader(login)),
    )
    const { record } = (await openCookie(setCookies(res)['__Host-unauth-flow']!.value)) as {
      record: { memo: unknown }
    }
    expect(record.memo).toEqual({ userId: existing.id })

    const answer = await callback(app, location, cookieHeader(login, res))
    expect(answer.headers.get('location')).toBe('/settings')
    expect(await findUserByIdentity(db, { provider: 'github', subject: '777' })).toMatchObject({
      id: existing.id,
    })
    const claims = await openSession(setCookies(answer)['__Host-rover-session']!.value)
    expect(claims.user).toMatchObject({ id: existing.id, providers: ['atproto', 'github'] })
  })

  it('refuses a link started from a plain link or another site', async () => {
    const existing = await createUser(db, { displayName: 'Existing' })
    const mock = github({ id: 778, login: 'lured' })
    const app = appOver(testSignInContext(db, mock.fetch))
    const login = await app.request(`${ORIGIN}/test/login-as/${existing.id}`, { method: 'POST' })
    const cookie = cookieHeader(login)
    const starts = [
      { init: { headers: { cookie } }, reason: 'method' },
      { init: formPost(cookie, 'https://evil.test'), reason: 'origin' },
    ]
    for (const { init, reason } of starts) {
      const res = await app.request(`${ROUTE}?link=`, init)
      expect(res.headers.get('location')).toBe('/settings?error=sign-in-failed')
      expect(console.warn).toHaveBeenLastCalledWith(
        expect.stringContaining('(sign-in-failed): 403'),
        { reason },
      )
      expect(setCookies(res)['__Host-unauth-flow']).toBeUndefined()
    }
    expect(mock.calls).toHaveLength(0)
  })

  it('refuses a link while signed out', async () => {
    const app = appOver(testSignInContext(db, github({}).fetch))
    const res = await app.request(`${ROUTE}?link=`, formPost(''))
    expect(res.headers.get('location')).toBe('/login?error=sign-in-failed')
    expect(console.warn).toHaveBeenCalledWith(
      '[auth] sign-in failed (sign-in-failed): 401 Sign in before linking an account.',
    )
    expect(setCookies(res)['__Host-unauth-flow']).toBeUndefined()
  })

  it('refuses a link once another user signed in meanwhile', async () => {
    const first = await createUser(db, { displayName: 'First' })
    const second = await createUser(db, { displayName: 'Second' })
    const app = appOver(testSignInContext(db, github({ id: 779, login: 'switch' }).fetch))
    const asFirst = await app.request(`${ORIGIN}/test/login-as/${first.id}`, { method: 'POST' })
    const { res, location } = await start(app, '?link=', formPost(cookieHeader(asFirst)))
    const asSecond = await app.request(`${ORIGIN}/test/login-as/${second.id}`, { method: 'POST' })
    const answer = await callback(app, location, cookieHeader(asSecond, res))
    expect(answer.headers.get('location')).toBe('/settings?error=link-changed')
    expect(await findUserByIdentity(db, { provider: 'github', subject: '779' })).toBeUndefined()
  })

  it('keeps redirects same-origin', async () => {
    const app = appOver(testSignInContext(db, github({ id: 5, login: 'r' }).fetch))
    for (const target of ['https://evil.test/', '//evil.test/', '/\\evil.test']) {
      const { res, location } = await start(app, `?redirect=${encodeURIComponent(target)}`)
      const answer = await callback(app, location, cookieHeader(res))
      expect(answer.headers.get('location')).toBe('/')
    }
  })
})
