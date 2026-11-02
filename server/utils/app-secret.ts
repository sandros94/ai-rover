import { deriveSecret } from 'nuxt/server'
import type { JWK_oct } from 'unjwt/jwk'
import { base64Stringify, hexParse } from 'unsecure/utils'

/** An A256GCM key, asked for when first needed. */
export type SecretKey = () => Promise<JWK_oct<'A256GCM'>>

/**
 * The A256GCM key for `purpose`: the 256 bits Nuxt derives for it from `NUXT_APP_SECRET`
 * (`deriveSecret`, which answers 500 while the secret is unset or under 32 characters). Derived
 * on first call and kept; a failed derivation is not kept, so the next call tries again.
 */
export function appSecretKey(purpose: string): SecretKey {
  let derived: Promise<JWK_oct<'A256GCM'>> | undefined
  return () =>
    (derived ??= deriveSecret(purpose).then(octKey, (error: unknown) => {
      derived = undefined
      throw error
    }))
}

/** 256 bits, hex-encoded, as the `oct` JWK of an A256GCM key. */
export function octKey(hex: string): JWK_oct<'A256GCM'> {
  const bytes = hexParse(hex, { returnAs: 'bytes' })
  return { kty: 'oct', k: base64Stringify(bytes, { alphabet: 'base64url' }), alg: 'A256GCM' }
}
