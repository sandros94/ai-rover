import { H3 } from 'nitro/h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '#server/database/db'
import { findUserByIdentity } from '#server/repositories/users'
import { completeSignIn } from '#server/utils/sign-in'
import type { AuthContext } from '~~/modules/auth/runtime/server/lib/context'
import { createDiscordHandler, discordAvatarUrl } from '~~/modules/auth/runtime/server/lib/discord'
import { pkceChallenge } from '~~/modules/auth/runtime/server/lib/random'
import { createTestDb } from '../db/helpers'
import type { Route } from './helpers'
import { cookieHeader, json, mockFetch, openCookie, ORIGIN, setCookies, testAuth } from './helpers'

const CONFIG = { clientId: '1234567890', clientSecret: 'shh' }

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

function discord(user: Record<string, unknown>, onToken?: Route) {
  return mockFetch({
    'POST https://discord.com/api/oauth2/token': (request) =>
      onToken?.(request) ??
      json({ access_token: 'dc_secret', token_type: 'Bearer', scope: 'identify' }),
    'GET https://discord.com/api/users/@me': (request) =>
      request.headers.get('authorization') === 'Bearer dc_secret'
        ? json(user)
        : json({ message: '401: Unauthorized' }, { status: 401 }),
  })
}

function appOver(auth: AuthContext) {
  return new H3().get(
    '/api/auth/discord',
    createDiscordHandler(auth, CONFIG, {
      onSuccess: (event, result) => completeSignIn(event, { db, sessions: auth.sessions }, result),
    }),
  )
}

async function start(app: H3, query = '') {
  const res = await app.request(`${ORIGIN}/api/auth/discord${query}`)
  expect(res.status).toBe(302)
  return { res, location: new URL(res.headers.get('location')!) }
}

async function signIn(app: H3) {
  const { res, location } = await start(app)
  return app.request(
    `${ORIGIN}/api/auth/discord?code=abc&state=${location.searchParams.get('state')}`,
    { headers: { cookie: cookieHeader(res) } },
  )
}

describe('Discord sign-in', () => {
  it('redirects to the authorize URL with PKCE and seals the verifier with the state', async () => {
    const app = appOver(testAuth(discord({}).fetch))
    const { res, location } = await start(app)
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize')
    const params = Object.fromEntries(location.searchParams)
    expect(params).toEqual({
      client_id: '1234567890',
      redirect_uri: `${ORIGIN}/api/auth/discord`,
      response_type: 'code',
      scope: 'identify',
      state: expect.stringMatching(/^[\w-]{32,}$/),
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: 'S256',
    })
    const flow = setCookies(res)['__Host-rover-oauth']!
    expect(Number(flow.attributes['max-age'])).toBe(600)
    const sealed = await openCookie(flow.value)
    expect(sealed).toMatchObject({ provider: 'discord', state: params.state })
    expect(await pkceChallenge(sealed.verifier as string)).toBe(params.code_challenge)
  })

  it('answers 404 while no client id is configured', async () => {
    const auth = testAuth(discord({}).fetch)
    const app = new H3().get(
      '/api/auth/discord',
      createDiscordHandler(auth, { clientId: '', clientSecret: '' }, { onSuccess: () => 'no' }),
    )
    expect((await app.request(`${ORIGIN}/api/auth/discord`)).status).toBe(404)
  })

  it('refuses a callback whose state does not match the sealed one', async () => {
    const mock = discord({ id: '1', username: 'x' })
    const app = appOver(testAuth(mock.fetch))
    const { res } = await start(app)
    const callback = await app.request(`${ORIGIN}/api/auth/discord?code=abc&state=forged`, {
      headers: { cookie: cookieHeader(res) },
    })
    expect(callback.status).toBe(400)
    expect(mock.calls).toHaveLength(0)
  })

  it('answers a denied authorization as refused, without starting again', async () => {
    const mock = discord({})
    const app = appOver(testAuth(mock.fetch))
    const { res, location } = await start(app)
    const callback = await app.request(
      `${ORIGIN}/api/auth/discord?error=access_denied&state=${location.searchParams.get('state')}`,
      { headers: { cookie: cookieHeader(res) } },
    )
    expect(callback.status).toBe(400)
    expect(callback.headers.get('location')).toBeNull()
    expect(mock.calls).toHaveLength(0)
  })

  it('exchanges the code with the verifier, creates the user and discards the token', async () => {
    const mock = discord({
      id: '80351110224678912',
      username: 'nelly',
      global_name: 'Nelly',
      avatar: '8342729096ea3675442027381ff50dfe',
      discriminator: '0',
    })
    const app = appOver(testAuth(mock.fetch))
    const { res, location } = await start(app)
    const callback = await app.request(
      `${ORIGIN}/api/auth/discord?code=abc&state=${location.searchParams.get('state')}`,
      { headers: { cookie: cookieHeader(res) } },
    )
    expect(callback.status).toBe(302)

    const sealed = await openCookie(setCookies(res)['__Host-rover-oauth']!.value)
    expect(Object.fromEntries(new URLSearchParams(await mock.calls[0]!.text()))).toEqual({
      client_id: '1234567890',
      client_secret: 'shh',
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: `${ORIGIN}/api/auth/discord`,
      code_verifier: sealed.verifier,
    })

    const user = await findUserByIdentity(db, { provider: 'discord', subject: '80351110224678912' })
    expect(user).toMatchObject({
      displayName: 'Nelly',
      handle: 'nelly',
      avatarUrl:
        'https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png',
    })
    const claims = await openCookie(setCookies(callback)['__Host-rover-session']!.value)
    expect(claims).toMatchObject({ sub: user!.id, providers: ['discord'] })
    expect(JSON.stringify(claims)).not.toContain('dc_secret')
  })

  it('names the user by username when they set no display name', async () => {
    const app = appOver(
      testAuth(discord({ id: '4242', username: 'plain', global_name: null, avatar: null }).fetch),
    )
    expect((await signIn(app)).status).toBe(302)
    const user = await findUserByIdentity(db, { provider: 'discord', subject: '4242' })
    expect(user).toMatchObject({ displayName: 'plain', handle: 'plain' })
  })

  it('answers 502 when Discord refuses the code', async () => {
    const app = appOver(testAuth(discord({}, () => json({ error: 'invalid_grant' })).fetch))
    expect((await signIn(app)).status).toBe(502)
  })
})

describe('discordAvatarUrl', () => {
  it('uses the avatar hash when set, animated ones as a still', () => {
    expect(discordAvatarUrl('1', 'abc123', '0')).toBe(
      'https://cdn.discordapp.com/avatars/1/abc123.png',
    )
    expect(discordAvatarUrl('1', 'a_abc123', '0')).toBe(
      'https://cdn.discordapp.com/avatars/1/a_abc123.png',
    )
  })

  it('falls back to the default avatar, from the id or a legacy discriminator', () => {
    expect(discordAvatarUrl('80351110224678912', null, '0')).toBe(
      `https://cdn.discordapp.com/embed/avatars/${Number((80351110224678912n >> 22n) % 6n)}.png`,
    )
    expect(discordAvatarUrl('1', null, '1337')).toBe(
      'https://cdn.discordapp.com/embed/avatars/2.png',
    )
    expect(discordAvatarUrl('1', '../x', undefined)).toMatch(/\/embed\/avatars\/\d\.png$/)
  })
})
