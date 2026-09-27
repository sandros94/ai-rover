import type { H3Event } from 'nitro/h3'
import { deleteCookie, getCookie, setCookie } from 'nitro/h3'
import { decrypt, encrypt } from 'unjwt/jwe'
import type { DpopKey } from './atproto/proof'
import type { SessionKey } from './key'
import { cookieName, sealingOptions } from './session'

export const FLOW_MAX_AGE_SECONDS = 10 * 60

interface FlowBase {
  state: string
  /** Same-origin path to land on after sign-in. */
  redirect: string
  /** The signed-in user the new identity links to, when the flow asked to link. */
  linkTo?: string
}

export interface GitHubFlow extends FlowBase {
  provider: 'github'
}

export interface AtprotoFlow extends FlowBase {
  provider: 'atproto'
  iss: string
  verifier: string
  dpopKey: DpopKey
  did: string
  handle?: string
  pds: string
  tokenEndpoint: string
  nonce?: string
  clientId: string
  redirectUri: string
}

export type FlowState = GitHubFlow | AtprotoFlow

export interface FlowCookie {
  seal(event: H3Event, flow: FlowState): Promise<void>
  /** The sealed flow, consumed: the cookie is deleted whether or not it opened. */
  open(event: H3Event): Promise<FlowState | undefined>
}

/**
 * The in-flight sign-in, sealed with the session key in its own 10-minute cookie. `SameSite=Lax`
 * because the provider returns with a top-level GET from another site.
 */
export function createFlowCookie(key: SessionKey, dev: boolean): FlowCookie {
  const name = cookieName('rover-oauth', dev)
  const attributes = { httpOnly: true, secure: !dev, sameSite: 'lax', path: '/' } as const
  return {
    async seal(event, flow) {
      const sealed = await encrypt(flow as unknown as Record<string, unknown>, await key(), {
        ...sealingOptions().encryptOptions,
        expiresIn: FLOW_MAX_AGE_SECONDS,
      })
      setCookie(event, name, sealed, { ...attributes, maxAge: FLOW_MAX_AGE_SECONDS })
    },
    async open(event) {
      const sealed = getCookie(event, name)
      if (!sealed) return undefined
      deleteCookie(event, name, attributes)
      try {
        const { payload } = await decrypt(sealed, await key(), {
          algorithms: ['dir'],
          encryptionAlgorithms: ['A256GCM'],
        })
        return payload as unknown as FlowState
      } catch {
        return undefined
      }
    },
  }
}
