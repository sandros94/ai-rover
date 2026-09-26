import type { JWK_oct } from 'unjwt/jwk'
import { hkdf } from 'unsecure/hkdf'
import { base64Parse } from 'unsecure/utils'

export type SessionKey = () => Promise<JWK_oct<'A256GCM'>>

const DEV_SEED = 'jev-rover development session key'

let warned = false

/**
 * The key sealing the session and flow cookies: `NUXT_SESSION_KEY`, the JSON of a 256-bit `oct`
 * JWK. Validated when called, so a misconfigured server refuses at startup rather than on the
 * first sign-in. Under `nuxt dev` an empty key yields one derived from a fixed seed, identical
 * across restarts so sessions survive them; it is public, hence never used outside dev.
 */
export function sessionKey(raw: string, dev: boolean): SessionKey {
  if (raw.trim()) {
    const jwk = parseKey(raw)
    return () => Promise.resolve(jwk)
  }
  if (!dev) {
    throw new Error(
      "NUXT_SESSION_KEY is empty. Generate one with: node -e \"import('unjwt/jwk').then(async ({ generateJWK }) => console.log(JSON.stringify(await generateJWK('A256GCM'))))\"",
    )
  }
  if (!warned) {
    warned = true
    console.warn(
      '[auth] NUXT_SESSION_KEY is empty; using the public development key. Sessions signed with it are forgeable.',
    )
  }
  let derived: Promise<JWK_oct<'A256GCM'>> | undefined
  return () =>
    (derived ??= hkdf(DEV_SEED, { length: 32, info: 'jev-session', returnAs: 'base64url' }).then(
      (k): JWK_oct<'A256GCM'> => ({ kty: 'oct', k, alg: 'A256GCM' }),
    ))
}

function parseKey(raw: string): JWK_oct<'A256GCM'> {
  let jwk: unknown
  try {
    jwk = JSON.parse(raw)
  } catch {
    throw new Error('NUXT_SESSION_KEY must be the JSON of an oct JWK for A256GCM.')
  }
  const candidate = jwk as Partial<JWK_oct> | null
  if (
    candidate?.kty !== 'oct' ||
    typeof candidate.k !== 'string' ||
    (candidate.alg !== undefined && candidate.alg !== 'A256GCM') ||
    keyBytes(candidate.k) !== 32
  ) {
    throw new Error('NUXT_SESSION_KEY must be an oct JWK holding 256 bits for A256GCM.')
  }
  return { kty: 'oct', k: candidate.k, alg: 'A256GCM' }
}

function keyBytes(k: string): number {
  try {
    return base64Parse(k, { alphabet: 'base64url', returnAs: 'bytes' }).length
  } catch {
    return -1
  }
}
