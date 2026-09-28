import { H3 } from 'nitro/h3'
import { base64Parse } from 'unsecure/utils'
import { verify } from 'unjwt/jws'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DB } from '#server/database/db'
import { findUserByIdentity } from '#server/repositories/users'
import type { OAuthResult } from '~~/modules/auth/runtime/server/lib/oauth'
import { completeSignIn, failSignIn } from '#server/utils/sign-in'
import {
  atprotoClient,
  createAtprotoHandler,
  createClientMetadataHandler,
} from '~~/modules/auth/runtime/server/lib/atproto/handler'
import { resolveIdentity } from '~~/modules/auth/runtime/server/lib/atproto/identity'
import {
  createDpopKey,
  dpopProof,
  dpopRequest,
} from '~~/modules/auth/runtime/server/lib/atproto/proof'
import { pkceChallenge } from '~~/modules/auth/runtime/server/lib/random'
import { publicHttpsUrl } from '~~/modules/auth/runtime/server/lib/http'
import type { AuthContext } from '~~/modules/auth/runtime/server/lib/context'
import { createTestDb } from '../db/helpers'
import type { Route } from './helpers'
import { cookieHeader, json, mockFetch, openCookie, ORIGIN, setCookies, testAuth } from './helpers'

let db: DB
let close: () => Promise<void>
beforeAll(async () => ({ db, close } = await createTestDb()))
afterAll(() => close())

const DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'

function didDoc(did: string, handle: string, pds = 'https://pds.test') {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    'id': did,
    'alsoKnownAs': [`at://${handle}`],
    'service': [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }],
  }
}

const AS_METADATA = {
  issuer: 'https://auth.test',
  authorization_endpoint: 'https://auth.test/oauth/authorize',
  token_endpoint: 'https://auth.test/oauth/token',
  pushed_authorization_request_endpoint: 'https://auth.test/oauth/par',
  require_pushed_authorization_requests: true,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  scopes_supported: ['atproto', 'transition:generic'],
  authorization_response_iss_parameter_supported: true,
  dpop_signing_alg_values_supported: ['ES256'],
  client_id_metadata_document_supported: true,
}

/** Answers `use_dpop_nonce` until the proof carries `nonce`, then `ok`. */
function nonced(nonce: string, ok: (request: Request) => Response | Promise<Response>): Route {
  return async (request) => {
    const proof = request.headers.get('dpop')
    const claims = proof ? decodeClaims(proof) : {}
    if (claims.nonce !== nonce) {
      return json(
        { error: 'use_dpop_nonce', error_description: 'nonce required' },
        { status: 400, headers: { 'dpop-nonce': nonce } },
      )
    }
    const response = await ok(request)
    response.headers.set('dpop-nonce', nonce)
    return response
  }
}

interface NetworkOptions {
  token?: Record<string, unknown>
  doc?: Record<string, unknown>
  as?: Record<string, unknown>
}

function network(options: NetworkOptions = {}) {
  return mockFetch({
    'GET https://cloudflare-dns.com/dns-query': (request) =>
      new URL(request.url).searchParams.get('name') === '_atproto.alice.test'
        ? json({
            Status: 0,
            Answer: [{ name: '_atproto.alice.test', type: 16, data: `"did=${DID}"` }],
          })
        : json({ Status: 3 }),
    [`GET https://plc.directory/${DID}`]: () => json(options.doc ?? didDoc(DID, 'alice.test')),
    'GET https://pds.test/.well-known/oauth-protected-resource': () =>
      json({ resource: 'https://pds.test', authorization_servers: ['https://auth.test'] }),
    'GET https://auth.test/.well-known/oauth-authorization-server': () =>
      json({ ...AS_METADATA, ...options.as }),
    'POST https://auth.test/oauth/par': nonced('n-par', () =>
      json(
        { request_uri: 'urn:ietf:params:oauth:request_uri:req-1', expires_in: 300 },
        { status: 201 },
      ),
    ),
    'POST https://auth.test/oauth/token': nonced('n-par', () =>
      json({
        access_token: 'at-secret',
        refresh_token: 'rt-secret',
        token_type: 'DPoP',
        scope: 'atproto',
        sub: DID,
        expires_in: 300,
        ...options.token,
      }),
    ),
    'GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile': () =>
      json({ did: DID, handle: 'alice.test', avatar: 'https://cdn.test/alice.jpg' }),
  })
}

function appOver(
  auth: AuthContext,
  options: { complete?: (result: OAuthResult) => unknown; redirectErrors?: boolean } = {},
) {
  return new H3()
    .get(
      '/api/auth/atproto',
      createAtprotoHandler(auth, {
        onSuccess: (event, result) =>
          options.complete
            ? options.complete(result)
            : completeSignIn(event, { db, sessions: auth.sessions }, result),
        ...(options.redirectErrors && { onError: failSignIn }),
      }),
    )
    .get('/api/auth/atproto/client-metadata.json', createClientMetadataHandler(auth))
}

async function start(app: H3, origin = ORIGIN) {
  const res = await app.request(`${origin}/api/auth/atproto?handle=alice.test`)
  expect(res.status).toBe(302)
  return { res, location: new URL(res.headers.get('location')!) }
}

describe('identity resolution', () => {
  it('resolves a handle through DNS TXT to a did:plc document and its PDS', async () => {
    expect(await resolveIdentity('Alice.Test', network().fetch)).toEqual({
      did: DID,
      handle: 'alice.test',
      pds: 'https://pds.test',
    })
  })

  it('falls back to the HTTPS well-known when DNS has no record', async () => {
    const { fetch } = mockFetch({
      'GET https://cloudflare-dns.com/dns-query': () => json({ Status: 3 }),
      'GET https://bob.test/.well-known/atproto-did': () => new Response('did:web:bob.test\n'),
      'GET https://bob.test/.well-known/did.json': () =>
        json(didDoc('did:web:bob.test', 'bob.test', 'https://pds.bob.test')),
    })
    expect(await resolveIdentity('bob.test', fetch)).toEqual({
      did: 'did:web:bob.test',
      handle: 'bob.test',
      pds: 'https://pds.bob.test',
    })
  })

  it('resolves a DID given directly and keeps its handle only when it points back', async () => {
    expect(await resolveIdentity(DID, network().fetch)).toEqual({
      did: DID,
      handle: 'alice.test',
      pds: 'https://pds.test',
    })
    const liar = network({ doc: didDoc(DID, 'someone-else.test') })
    expect(await resolveIdentity(DID, liar.fetch)).toEqual({ did: DID, pds: 'https://pds.test' })
  })

  it('refuses a handle the DID document does not claim', async () => {
    const { fetch } = network({ doc: didDoc(DID, 'mallory.test') })
    await expect(resolveIdentity('alice.test', fetch)).rejects.toMatchObject({ status: 400 })
  })

  it('refuses a document whose id is another DID', async () => {
    const { fetch } = network({ doc: didDoc('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', 'alice.test') })
    await expect(resolveIdentity('alice.test', fetch)).rejects.toMatchObject({ status: 400 })
  })

  it('refuses malformed identifiers without any request', async () => {
    const { fetch, calls } = network()
    for (const input of ['', 'nodot', 'a..b', 'did:key:z6Mk', 'did:web:10.0.0.1', '127.0.0.1']) {
      await expect(resolveIdentity(input, fetch)).rejects.toMatchObject({ status: 400 })
    }
    expect(calls).toHaveLength(0)
  })
})

describe('SSRF hardening', () => {
  it('accepts public https URLs only', () => {
    expect(publicHttpsUrl('https://pds.test/xrpc').href).toBe('https://pds.test/xrpc')
    for (const url of [
      'http://pds.test',
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://[::1]',
      'https://localhost',
      'https://pds.localhost',
      'https://printer.local',
      'https://intranet',
      'https://user:pw@pds.test',
      'ftp://pds.test',
      'not a url',
    ]) {
      expect(() => publicHttpsUrl(url)).toThrow(/Refused|not a URL/)
    }
  })

  it('refuses a DID document pointing its PDS at plain http or an IP literal', async () => {
    for (const pds of ['http://pds.test', 'https://192.168.1.10']) {
      const { fetch } = network({ doc: didDoc(DID, 'alice.test', pds) })
      await expect(resolveIdentity('alice.test', fetch)).rejects.toMatchObject({ status: 400 })
    }
  })
})

describe('PKCE and DPoP', () => {
  it('derives the RFC 7636 S256 challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('signs a proof with typ, alg and the public jwk, and no ath', async () => {
    const key = await createDpopKey()
    const proof = await dpopProof(key, { htm: 'POST', htu: 'https://auth.test/oauth/token?x=1#f' })
    const verified = await verify(proof, protectedHeaderJwk(proof))
    const { protectedHeader } = verified
    const payload = verified.payload as Record<string, unknown>
    expect(protectedHeader).toMatchObject({ typ: 'dpop+jwt', alg: 'ES256' })
    expect(protectedHeader.jwk).toEqual({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y })
    expect(payload).toMatchObject({ htm: 'POST', htu: 'https://auth.test/oauth/token' })
    expect(typeof payload.jti).toBe('string')
    expect(Math.abs((payload.iat as number) - Date.now() / 1000)).toBeLessThan(5)
    expect(payload).not.toHaveProperty('ath')
    expect(payload).not.toHaveProperty('nonce')
  })

  it('retries once with the server nonce and returns it', async () => {
    const key = await createDpopKey()
    const { fetch, calls } = mockFetch({
      'POST https://auth.test/oauth/token': nonced('n-1', () => json({ ok: true })),
    })
    const result = await dpopRequest(fetch, key, 'https://auth.test/oauth/token', { a: '1' })
    expect(result.body).toEqual({ ok: true })
    expect(result.nonce).toBe('n-1')
    expect(calls).toHaveLength(2)
    const [first, second] = calls.map((call) => decodeClaims(call.headers.get('dpop')!))
    expect(first!.nonce).toBeUndefined()
    expect(second!.nonce).toBe('n-1')
    expect(first!.jti).not.toBe(second!.jti)
  })

  it('refuses a response without a DPoP-Nonce header', async () => {
    const key = await createDpopKey()
    const { fetch } = mockFetch({ 'POST https://auth.test/oauth/par': () => json({ ok: true }) })
    await expect(dpopRequest(fetch, key, 'https://auth.test/oauth/par', {})).rejects.toMatchObject({
      status: 502,
    })
  })
})

describe('AT Protocol sign-in', () => {
  it('serves the client metadata for the https origin', async () => {
    const app = appOver(testAuth(network().fetch))
    const res = await app.request(`${ORIGIN}/api/auth/atproto/client-metadata.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      client_id: `${ORIGIN}/api/auth/atproto/client-metadata.json`,
      application_type: 'web',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [`${ORIGIN}/api/auth/atproto`],
      scope: 'atproto',
      dpop_bound_access_tokens: true,
      token_endpoint_auth_method: 'none',
      client_name: 'AI Rover',
      client_uri: ORIGIN,
    })
  })

  it('uses the loopback client id for a localhost origin', () => {
    expect(atprotoClient('http://127.0.0.1:3000')).toEqual({
      clientId:
        'http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fauth%2Fatproto&scope=atproto',
      redirectUri: 'http://127.0.0.1:3000/api/auth/atproto',
      loopback: true,
    })
    expect(atprotoClient(ORIGIN)).toEqual({
      clientId: `${ORIGIN}/api/auth/atproto/client-metadata.json`,
      redirectUri: `${ORIGIN}/api/auth/atproto`,
      loopback: false,
    })
  })

  it('moves a localhost start to 127.0.0.1 so the callback finds the flow cookie', async () => {
    const auth = testAuth(network().fetch, 'http://localhost:3000,http://127.0.0.1:3000')
    const app = appOver(auth)
    const res = await app.request(
      'http://localhost:3000/api/auth/atproto?handle=alice.test&redirect=/x',
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'http://127.0.0.1:3000/api/auth/atproto?handle=alice.test&redirect=/x',
    )
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('pushes the authorization request, then redirects with only client_id and request_uri', async () => {
    const mock = network()
    const app = appOver(testAuth(mock.fetch))
    const { res, location } = await start(app)
    expect(location.origin + location.pathname).toBe('https://auth.test/oauth/authorize')
    const clientId = `${ORIGIN}/api/auth/atproto/client-metadata.json`
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: clientId,
      request_uri: 'urn:ietf:params:oauth:request_uri:req-1',
    })

    const pars = mock.calls.filter((call) => call.url === 'https://auth.test/oauth/par')
    expect(pars).toHaveLength(2)
    const form = Object.fromEntries(new URLSearchParams(await pars[1]!.text()))
    expect(form).toEqual({
      client_id: clientId,
      response_type: 'code',
      scope: 'atproto',
      state: expect.stringMatching(/^[\w-]{32,}$/),
      redirect_uri: `${ORIGIN}/api/auth/atproto`,
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: 'S256',
      login_hint: 'alice.test',
    })
    expect(pars[1]!.headers.get('content-type')).toBe('application/x-www-form-urlencoded')

    const flow = await openCookie(setCookies(res)['__Host-rover-oauth']!.value)
    expect(flow).toMatchObject({
      provider: 'atproto',
      state: form.state,
      iss: 'https://auth.test',
      did: DID,
      handle: 'alice.test',
      pds: 'https://pds.test',
      tokenEndpoint: 'https://auth.test/oauth/token',
      nonce: 'n-par',
    })
    expect(await pkceChallenge(flow.verifier as string)).toBe(form.code_challenge)
    expect((flow.verifier as string).length).toBeGreaterThanOrEqual(43)
    const proof = pars[1]!.headers.get('dpop')!
    expect(decodeHeader(proof).jwk).toMatchObject({ x: (flow.dpopKey as { x: string }).x })
  })

  it('refuses an authorization server that does not speak the atproto profile', async () => {
    for (const as of [
      { scopes_supported: ['openid'] },
      { issuer: 'https://evil.test' },
      { pushed_authorization_request_endpoint: 'http://auth.test/par' },
    ]) {
      const app = appOver(testAuth(network({ as }).fetch))
      const res = await app.request(`${ORIGIN}/api/auth/atproto?handle=alice.test`)
      expect({ as, status: res.status }).toEqual({ as, status: 502 })
    }
  })

  it('asks for a handle when none is given', async () => {
    const app = appOver(testAuth(network().fetch))
    expect((await app.request(`${ORIGIN}/api/auth/atproto`)).status).toBe(400)
  })

  async function callback(options: NetworkOptions, query: (state: string) => string) {
    const mock = network(options)
    const app = appOver(testAuth(mock.fetch))
    const { res } = await start(app)
    const flow = await openCookie(setCookies(res)['__Host-rover-oauth']!.value)
    const response = await app.request(
      `${ORIGIN}/api/auth/atproto?${query(flow.state as string)}`,
      { headers: { cookie: cookieHeader(res) } },
    )
    return { response, mock, flow }
  }

  it('refuses a callback from another issuer', async () => {
    const { response, mock } = await callback(
      {},
      (state) => `code=c&state=${state}&iss=${encodeURIComponent('https://evil.test')}`,
    )
    expect(response.status).toBe(400)
    expect(mock.calls.some((call) => call.url.endsWith('/oauth/token'))).toBe(false)
  })

  it('refuses a token response for another account', async () => {
    const { response } = await callback(
      { token: { sub: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' } },
      (state) => `code=c&state=${state}&iss=${encodeURIComponent('https://auth.test')}`,
    )
    expect(response.status).toBe(400)
  })

  it('refuses a token response that is not DPoP-bound or lacks the atproto scope', async () => {
    for (const token of [
      { token_type: 'Bearer' },
      { scope: 'transition:generic' },
      { scope: undefined },
    ]) {
      const { response } = await callback(
        { token },
        (state) => `code=c&state=${state}&iss=${encodeURIComponent('https://auth.test')}`,
      )
      expect({ token, status: response.status }).toEqual({ token, status: 400 })
    }
  })

  it('exchanges the code, signs in by DID and never writes a token to a cookie', async () => {
    const { response, mock, flow } = await callback(
      {},
      (state) => `code=the-code&state=${state}&iss=${encodeURIComponent('https://auth.test')}`,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')

    const token = mock.calls.filter((call) => call.url === 'https://auth.test/oauth/token').at(-1)!
    expect(Object.fromEntries(new URLSearchParams(await token.text()))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: flow.verifier,
      redirect_uri: `${ORIGIN}/api/auth/atproto`,
      client_id: `${ORIGIN}/api/auth/atproto/client-metadata.json`,
    })
    const tokenProof = decodeClaims(token.headers.get('dpop')!)
    expect(tokenProof).toMatchObject({
      htm: 'POST',
      htu: 'https://auth.test/oauth/token',
      nonce: 'n-par',
    })
    expect(tokenProof).not.toHaveProperty('ath')

    const user = await findUserByIdentity(db, { provider: 'atproto', subject: DID })
    expect(user).toMatchObject({
      displayName: 'alice.test',
      handle: 'alice.test',
      avatarUrl: 'https://cdn.test/alice.jpg',
    })

    const cookies = setCookies(response)
    expect(cookies['__Host-rover-oauth']!.value).toBe('')
    const opened = await Promise.all(
      Object.values(cookies)
        .filter((cookie) => cookie.value)
        .map((cookie) => openCookie(cookie.value)),
    )
    expect(opened.length).toBeGreaterThan(0)
    for (const claims of opened) {
      const text = JSON.stringify(claims)
      expect(text).not.toContain('at-secret')
      expect(text).not.toContain('rt-secret')
    }
    expect(opened[0]).toMatchObject({ sub: user!.id, providers: ['atproto'], handle: 'alice.test' })
  })

  it('signs in without an avatar when the public profile does not answer', async () => {
    const mock = network()
    const fetch: typeof globalThis.fetch = (input, init) =>
      String(input instanceof Request ? input.url : input).startsWith('https://public.api.bsky.app')
        ? Promise.reject(new Error('offline'))
        : mock.fetch(input, init)
    const app = appOver(testAuth(fetch))
    const { res } = await start(app)
    const flow = await openCookie(setCookies(res)['__Host-rover-oauth']!.value)
    const response = await app.request(
      `${ORIGIN}/api/auth/atproto?code=c&state=${String(flow.state)}&iss=${encodeURIComponent('https://auth.test')}`,
      { headers: { cookie: cookieHeader(res) } },
    )
    expect(response.status).toBe(302)
  })
})

describe('sign-in failures', () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => logged.mockClear())

  const ISS = encodeURIComponent('https://auth.test')

  async function failedCallback(
    options: { complete?: (result: OAuthResult) => unknown } = {},
    query: (state: string) => string = (state) => `code=c&state=${state}&iss=${ISS}`,
  ) {
    const app = appOver(testAuth(network().fetch), { ...options, redirectErrors: true })
    const { res } = await start(app)
    const flow = await openCookie(setCookies(res)['__Host-rover-oauth']!.value)
    return app.request(`${ORIGIN}/api/auth/atproto?${query(flow.state as string)}`, {
      headers: { cookie: cookieHeader(res) },
    })
  }

  it('redirects a failing sign-in completion with a code, logging the cause', async () => {
    const cause = new Error('relation "user_identity" is locked by secret-host:5432')
    const response = await failedCallback({
      complete: () => {
        throw cause
      },
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login?error=sign-in-failed')
    expect(logged).toHaveBeenCalled()
    expect(logged.mock.calls.flat().some((arg) => arg === cause || arg?.cause === cause)).toBe(true)
  })

  it('names a database failure without its message', async () => {
    const response = await failedCallback({
      complete: () => {
        throw new Error('Failed query', {
          cause: Object.assign(new Error('connection to secret-host refused'), { code: '08006' }),
        })
      },
    })
    expect(response.headers.get('location')).toBe('/login?error=database')
  })

  it('names a callback whose state does not match the sealed one', async () => {
    const response = await failedCallback({}, () => `code=c&state=forged&iss=${ISS}`)
    expect(response.headers.get('location')).toBe('/login?error=state-mismatch')
  })

  it('names an authorization the server refused', async () => {
    const response = await failedCallback(
      {},
      (state) => `error=access_denied&state=${state}&iss=${ISS}`,
    )
    expect(response.headers.get('location')).toBe('/login?error=refused')
  })

  it('names a handle that does not resolve', async () => {
    const app = appOver(testAuth(network().fetch), { redirectErrors: true })
    for (const handle of ['nobody.test', 'not a handle', '']) {
      const response = await app.request(
        `${ORIGIN}/api/auth/atproto?handle=${encodeURIComponent(handle)}`,
      )
      expect({ handle, location: response.headers.get('location') }).toEqual({
        handle,
        location: '/login?error=handle',
      })
    }
  })
})

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(base64Parse(part, { alphabet: 'base64url', returnAs: 'string' }))
}
function decodeHeader(jwt: string) {
  return decodePart(jwt.split('.')[0]!) as { jwk: Record<string, string> }
}
function decodeClaims(jwt: string) {
  return decodePart(jwt.split('.')[1]!)
}
function protectedHeaderJwk(jwt: string) {
  return { ...decodeHeader(jwt).jwk, alg: 'ES256' } as never
}
