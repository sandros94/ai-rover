import type { H3Event } from 'nitro/h3'
import { HTTPError } from 'nitro/h3'
import type { AuthProvider } from '../../types'
import type { AuthContext } from './context'
import type { FlowState } from './flow'
import { safeRedirectPath } from './origins'

/** A proven identity, handed to `onSuccess`; no provider token survives to this point. */
export interface OAuthResult {
  provider: AuthProvider
  /** The provider's durable account id: GitHub's numeric id, an atproto DID. */
  subject: string
  profile: { displayName: string; avatarUrl?: string; handle?: string }
  /** The signed-in user to attach the identity to, when the flow asked to link. */
  linkTo?: string
  /** Same-origin path the sign-in asked to land on. */
  redirect: string
}

export interface OAuthHandlerOptions {
  onSuccess(event: H3Event, result: OAuthResult): unknown
  /** Answers a failed sign-in; without it the error propagates as the response. */
  onError?(event: H3Event, error: HTTPError): unknown
}

/** The flow fields every provider records at the start: state, landing path, link intent. */
export async function startFields(
  event: H3Event,
  auth: AuthContext,
  query: Record<string, unknown>,
  state: string,
) {
  let linkTo: string | undefined
  if (query.link === '1') {
    linkTo = (await auth.sessions.get(event)).user?.id
    if (!linkTo) throw new HTTPError({ status: 401, message: 'Sign in before linking an account.' })
  }
  return { state, redirect: safeRedirectPath(query.redirect), linkTo }
}

/** A link intent holds only while the same user is still signed in. */
export async function confirmLink(event: H3Event, auth: AuthContext, flow: FlowState) {
  if (!flow.linkTo) return undefined
  const current = (await auth.sessions.get(event)).user?.id
  if (current !== flow.linkTo) {
    throw new HTTPError({ status: 409, message: 'The signed-in user changed during linking.' })
  }
  return flow.linkTo
}

export async function withOAuthErrors(
  event: H3Event,
  options: OAuthHandlerOptions,
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await run()
  } catch (error) {
    if (!options.onError) throw error
    const httpError =
      error instanceof HTTPError
        ? error
        : new HTTPError({ status: 500, message: 'Sign-in failed.', cause: error })
    return options.onError(event, httpError)
  }
}
