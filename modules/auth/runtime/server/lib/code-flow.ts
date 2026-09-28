import type { H3Event } from 'nitro/h3'
import { defineHandler, getQuery, HTTPError, redirect } from 'nitro/h3'
import { secureCompare } from 'unsecure/compare'
import type { AuthContext } from './context'
import type { CodeFlowState } from './flow'
import type { OAuthHandlerOptions, OAuthResult } from './oauth'
import { confirmLink, oauthError, startFields, withOAuthErrors } from './oauth'
import { randomToken } from './random'

/** An OAuth app registered with a provider: a confidential client. */
export interface OAuthAppConfig {
  clientId: string
  clientSecret: string
}

/** What differs between the providers signed in through an authorization-code redirect. */
export interface CodeFlowProvider<Flow extends CodeFlowState> {
  provider: Flow['provider']
  /** As the user reads it: "GitHub". */
  label: string
  /** The authorize URL, and the provider's own fields sealed in the flow beside the state. */
  authorize(input: {
    clientId: string
    redirectUri: string
    state: string
  }): Promise<{ url: URL; flow: Omit<Flow, 'provider' | 'state' | 'redirect' | 'linkTo'> }>
  /** Exchanges the code and reads the public profile; no token leaves this call. */
  identify(
    auth: AuthContext,
    input: OAuthAppConfig & { redirectUri: string; code: string; flow: Flow },
  ): Promise<Pick<OAuthResult, 'subject' | 'profile'>>
}

/**
 * `GET` handler for both legs of a code-flow sign-in: without `code` or `error` it redirects to
 * the provider with a fresh state sealed in the flow cookie (`?link` attaches the identity to the
 * signed-in user, `?redirect=` names a same-origin landing path); on the return it verifies the
 * state, then `identify`s the user before `onSuccess`. The redirect URI is the request's own URL,
 * so it must be registered as the app's callback. Answers 404 until the app is configured.
 */
export function createCodeFlowHandler<Flow extends CodeFlowState>(
  auth: AuthContext,
  provider: CodeFlowProvider<Flow>,
  config: OAuthAppConfig | (() => OAuthAppConfig),
  options: OAuthHandlerOptions,
) {
  const resolve = typeof config === 'function' ? config : () => config
  return defineHandler((event) =>
    withOAuthErrors(event, options, async () => {
      const app = resolve()
      if (!app.clientId || !app.clientSecret) {
        throw new HTTPError({
          status: 404,
          message: `${provider.label} sign-in is not configured.`,
        })
      }
      const origin = auth.origins.require(event)
      const redirectUri = `${origin}${new URL(event.req.url).pathname}`
      const query = getQuery(event)
      if (typeof query.code !== 'string' && query.error === undefined) {
        const state = randomToken()
        const fields = await startFields(event, auth, query, state)
        const { url, flow } = await provider.authorize({
          clientId: app.clientId,
          redirectUri,
          state,
        })
        await auth.flow.seal(event, { ...flow, provider: provider.provider, ...fields } as Flow)
        return redirect(url.href, 302)
      }
      const flow = await openFlow(event, auth, provider.provider, query)
      if (typeof query.code !== 'string') {
        throw oauthError('refused', {
          status: 400,
          message: `${provider.label} refused the sign-in: ${String(query.error)}.`,
        })
      }
      const linkTo = await confirmLink(event, auth, flow)
      const proven = await provider.identify(auth, {
        ...app,
        redirectUri,
        code: query.code,
        flow: flow as Flow,
      })
      const result: OAuthResult = {
        provider: provider.provider,
        ...proven,
        linkTo,
        redirect: flow.redirect,
      }
      return options.onSuccess(event, result)
    }),
  )
}

async function openFlow(
  event: H3Event,
  auth: AuthContext,
  provider: CodeFlowState['provider'],
  query: Record<string, unknown>,
) {
  const flow = await auth.flow.open(event)
  if (
    flow?.provider !== provider ||
    !secureCompare(flow.state, typeof query.state === 'string' ? query.state : '')
  ) {
    throw oauthError('state-mismatch', {
      status: 400,
      message: 'The sign-in expired or did not start here; try again.',
    })
  }
  return flow
}
