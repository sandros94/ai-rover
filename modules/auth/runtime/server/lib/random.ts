import { secureGenerate } from 'unsecure/generate'

/** URL-safe random token of ~258 bits for `state` values and DPoP `jti`s. */
export function randomToken(): string {
  return secureGenerate({ length: 43, specials: '-_' })
}

/** PKCE verifier: 64 characters of the RFC 7636 unreserved set (~390 bits). */
export function pkceVerifier(): string {
  return secureGenerate({ length: 64, specials: '-._~' })
}
