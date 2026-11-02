import { H3, HTTPError } from 'nitro/h3'
import { UnauthError } from 'unauth/n'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import type { ProvenIdentity } from '#server/repositories/users'
import {
  createUserWithIdentity,
  findUser,
  findUserByIdentity,
  listIdentities,
} from '#server/repositories/users'
import { createGitHubSignIn } from '#server/utils/oauth-sign-in'
import { signInSession } from '#server/utils/session'
import { signInErrorCode, signInFailure } from '#server/utils/sign-in'
import { createTestDb } from '../db/helpers'
import {
  cookieHeader,
  json,
  mockFetch,
  openSession,
  ORIGIN,
  setCookies,
  testSignInContext,
} from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => {
  ;({ db, close } = await createTestDb())
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterAll(() => close())

/** GitHub sign-in over a GitHub that proves whichever account the test names next. */
function appWith() {
  const next = { id: 0, login: '' }
  const { fetch } = mockFetch({
    'POST https://github.com/login/oauth/access_token': () =>
      json({ access_token: 'gho_secret', token_type: 'bearer', scope: '' }),
    'GET https://api.github.com/user': () => json({ ...next, avatar_url: null }),
  })
  const context = testSignInContext(db, fetch)
  const app = new H3()
    .all(
      '/api/auth/github',
      createGitHubSignIn({ clientId: 'id', clientSecret: 'secret' }, context),
    )
    .post('/test/login-as/:id', async (event) => {
      await signInSession(await context.sessions.use(event), {
        id: event.context.params!.id!,
        displayName: 'Current',
        providers: ['discord'],
      })
      return 'ok'
    })

  /** Runs the flow for `subject`, signed in as `as` when given, linking when `link`; `deny` refuses it at the provider. */
  async function run(
    subject: number,
    options: { as?: string; link?: boolean; deny?: boolean } = {},
  ) {
    next.id = subject
    next.login = `gh-${subject}`
    const login = options.as
      ? await app.request(`${ORIGIN}/test/login-as/${options.as}`, { method: 'POST' })
      : undefined
    const jar = login ? [login] : []
    const cookie = cookieHeader(...jar)
    const started = await app.request(
      `${ORIGIN}/api/auth/github?redirect=/settings${options.link ? '&link' : ''}`,
      options.link
        ? { method: 'POST', headers: { cookie, 'origin': ORIGIN, 'sec-fetch-site': 'same-origin' } }
        : { headers: { cookie } },
    )
    expect(started.status).toBe(302)
    const state = new URL(started.headers.get('location')!).searchParams.get('state')
    const answer = options.deny ? 'error=access_denied' : 'code=c'
    const callback = await app.request(`${ORIGIN}/api/auth/github?${answer}&state=${state}`, {
      headers: { cookie: cookieHeader(...jar, started) },
    })
    const session = setCookies(callback)['__Host-rover-session']
    return {
      status: callback.status,
      location: callback.headers.get('location'),
      claims: session?.value ? await openSession(session.value) : undefined,
    }
  }
  return { run }
}

function discord(displayName: string, subject: string): ProvenIdentity {
  return { provider: 'discord', subject, profile: { displayName, avatarUrl: null, handle: null } }
}

describe('completing a sign-in', () => {
  it('creates an account for an unknown identity and signs into it', async () => {
    const { run } = appWith()
    const { location, claims } = await run(101)
    expect(location).toBe('/settings')
    const user = await findUserByIdentity(db, { provider: 'github', subject: '101' })
    expect(user).toMatchObject({ displayName: 'gh-101', primaryProvider: 'github' })
    expect(claims?.user).toMatchObject({ id: user!.id, providers: ['github'] })
  })

  it('attaches an unclaimed identity to the signed-in account when linking', async () => {
    const { run } = appWith()
    const current = await createUserWithIdentity(db, discord('Current', 'd-102'))
    const { location, claims } = await run(102, { as: current.id, link: true })
    expect(location).toBe('/settings')
    expect(await findUserByIdentity(db, { provider: 'github', subject: '102' })).toMatchObject({
      id: current.id,
      displayName: 'Current',
    })
    expect(claims?.user).toMatchObject({ id: current.id, providers: ['discord', 'github'] })
  })

  it("merges the identity's account into the signed-in one when linking", async () => {
    const { run } = appWith()
    await run(103)
    const other = (await findUserByIdentity(db, { provider: 'github', subject: '103' }))!
    const current = await createUserWithIdentity(db, discord('Current', 'd-103'))
    const { claims } = await run(103, { as: current.id, link: true })
    expect(await findUser(db, other.id)).toBeUndefined()
    expect((await listIdentities(db, current.id)).map((i) => i.provider).toSorted()).toEqual([
      'discord',
      'github',
    ])
    expect(claims?.user).toMatchObject({ id: current.id, displayName: 'Current' })
  })

  it('signs into the holding account when not linking, whoever was signed in', async () => {
    const { run } = appWith()
    await run(104)
    const holder = (await findUserByIdentity(db, { provider: 'github', subject: '104' }))!
    const current = await createUserWithIdentity(db, discord('Current', 'd-104'))
    const { claims } = await run(104, { as: current.id })
    expect(claims?.user).toMatchObject({ id: holder.id, providers: ['github'] })
    expect(await findUser(db, current.id)).toBeDefined()
  })

  it('lands on the settings page with the code when a link cannot merge', async () => {
    const { run } = appWith()
    await run(105)
    const current = await createUserWithIdentity(db, {
      provider: 'github',
      subject: '105-other',
      profile: { displayName: 'Current', avatarUrl: null, handle: null },
    })
    const { status, location } = await run(105, { as: current.id, link: true })
    expect(status).toBe(302)
    expect(location).toBe('/settings?error=link-conflict')
  })

  it('lands on the login page with the code when signed out', async () => {
    const { run } = appWith()
    const { location } = await run(106, { deny: true })
    expect(location).toBe('/login?error=refused')
  })
})

describe('signInErrorCode', () => {
  it('maps the failed flows of unauth onto the codes the login page explains', () => {
    const codes = {
      ERR_AUTHN_FLOW_EXPIRED: 'state-mismatch',
      ERR_AUTHN_STATE_MISMATCH: 'state-mismatch',
      ERR_AUTHN_PROVIDER_REFUSED: 'refused',
      ERR_AUTHN_LOGIN_HINT_REQUIRED: 'handle',
      ERR_AUTHN_LOGIN_HINT_INVALID: 'handle',
      ERR_AUTHN_TOKEN_EXCHANGE: 'provider',
      ERR_AUTHN_PROFILE_INVALID: 'provider',
      ERR_AUTHN_PROVIDER_ERROR: 'provider',
      ERR_AUTHN_CROSS_SITE_START: 'sign-in-failed',
      ERR_AUTHN_ORIGIN_UNTRUSTED: 'sign-in-failed',
      ERR_AUTHN_UNAUTHENTICATED: 'sign-in-failed',
      ERR_UNAUTH_CONFIG_INVALID: 'sign-in-failed',
    } as const
    const mapped = Object.fromEntries(
      Object.keys(codes).map((code) => [code, signInErrorCode(new UnauthError('x', code))]),
    )
    expect(mapped).toEqual(codes)
  })

  it("reads the app's own failures, a database failure underneath and a provider's 502", () => {
    expect(signInErrorCode(signInFailure('link-conflict', { status: 409, message: 'x' }))).toBe(
      'link-conflict',
    )
    const postgres = Object.assign(new Error('connection refused'), { code: '08006' })
    expect(signInErrorCode(new Error('query failed', { cause: postgres }))).toBe('database')
    expect(signInErrorCode(new HTTPError({ status: 500, message: 'x', cause: postgres }))).toBe(
      'database',
    )
    expect(signInErrorCode(new HTTPError({ status: 502, message: 'x' }))).toBe('provider')
    expect(signInErrorCode(new Error('x'))).toBe('sign-in-failed')
  })
})
