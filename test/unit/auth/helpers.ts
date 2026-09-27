import { generateJWK } from 'unjwt/jwk'
import { decrypt } from 'unjwt/jwe'
import { createAuthContext } from '~~/modules/auth/runtime/server/lib/context'

/** A fresh production-shaped session key, as `NUXT_SESSION_KEY` carries it. */
export const KEY = JSON.stringify(await generateJWK('A256GCM'))

export const ORIGIN = 'https://rover.test'

export interface SetCookie {
  value: string
  attributes: Record<string, string | true>
}

/** Every Set-Cookie of `response`, by cookie name. */
export function setCookies(response: Response): Record<string, SetCookie> {
  const out: Record<string, SetCookie> = {}
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim())
    const eq = pair!.indexOf('=')
    const attributes: Record<string, string | true> = {}
    for (const attr of attrs) {
      const at = attr.indexOf('=')
      if (at === -1) attributes[attr.toLowerCase()] = true
      else attributes[attr.slice(0, at).toLowerCase()] = attr.slice(at + 1)
    }
    out[pair!.slice(0, eq)] = { value: decodeURIComponent(pair!.slice(eq + 1)), attributes }
  }
  return out
}

/** A Cookie header carrying the live cookies of `responses`, later ones overriding. */
export function cookieHeader(...responses: Response[]): string {
  const jar = new Map<string, string>()
  for (const response of responses) {
    for (const [name, cookie] of Object.entries(setCookies(response))) {
      if (cookie.value === '' || cookie.attributes['max-age'] === '0') jar.delete(name)
      else jar.set(name, cookie.value)
    }
  }
  return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ')
}

/** The claims sealed in a cookie value, decrypted with the test key. */
export async function openCookie(value: string): Promise<Record<string, unknown>> {
  const { payload } = await decrypt(value, JSON.parse(KEY))
  return payload as Record<string, unknown>
}

export type Route = (request: Request) => Response | Promise<Response>

/**
 * A `fetch` answering from `routes`, keyed by `METHOD url-without-query`; unknown requests
 * answer 599 so a test sees exactly which call it did not expect.
 */
export function mockFetch(routes: Record<string, Route>) {
  const calls: Request[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    calls.push(request.clone())
    const url = new URL(request.url)
    const key = `${request.method} ${url.origin}${url.pathname}`
    const route = routes[key]
    return route ? route(request) : new Response(`unexpected ${key}`, { status: 599 })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { ...init, headers })
}

export function testAuth(fetch: typeof globalThis.fetch, origins = ORIGIN) {
  return createAuthContext({ key: KEY, dev: false, origins, fetch })
}
