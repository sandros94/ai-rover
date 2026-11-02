import { H3 } from 'nitro/h3'
import { base64Parse } from 'unsecure/utils'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import {
  createUser,
  findUserByIdentity,
  linkIdentity,
  listIdentities,
} from '#server/repositories/users'
import type { OAuthSignInContext } from '#server/utils/oauth-sign-in'
import { createAtprotoSignIn } from '#server/utils/oauth-sign-in'
import { createAuthSessions, signInSession } from '#server/utils/session'
import { createTestDb } from '../db/helpers'
import type { Route } from './helpers'
import {
  cookieHeader,
  json,
  KEY,
  mockFetch,
  openCookie,
  openSession,
  ORIGIN,
  setCookies,
  testSignInContext,
} from './helpers'

const ROUTE = `${ORIGIN}/api/auth/atproto`
const CLIENT_ID = `${ORIGIN}/api/auth/atproto/client-metadata.json`
const ISSUER = 'https://auth.test'
const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const PROFILE = 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const AS_METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
  require_pushed_authorization_requests: true,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  token_endpoint_auth_signing_alg_values_supported: ['ES256'],
  scopes_supported: ['atproto', 'transition:generic'],
  authorization_response_iss_parameter_supported: true,
  dpop_signing_alg_values_supported: ['ES256'],
  client_id_metadata_document_supported: true,
}

/** Answers `use_dpop_nonce` until the proof carries `nonce`, then `ok`. */
function nonced(nonce: string, ok: (request: Request) => Response): Route {
  return (request) => {
    const proof = request.headers.get('dpop')
    const claims = proof
      ? JSON.parse(base64Parse(proof.split('.')[1]!, { alphabet: 'base64url', returnAs: 'string' }))
      : {}
    if (claims.nonce !== nonce) {
      return json(
        { error: 'use_dpop_nonce', error_description: 'nonce required' },
        { status: 400, headers: { 'dpop-nonce': nonce } },
      )
    }
    const response = ok(request)
    response.headers.set('dpop-nonce', nonce)
    return response
  }
}

/**
 * The network one account signs in over: `<handle>` resolving through DNS to `did`, its
 * `did:plc` document naming the PDS, the PDS's authorization server, and Bluesky's public
 * profile; `profile` replaces the latter's answer.
 */
function network(options: { did?: string; handle?: string; profile?: Route } = {}) {
  const did = options.did ?? DID
  const handle = options.handle ?? 'alice.test'
  return mockFetch({
    'GET https://cloudflare-dns.com/dns-query': (request) =>
      new URL(request.url).searchParams.get('name') === `_atproto.${handle}`
        ? json({
            Status: 0,
            Answer: [{ name: `_atproto.${handle}`, type: 16, data: `"did=${did}"` }],
          })
        : json({ Status: 3 }),
    [`GET https://plc.directory/${did}`]: () =>
      json({
        id: did,
        alsoKnownAs: [`at://${handle}`],
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.test',
          },
        ],
      }),
    'GET https://pds.test/.well-known/oauth-protected-resource': () =>
      json({ resource: 'https://pds.test', authorization_servers: [ISSUER] }),
    [`GET ${ISSUER}/.well-known/oauth-authorization-server`]: () => json(AS_METADATA),
    [`POST ${ISSUER}/oauth/par`]: nonced('n-par', () =>
      json(
        { request_uri: 'urn:ietf:params:oauth:request_uri:req-1', expires_in: 300 },
        { status: 201 },
      ),
    ),
    [`POST ${ISSUER}/oauth/token`]: nonced('n-par', () =>
      json({
        access_token: 'at-secret',
        refresh_token: 'rt-secret',
        token_type: 'DPoP',
        scope: 'atproto',
        sub: did,
        expires_in: 300,
      }),
    ),
    [`GET ${PROFILE}`]:
      options.profile ?? (() => json({ did, handle, avatar: 'https://cdn.test/alice.jpg' })),
  })
}

function appOver(context: OAuthSignInContext) {
  const signIn = createAtprotoSignIn(context)
  return new H3()
    .all('/api/auth/atproto', signIn.route)
    .get('/api/auth/atproto/client-metadata.json', signIn.metadata)
    .post('/test/login-as/:id', async (event) => {
      await signInSession(await context.sessions.use(event), {
        id: event.context.params!.id!,
        displayName: 'Existing',
        providers: ['github'],
      })
      return 'ok'
    })
}

/** The login form submitted from a page on `from`, the route's own origin by default. */
function formPost(body: string, options: { cookie?: string; route?: string; from?: string } = {}) {
  const route = options.route ?? ROUTE
  const from = options.from ?? new URL(route).origin
  return {
    method: 'POST',
    headers: {
      'cookie': options.cookie ?? '',
      'origin': from,
      'sec-fetch-site': from === new URL(route).origin ? 'same-origin' : 'cross-site',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  } satisfies RequestInit
}

/** Starts a sign-in from the form, expecting the redirect to the authorization server. */
async function start(app: H3, query = '', options: { handle?: string; cookie?: string } = {}) {
  const body = new URLSearchParams({ handle: options.handle ?? 'alice.test' })
  const res = await app.request(`${ROUTE}${query}`, formPost(`${body}`, options))
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  expect(location.origin + location.pathname).toBe(`${ISSUER}/oauth/authorize`)
  return { res, location }
}

/** The flow record sealed in the flow cookie `res` set. */
async function flowRecord(res: Response, name = '__Host-unauth-flow') {
  const { record } = (await openCookie(setCookies(res)[name]!.value)) as {
    record: { state: string; memo?: unknown } & Record<string, unknown>
  }
  return record
}

/** Returns to the route as the authorization server would, with the flow's state. */
async function callback(app: H3, res: Response, cookie = cookieHeader(res), answer = 'code=c') {
  const { state } = await flowRecord(res)
  const query = new URLSearchParams({ state, iss: ISSUER })
  return app.request(`${ROUTE}?${answer}&${query}`, { headers: { cookie } })
}

describe('AT Protocol sign-in', () => {
  it('pushes the request for the account the form names, then redirects to its server', async () => {
    const mock = network()
    const app = appOver(testSignInContext(db, mock.fetch))
    const { res, location } = await start(app, '?redirect=/missions/1')
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: CLIENT_ID,
      request_uri: 'urn:ietf:params:oauth:request_uri:req-1',
    })

    const par = mock.calls.filter((call) => call.url === `${ISSUER}/oauth/par`).at(-1)!
    const record = await flowRecord(res)
    expect(Object.fromEntries(new URLSearchParams(await par.text()))).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: ROUTE,
      scope: 'atproto',
      state: record.state,
      login_hint: 'alice.test',
    })
    expect(record).toMatchObject({
      provider: 'atproto',
      redirectUri: ROUTE,
      redirect: '/missions/1',
    })
    expect(setCookies(res)['__Host-unauth-flow']!.attributes).toMatchObject({
      httponly: true,
      secure: true,
      samesite: 'Lax',
      path: '/',
    })
  })

  it('serves each listed origin its own client metadata, deploy previews included', async () => {
    const preview = 'https://preview--rover.test'
    const mock = network()
    const app = appOver(testSignInContext(db, mock.fetch, [ORIGIN, preview]))
    for (const origin of [ORIGIN, preview]) {
      const res = await app.request(`${origin}/api/auth/atproto/client-metadata.json`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(await res.json()).toEqual({
        client_id: `${origin}/api/auth/atproto/client-metadata.json`,
        application_type: 'web',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        redirect_uris: [`${origin}/api/auth/atproto`],
        scope: 'atproto',
        dpop_bound_access_tokens: true,
        token_endpoint_auth_method: 'none',
        client_name: 'AI Rover',
        client_uri: origin,
      })
    }

    const route = `${preview}/api/auth/atproto`
    const res = await app.request(route, formPost('handle=alice.test', { route }))
    expect(new URL(res.headers.get('location')!).searchParams.get('client_id')).toBe(
      `${preview}/api/auth/atproto/client-metadata.json`,
    )
  })

  it("signs in on the deploy's own address too, publishing its client there", async () => {
    const preview = 'https://deploy-preview-12--rover.test'
    const app = appOver({
      ...testSignInContext(db, network().fetch, ['https://main.test']),
      deployOrigins: [preview],
    })
    const metadata = await app.request(`${preview}/api/auth/atproto/client-metadata.json`)
    expect(await metadata.json()).toMatchObject({
      client_id: `${preview}/api/auth/atproto/client-metadata.json`,
      redirect_uris: [`${preview}/api/auth/atproto`],
    })
    const route = `${preview}/api/auth/atproto`
    const res = await app.request(route, formPost('handle=alice.test', { route }))
    expect(new URL(res.headers.get('location')!).origin).toBe(ISSUER)
  })

  it('refuses an origin outside NUXT_OAUTH_ORIGINS, publishing no client there', async () => {
    const mock = network()
    const app = appOver(testSignInContext(db, mock.fetch, ['https://elsewhere.test']))
    const res = await app.request(ROUTE, formPost('handle=alice.test'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=sign-in-failed')
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/\(sign-in-failed\): 421 .*not served on this address/),
      { origin: ORIGIN },
    )
    expect(setCookies(res)['__Host-unauth-flow']).toBeUndefined()
    expect((await app.request(CLIENT_ID)).status).toBe(404)
    expect(mock.calls).toHaveLength(0)
  })

  it('answers 405 to methods other than GET and POST', async () => {
    const app = appOver(testSignInContext(db, network().fetch))
    expect((await app.request(ROUTE, { method: 'PUT' })).status).toBe(405)
  })

  it('takes the account only from a form submitted on this site', async () => {
    const mock = network()
    const app = appOver(testSignInContext(db, mock.fetch))
    // A link or a pasted URL names no account: the query is not read.
    const linked = await app.request(`${ROUTE}?handle=alice.test`)
    expect(linked.headers.get('location')).toBe('/login?error=handle')

    const res = await app.request(
      ROUTE,
      formPost('handle=alice.test', { from: 'https://evil.test' }),
    )
    expect(res.headers.get('location')).toBe('/login?error=sign-in-failed')
    expect(console.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('(sign-in-failed): 403'),
      { reason: 'origin' },
    )
    expect(setCookies(res)['__Host-unauth-flow']).toBeUndefined()
    expect(mock.calls).toHaveLength(0)
  })

  it('asks for a handle when the form names none', async () => {
    const mock = network()
    const app = appOver(testSignInContext(db, mock.fetch))
    for (const body of ['', 'handle=', 'handle=%20%20', 'other=alice.test']) {
      const res = await app.request(ROUTE, formPost(body))
      expect({ body, location: res.headers.get('location') }).toEqual({
        body,
        location: '/login?error=handle',
      })
    }
    expect(mock.calls).toHaveLength(0)
  })

  it('names a handle that leads to no account', async () => {
    const app = appOver(testSignInContext(db, network().fetch))
    for (const handle of ['nobody.test', 'not a handle', 'did:key:z6Mk']) {
      const res = await app.request(ROUTE, formPost(`${new URLSearchParams({ handle })}`))
      expect({ handle, location: res.headers.get('location') }).toEqual({
        handle,
        location: '/login?error=handle',
      })
    }
  })

  it('creates the account by DID, named by its handle, sets the session and keeps no token', async () => {
    const mock = network()
    const app = appOver(testSignInContext(db, mock.fetch))
    const { res } = await start(app, '?redirect=/missions/1')
    const answer = await callback(app, res)
    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe('/missions/1')

    const user = await findUserByIdentity(db, { provider: 'atproto', subject: DID })
    expect(user).toMatchObject({
      displayName: 'alice.test',
      handle: 'alice.test',
      avatarUrl: 'https://cdn.test/alice.jpg',
    })
    const avatar = mock.calls.find((call) => call.url.startsWith(PROFILE))!
    expect(new URL(avatar.url).searchParams.get('actor')).toBe(DID)

    const cookies = setCookies(answer)
    expect(cookies['__Host-unauth-flow']!.attributes['max-age']).toBe('0')
    const claims = await openSession(cookies['__Host-rover-session']!.value)
    expect(claims.user).toMatchObject({
      id: user!.id,
      providers: ['atproto'],
      handle: 'alice.test',
    })
    for (const secret of ['at-secret', 'rt-secret']) {
      expect(JSON.stringify(claims)).not.toContain(secret)
      expect(JSON.stringify(await listIdentities(db, user!.id))).not.toContain(secret)
    }
  })

  it('reuses the account on a second sign-in with the same DID', async () => {
    const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
    const app = appOver(testSignInContext(db, network({ did, handle: 'again.test' }).fetch))
    const ids: unknown[] = []
    for (let k = 0; k < 2; k++) {
      const { res } = await start(app, '', { handle: 'again.test' })
      const answer = await callback(app, res)
      ids.push((await openSession(setCookies(answer)['__Host-rover-session']!.value)).user.id)
    }
    expect(ids[0]).toBe(ids[1])
  })

  it('signs in without an avatar when the public profile has none to give', async () => {
    const answers: Route[] = [
      () => Promise.reject(new Error('offline')),
      () => json({ error: 'InternalServerError' }, { status: 500 }),
      () => json({ did: 'x', avatar: 'http://cdn.test/alice.jpg' }),
      () => json({ did: 'x', avatar: 'https://10.0.0.1/alice.jpg' }),
      () => new Response('not json'),
    ]
    for (const [k, profile] of answers.entries()) {
      const did = `did:plc:bbbbbbbbbbbbbbbbbbbbbbb${'abcde'[k]}`
      const handle = `noavatar${k}.test`
      const app = appOver(testSignInContext(db, network({ did, handle, profile }).fetch))
      const { res } = await start(app, '', { handle })
      const answer = await callback(app, res)
      expect(answer.headers.get('location')).toBe('/')
      const user = await findUserByIdentity(db, { provider: 'atproto', subject: did })
      expect(user).toMatchObject({ displayName: handle, avatarUrl: null })
    }
  })

  it('links the identity to the signed-in user from the settings form', async () => {
    const did = 'did:plc:cccccccccccccccccccccccc'
    const existing = await createUser(db, { displayName: 'Existing' })
    await linkIdentity(db, existing.id, {
      provider: 'github',
      subject: '31337',
      profile: { displayName: 'Existing', avatarUrl: null, handle: null },
    })
    const app = appOver(testSignInContext(db, network({ did, handle: 'linker.test' }).fetch))
    const login = await app.request(`${ORIGIN}/test/login-as/${existing.id}`, { method: 'POST' })
    const { res } = await start(app, '?redirect=/settings&link=', {
      handle: 'linker.test',
      cookie: cookieHeader(login),
    })
    expect((await flowRecord(res)).memo).toEqual({ userId: existing.id })

    const answer = await callback(app, res, cookieHeader(login, res))
    expect(answer.headers.get('location')).toBe('/settings')
    expect(await findUserByIdentity(db, { provider: 'atproto', subject: did })).toMatchObject({
      id: existing.id,
    })
    const claims = await openSession(setCookies(answer)['__Host-rover-session']!.value)
    expect(claims.user).toMatchObject({ id: existing.id, providers: ['github', 'atproto'] })
  })

  it('refuses a link while signed out', async () => {
    const mock = network()
    const app = appOver(testSignInContext(db, mock.fetch))
    const res = await app.request(`${ROUTE}?link=`, formPost('handle=alice.test'))
    expect(res.headers.get('location')).toBe('/login?error=sign-in-failed')
    expect(console.warn).toHaveBeenCalledWith(
      '[auth] sign-in failed (sign-in-failed): 401 Sign in before linking an account.',
    )
    expect(mock.calls).toHaveLength(0)
  })

  it('refuses a link once another user signed in meanwhile', async () => {
    const did = 'did:plc:dddddddddddddddddddddddd'
    const first = await createUser(db, { displayName: 'First' })
    const second = await createUser(db, { displayName: 'Second' })
    const app = appOver(testSignInContext(db, network({ did, handle: 'switch.test' }).fetch))
    const asFirst = await app.request(`${ORIGIN}/test/login-as/${first.id}`, { method: 'POST' })
    const { res } = await start(app, '?link=', {
      handle: 'switch.test',
      cookie: cookieHeader(asFirst),
    })
    const asSecond = await app.request(`${ORIGIN}/test/login-as/${second.id}`, { method: 'POST' })
    const answer = await callback(app, res, cookieHeader(asSecond, res))
    expect(answer.headers.get('location')).toBe('/settings?error=link-changed')
    expect(await findUserByIdentity(db, { provider: 'atproto', subject: did })).toBeUndefined()
  })

  it('names a callback that is not the flow this browser started, or a refusal', async () => {
    const app = appOver(testSignInContext(db, network().fetch))
    const { res } = await start(app)
    const forged = await app.request(
      `${ROUTE}?code=c&state=forged&iss=${encodeURIComponent(ISSUER)}`,
      {
        headers: { cookie: cookieHeader(res) },
      },
    )
    expect(forged.headers.get('location')).toBe('/login?error=state-mismatch')

    const other = await start(app)
    const elsewhere = await app.request(
      `${ROUTE}?code=c&state=${(await flowRecord(other.res)).state}&iss=${encodeURIComponent('https://evil.test')}`,
      { headers: { cookie: cookieHeader(other.res) } },
    )
    expect(elsewhere.headers.get('location')).toBe('/login?error=state-mismatch')

    const denied = await start(app)
    const answer = await callback(app, denied.res, undefined, 'error=access_denied')
    expect(answer.headers.get('location')).toBe('/login?error=refused')
  })
})

describe('AT Protocol sign-in under nuxt dev', () => {
  const DEV = 'http://localhost:3000'
  const CALLBACK = 'http://127.0.0.1:3000'

  function devContext(fetch: typeof globalThis.fetch): OAuthSignInContext {
    return {
      ...testSignInContext(db, fetch, [DEV]),
      sessions: createAuthSessions({ key: async () => KEY, dev: true }),
      dev: true,
    }
  }

  it('publishes no client metadata: the development client has none', async () => {
    const app = appOver(devContext(network().fetch))
    for (const origin of [DEV, CALLBACK]) {
      expect((await app.request(`${origin}/api/auth/atproto/client-metadata.json`)).status).toBe(
        404,
      )
    }
  })

  it('moves a localhost sign-in to 127.0.0.1 and hands the result back to localhost', async () => {
    const did = 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee'
    const mock = network({ did, handle: 'dev.test' })
    const app = appOver(devContext(mock.fetch))
    const route = `${DEV}/api/auth/atproto`

    const moved = await app.request(`${route}?redirect=/x`, formPost('handle=dev.test', { route }))
    expect(moved.status).toBe(302)
    const relocated = new URL(moved.headers.get('location')!)
    expect(relocated.origin + relocated.pathname).toBe(`${CALLBACK}/api/auth/atproto`)
    expect(mock.calls).toHaveLength(0)

    const started = await app.request(relocated.href)
    expect(started.status).toBe(302)
    const location = new URL(started.headers.get('location')!)
    const clientId = `http://localhost?${new URLSearchParams({
      redirect_uri: `${CALLBACK}/api/auth/atproto`,
      scope: 'atproto',
    })}`
    expect(location.searchParams.get('client_id')).toBe(clientId)
    const par = mock.calls.filter((call) => call.url === `${ISSUER}/oauth/par`).at(-1)!
    expect(Object.fromEntries(new URLSearchParams(await par.text()))).toMatchObject({
      client_id: clientId,
      redirect_uri: `${CALLBACK}/api/auth/atproto`,
      login_hint: 'dev.test',
    })
    const flow = setCookies(started)['unauth-flow']!
    expect(flow.attributes.secure).toBeUndefined()

    const { record } = (await openCookie(flow.value)) as { record: { state: string } }
    const query = new URLSearchParams({ code: 'c', state: record.state, iss: ISSUER })
    const returned = await app.request(`${CALLBACK}/api/auth/atproto?${query}`, {
      headers: { cookie: cookieHeader(started) },
    })
    const handoff = new URL(returned.headers.get('location')!)
    expect(handoff.origin + handoff.pathname).toBe(route)
    expect(await findUserByIdentity(db, { provider: 'atproto', subject: did })).toBeUndefined()

    const answer = await app.request(handoff.href, { headers: { cookie: cookieHeader(moved) } })
    expect(answer.headers.get('location')).toBe('/x')
    const claims = await openSession(setCookies(answer)['rover-session']!.value)
    const user = await findUserByIdentity(db, { provider: 'atproto', subject: did })
    expect(claims.user).toMatchObject({ id: user!.id, providers: ['atproto'], handle: 'dev.test' })
  })

  /** Starts on localhost, follows the move to 127.0.0.1 and answers its callback with `answer`. */
  async function relocatedFlow(
    app: H3,
    options: { query: string; handle: string; cookie?: string; answer?: string },
  ) {
    const route = `${DEV}/api/auth/atproto`
    const moved = await app.request(
      `${route}${options.query}`,
      formPost(`handle=${options.handle}`, { route, cookie: options.cookie }),
    )
    const relocated = new URL(moved.headers.get('location')!)
    expect(relocated.origin).toBe(CALLBACK)
    // 127.0.0.1 holds no session of localhost's: the start must not need one there.
    const started = await app.request(relocated.href)
    expect(new URL(started.headers.get('location')!).origin).toBe(ISSUER)
    const { record } = (await openCookie(setCookies(started)['unauth-flow']!.value)) as {
      record: { state: string }
    }
    const query = new URLSearchParams({ state: record.state, iss: ISSUER })
    const returned = await app.request(
      `${CALLBACK}/api/auth/atproto?${options.answer ?? 'code=c'}&${query}`,
      { headers: { cookie: cookieHeader(started) } },
    )
    const handoff = new URL(returned.headers.get('location')!)
    expect(handoff.origin + handoff.pathname).toBe(route)
    return { moved, handoff }
  }

  it('links from localhost, the start relocated to 127.0.0.1 without a session there', async () => {
    const did = 'did:plc:ffffffffffffffffffffffff'
    const existing = await createUser(db, { displayName: 'Existing' })
    const app = appOver(devContext(network({ did, handle: 'devlink.test' }).fetch))
    const login = await app.request(`${DEV}/test/login-as/${existing.id}`, { method: 'POST' })
    const { moved, handoff } = await relocatedFlow(app, {
      query: '?redirect=/settings&link=',
      handle: 'devlink.test',
      cookie: cookieHeader(login),
    })

    const answer = await app.request(handoff.href, {
      headers: { cookie: cookieHeader(login, moved) },
    })
    expect(answer.headers.get('location')).toBe('/settings')
    expect(await findUserByIdentity(db, { provider: 'atproto', subject: did })).toMatchObject({
      id: existing.id,
    })
  })

  it('hands a failure at 127.0.0.1 back to localhost, where it lands', async () => {
    const app = appOver(devContext(network().fetch))
    const { moved, handoff } = await relocatedFlow(app, {
      query: '',
      handle: 'alice.test',
      answer: 'error=access_denied',
    })
    const answer = await app.request(handoff.href, { headers: { cookie: cookieHeader(moved) } })
    expect(answer.headers.get('location')).toBe('/login?error=refused')
  })
})
