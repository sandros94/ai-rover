import { HTTPError } from 'nitro/h3'
import type { JWK_EC_Private, JWK_EC_Public } from 'unjwt/jwk'
import { generateJWK } from 'unjwt/jwk'
import { sign } from 'unjwt/jws'
import { hash } from 'unsecure/hash'
import { fetchPublic, readJsonObject } from '../http'
import { randomToken } from '../random'

export type DpopKey = JWK_EC_Private<'ES256'>

/** RFC 7636 `S256`: base64url of the SHA-256 of the verifier. */
export function pkceChallenge(verifier: string): Promise<string> {
  return hash(verifier, { algorithm: 'SHA-256', returnAs: 'base64url' })
}

/** A fresh ES256 key for one sign-in flow; it binds the flow's tokens and dies with them. */
export async function createDpopKey(): Promise<DpopKey> {
  const { privateKey } = await generateJWK('ES256')
  const { kty, crv, x, y, d } = privateKey
  return { kty, crv, x, y, d, alg: 'ES256' }
}

export function dpopPublicJwk({ kty, crv, x, y }: DpopKey): JWK_EC_Public {
  return { kty, crv, x, y }
}

/**
 * An RFC 9449 proof for one request. `htu` drops the query and fragment as the RFC requires.
 * Token-endpoint proofs carry no `ath`: that claim binds an access token, and none exists yet.
 */
export function dpopProof(
  key: DpopKey,
  { htm, htu, nonce }: { htm: string; htu: string; nonce?: string },
): Promise<string> {
  const url = new URL(htu)
  return sign(
    {
      jti: randomToken(),
      htm,
      htu: url.origin + url.pathname,
      iat: Math.floor(Date.now() / 1000),
      ...(nonce && { nonce }),
    },
    key,
    { alg: 'ES256', protectedHeader: { typ: 'dpop+jwt', jwk: dpopPublicJwk(key) } },
  )
}

export interface DpopResult {
  body: Record<string, unknown>
  /** The server's latest nonce, for the next request to the same server. */
  nonce: string
}

/**
 * A form POST to an authorization server with a DPoP proof, retried once when the server asks
 * for a (new) nonce. atproto servers must send `DPoP-Nonce` on every DPoP response, so an answer
 * without one is refused.
 */
export async function dpopRequest(
  fetch: typeof globalThis.fetch,
  key: DpopKey,
  url: string,
  form: Record<string, string>,
  nonce?: string,
): Promise<DpopResult> {
  let current = nonce
  for (let attempt = 0; ; attempt++) {
    const response = await fetchPublic(fetch, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'application/json',
        'dpop': await dpopProof(key, { htm: 'POST', htu: url, nonce: current }),
      },
      body: new URLSearchParams(form).toString(),
    })
    const next = response.headers.get('dpop-nonce') ?? undefined
    const body = await readJsonObject(response, `The answer of ${url}`)
    if (
      attempt === 0 &&
      (response.status === 400 || response.status === 401) &&
      next &&
      (body.error === 'use_dpop_nonce' ||
        response.headers.get('www-authenticate')?.includes('use_dpop_nonce'))
    ) {
      current = next
      continue
    }
    if (!response.ok) {
      throw new HTTPError({
        status: 502,
        message: `${new URL(url).origin} refused the request: ${typeof body.error === 'string' ? body.error : response.status}.`,
      })
    }
    if (!next) {
      throw new HTTPError({ status: 502, message: `${new URL(url).origin} sent no DPoP nonce.` })
    }
    return { body, nonce: next }
  }
}
