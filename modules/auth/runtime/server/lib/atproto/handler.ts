import type { H3Event } from 'nitro/h3'
import { defineHandler, getQuery, HTTPError, redirect } from 'nitro/h3'
import { secureCompare } from 'unsecure/compare'
import type { AuthContext } from '../context'
import type { AtprotoFlow } from '../flow'
import { fetchPublic, publicHttpsUrl, readJsonObject } from '../http'
import type { OAuthHandlerOptions, OAuthResult } from '../oauth'
import { confirmLink, oauthError, startFields, withOAuthErrors } from '../oauth'
import { isLoopbackOrigin } from '../origins'
import { pkceVerifier, randomToken } from '../random'
import { resolveIdentity } from './identity'
import { createDpopKey, dpopRequest, pkceChallenge } from './proof'

export const ATPROTO_CALLBACK_PATH = '/api/auth/atproto'
export const ATPROTO_METADATA_PATH = '/api/auth/atproto/client-metadata.json'
const SCOPE = 'atproto'
const PROFILE = 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile'

export interface AtprotoClient {
  clientId: string
  redirectUri: string
  /** The spec's development client: `http://localhost` id, `127.0.0.1` callback, no document. */
  loopback: boolean
}

/**
 * The public client for `origin`. An https origin publishes its metadata document; a loopback
 * origin uses the virtual `http://localhost` client, whose callback must be an IP loopback.
 */
export function atprotoClient(origin: string): AtprotoClient {
  if (isLoopbackOrigin(origin)) {
    const url = new URL(origin)
    const redirectUri = `http://127.0.0.1${url.port ? `:${url.port}` : ''}${ATPROTO_CALLBACK_PATH}`
    const query = new URLSearchParams({ redirect_uri: redirectUri, scope: SCOPE })
    return { clientId: `http://localhost?${query}`, redirectUri, loopback: true }
  }
  if (!origin.startsWith('https://')) {
    throw new HTTPError({ status: 404, message: 'AT Protocol sign-in needs an https origin.' })
  }
  return {
    clientId: `${origin}${ATPROTO_METADATA_PATH}`,
    redirectUri: `${origin}${ATPROTO_CALLBACK_PATH}`,
    loopback: false,
  }
}

/** `GET` handler serving the client metadata document the authorization servers fetch. */
export function createClientMetadataHandler(auth: AuthContext) {
  return defineHandler((event) => {
    const origin = auth.origins.require(event)
    const client = atprotoClient(origin)
    if (client.loopback) {
      throw new HTTPError({
        status: 404,
        message: `Loopback origins use the virtual client ${client.clientId}; no document is published.`,
      })
    }
    return {
      client_id: client.clientId,
      application_type: 'web',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [client.redirectUri],
      scope: SCOPE,
      dpop_bound_access_tokens: true,
      token_endpoint_auth_method: 'none',
      client_name: 'Jev Rover',
      client_uri: origin,
    }
  })
}

/**
 * `GET` handler for both legs of AT Protocol sign-in, as a login-only public client. Without
 * `code` it resolves `?handle=` (a handle or DID), discovers the account's authorization server,
 * pushes the request (PAR + PKCE + DPoP) and redirects; the flow, including the one-off DPoP
 * key, is sealed in the flow cookie. With `code` it checks state and issuer, exchanges the code
 * and accepts the account only when the token names the DID resolved at the start. The tokens
 * are then dropped: signing in is all they were for.
 */
export function createAtprotoHandler(auth: AuthContext, options: OAuthHandlerOptions) {
  return defineHandler((event) =>
    withOAuthErrors(event, options, async () => {
      const origin = auth.origins.require(event)
      const query = getQuery(event)
      if (typeof query.code === 'string' || typeof query.error === 'string') {
        return options.onSuccess(event, await callback(event, auth, query))
      }
      return start(event, auth, origin, query)
    }),
  )
}

async function start(
  event: H3Event,
  auth: AuthContext,
  origin: string,
  query: Record<string, unknown>,
) {
  const client = atprotoClient(origin)
  const url = new URL(event.req.url)
  // The flow cookie must be set on the host the callback returns to.
  if (client.loopback && url.hostname !== '127.0.0.1') {
    const target = new URL(client.redirectUri)
    target.search = url.search
    if (!auth.origins.allows(target.origin)) {
      throw new HTTPError({ status: 403, message: `List ${target.origin} in NUXT_OAUTH_ORIGINS.` })
    }
    return redirect(target.href, 302)
  }
  if (typeof query.handle !== 'string' || !query.handle.trim()) {
    throw oauthError('handle', {
      status: 400,
      message: 'Name the account: ?handle=<handle or DID>.',
    })
  }
  const loginHint = query.handle.trim()
  const fields = await startFields(event, auth, query, randomToken())
  const identity = await resolveIdentity(loginHint, auth.fetch).catch((error: unknown) => {
    // Resolution answers 400 exactly when the identifier leads to no usable account.
    if (error instanceof HTTPError && error.status === 400) {
      throw oauthError('handle', { status: 400, message: error.message, cause: error })
    }
    throw error
  })
  const server = await discoverAuthorizationServer(auth.fetch, identity.pds)

  const verifier = pkceVerifier()
  const dpopKey = await createDpopKey()
  const par = await dpopRequest(auth.fetch, dpopKey, server.parEndpoint, {
    client_id: client.clientId,
    response_type: 'code',
    scope: SCOPE,
    state: fields.state,
    redirect_uri: client.redirectUri,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    login_hint: loginHint,
  })
  if (typeof par.body.request_uri !== 'string') {
    throw new HTTPError({
      status: 502,
      message: 'The authorization server returned no request_uri.',
    })
  }

  const flow: AtprotoFlow = {
    provider: 'atproto',
    ...fields,
    iss: server.issuer,
    verifier,
    dpopKey,
    did: identity.did,
    handle: identity.handle,
    pds: identity.pds,
    tokenEndpoint: server.tokenEndpoint,
    nonce: par.nonce,
    clientId: client.clientId,
    redirectUri: client.redirectUri,
  }
  await auth.flow.seal(event, flow)

  const authorize = new URL(server.authorizationEndpoint)
  authorize.search = new URLSearchParams({
    client_id: client.clientId,
    request_uri: par.body.request_uri,
  }).toString()
  return redirect(authorize.href, 302)
}

async function callback(
  event: H3Event,
  auth: AuthContext,
  query: Record<string, unknown>,
): Promise<OAuthResult> {
  const flow = await auth.flow.open(event)
  if (
    flow?.provider !== 'atproto' ||
    !secureCompare(flow.state, typeof query.state === 'string' ? query.state : '')
  ) {
    throw oauthError('state-mismatch', {
      status: 400,
      message: 'The sign-in expired or did not start here; try again.',
    })
  }
  if (query.iss !== flow.iss) {
    throw new HTTPError({
      status: 400,
      message: 'The callback came from another authorization server.',
    })
  }
  if (typeof query.code !== 'string') {
    throw oauthError('refused', {
      status: 400,
      message: `The sign-in was refused: ${String(query.error)}.`,
    })
  }
  const linkTo = await confirmLink(event, auth, flow)

  const { body: token } = await dpopRequest(
    auth.fetch,
    flow.dpopKey,
    flow.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code: query.code,
      code_verifier: flow.verifier,
      redirect_uri: flow.redirectUri,
      client_id: flow.clientId,
    },
    flow.nonce,
  )
  const scopes = typeof token.scope === 'string' ? token.scope.split(' ') : []
  if (String(token.token_type).toLowerCase() !== 'dpop' || !scopes.includes(SCOPE)) {
    throw new HTTPError({ status: 400, message: 'The token is not a DPoP-bound atproto grant.' })
  }
  if (token.sub !== flow.did) {
    throw new HTTPError({
      status: 400,
      message: `The server signed in ${String(token.sub)}, not ${flow.did}.`,
    })
  }

  return {
    provider: 'atproto',
    subject: flow.did,
    profile: {
      displayName: flow.handle ?? flow.did,
      handle: flow.handle,
      avatarUrl: await publicAvatar(auth.fetch, flow.did),
    },
    linkTo,
    redirect: flow.redirect,
  }
}

interface AuthorizationServer {
  issuer: string
  authorizationEndpoint: string
  parEndpoint: string
  tokenEndpoint: string
}

/** PDS → its single authorization server, whose metadata must match the atproto profile. */
async function discoverAuthorizationServer(
  fetch: typeof globalThis.fetch,
  pds: string,
): Promise<AuthorizationServer> {
  const resource = await metadata(fetch, `${pds}/.well-known/oauth-protected-resource`)
  const servers = resource.authorization_servers
  if (!Array.isArray(servers) || typeof servers[0] !== 'string') {
    throw new HTTPError({ status: 502, message: `${pds} names no authorization server.` })
  }
  const issuer = publicHttpsUrl(servers[0], 502)
  if (issuer.href !== `${issuer.origin}/`) {
    throw new HTTPError({ status: 502, message: `${servers[0]} is not an origin.` })
  }
  const server = await metadata(fetch, `${issuer.origin}/.well-known/oauth-authorization-server`)
  const includes = (field: string, value: string) =>
    Array.isArray(server[field]) && (server[field] as unknown[]).includes(value)
  const endpoint = (field: string) => {
    if (typeof server[field] !== 'string') {
      throw new HTTPError({ status: 502, message: `${issuer.origin} declares no ${field}.` })
    }
    return publicHttpsUrl(server[field], 502).href
  }
  if (
    server.issuer !== issuer.origin ||
    !includes('scopes_supported', SCOPE) ||
    !includes('code_challenge_methods_supported', 'S256') ||
    !includes('dpop_signing_alg_values_supported', 'ES256')
  ) {
    throw new HTTPError({
      status: 502,
      message: `${issuer.origin} is not an atproto authorization server for ${pds}.`,
    })
  }
  return {
    issuer: issuer.origin,
    authorizationEndpoint: endpoint('authorization_endpoint'),
    parEndpoint: endpoint('pushed_authorization_request_endpoint'),
    tokenEndpoint: endpoint('token_endpoint'),
  }
}

async function metadata(fetch: typeof globalThis.fetch, url: string) {
  const response = await fetchPublic(fetch, url, { headers: { accept: 'application/json' } })
  if (response.status !== 200) {
    throw new HTTPError({ status: 502, message: `${url} answered ${response.status}.` })
  }
  return readJsonObject(response, url)
}

/** The public Bluesky avatar, if the AppView answers within 5 s; sign-in never waits on it. */
async function publicAvatar(fetch: typeof globalThis.fetch, did: string) {
  try {
    const url = new URL(PROFILE)
    url.searchParams.set('actor', did)
    const response = await fetchPublic(fetch, url, { timeoutMs: 5000 })
    if (!response.ok) return undefined
    const { avatar } = await readJsonObject(response, 'The public profile')
    return typeof avatar === 'string' ? publicHttpsUrl(avatar).href : undefined
  } catch {
    return undefined
  }
}
