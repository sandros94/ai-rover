import type { H3Event } from 'nitro/h3'
import { HTTPError } from 'nitro/h3'

export interface OriginPolicy {
  allows(origin: string): boolean
  /** The request's origin when allowed; a 403 otherwise. */
  require(event: H3Event): string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopbackOrigin(origin: string): boolean {
  const url = new URL(origin)
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname)
}

/**
 * The origins OAuth redirects may name, from `NUXT_OAUTH_ORIGINS` (a comma list). Redirect URIs
 * derive from the request, so an unlisted Host header could otherwise steer the provider's
 * callback elsewhere. An empty list in dev allows any loopback origin, whatever the port.
 */
export function originPolicy(list: string, dev: boolean): OriginPolicy {
  const origins = new Set(
    list
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => new URL(entry).origin),
  )
  const allows = (origin: string) =>
    origins.has(origin) || (dev && origins.size === 0 && isLoopbackOrigin(origin))
  return {
    allows,
    require(event) {
      const origin = new URL(event.req.url).origin
      if (!allows(origin)) {
        throw new HTTPError({
          status: 403,
          message: `Sign-in is not offered on ${origin}; list it in NUXT_OAUTH_ORIGINS.`,
        })
      }
      return origin
    },
  }
}

/** A same-origin path to land on after sign-in; anything else lands on `/`. */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048) return '/'
  if (value.startsWith('//') || value.startsWith('/\\')) return '/'
  const url = new URL(value, 'http://path.invalid')
  return url.origin === 'http://path.invalid' ? url.pathname + url.search + url.hash : '/'
}
