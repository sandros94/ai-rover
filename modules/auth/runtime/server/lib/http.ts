import { HTTPError } from 'nitro/h3'

export const TIMEOUT_MS = 10_000
const MAX_BYTES = 256 * 1024

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.onion']

/**
 * `value` as a URL safe to fetch from the server: https, no credentials, and a public DNS name.
 * IP literals and private names are refused outright; a public name resolving to a private
 * address is not caught here, because the runtime's `fetch` exposes no resolution hook.
 */
export function publicHttpsUrl(value: string | URL, status = 400): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HTTPError({ status, message: `"${String(value)}" is not a URL.` })
  }
  const host = url.hostname.toLowerCase()
  const refusal =
    url.protocol !== 'https:'
      ? 'is not https'
      : url.username || url.password
        ? 'carries credentials'
        : host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)
          ? 'names an IP address'
          : !host.includes('.') ||
              host === 'localhost' ||
              PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
            ? 'names a private host'
            : undefined
  if (refusal)
    throw new HTTPError({ status, message: `Refused to fetch ${url.origin}: it ${refusal}.` })
  return url
}

export interface PublicFetchOptions extends RequestInit {
  /** Status of the HTTPError raised when the target is refused or does not answer. */
  status?: number
  timeoutMs?: number
}

/**
 * One request to a URL named by a third party: checked by `publicHttpsUrl`, bounded in time,
 * never following redirects (the atproto metadata documents must answer 200 directly).
 */
export async function fetchPublic(
  fetch: typeof globalThis.fetch,
  target: string | URL,
  { status = 502, timeoutMs = TIMEOUT_MS, ...init }: PublicFetchOptions = {},
): Promise<Response> {
  const url = publicHttpsUrl(target, status)
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new HTTPError({ status: 502, message: `${url.origin} did not answer.`, cause: error })
  }
}

/** The body as JSON, refusing bodies over 256 KiB and non-object documents. */
export async function readJsonObject(
  response: Response,
  what: string,
  status = 502,
): Promise<Record<string, unknown>> {
  const text = await readCapped(response, what, status)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new HTTPError({ status, message: `${what} is not JSON.` })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HTTPError({ status, message: `${what} is not a JSON object.` })
  }
  return body as Record<string, unknown>
}

export async function readCapped(response: Response, what: string, status = 502): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) {
    throw new HTTPError({ status, message: `${what} is too large.` })
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new HTTPError({ status, message: `${what} is too large.` })
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
