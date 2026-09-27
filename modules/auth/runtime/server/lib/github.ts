import type { H3Event } from 'nitro/h3'
import { defineHandler, getQuery, HTTPError, redirect } from 'nitro/h3'
import { secureCompare } from 'unsecure/compare'
import type { AuthContext } from './context'
import { fetchPublic, readJsonObject } from './http'
import type { OAuthHandlerOptions } from './oauth'
import { confirmLink, oauthError, startFields, withOAuthErrors } from './oauth'
import { randomToken } from './random'

export interface GitHubConfig {
  clientId: string
  clientSecret: string
}

const AUTHORIZE = 'https://github.com/login/oauth/authorize'
const TOKEN = 'https://github.com/login/oauth/access_token'
const USER = 'https://api.github.com/user'

/**
 * `GET` handler for both legs of GitHub sign-in: without `code` it redirects to GitHub with a
 * fresh state sealed in the flow cookie (`?link=1` attaches the identity to the signed-in user,
 * `?redirect=` names a same-origin landing path); with `code` it verifies the state, exchanges
 * the code, reads the public profile and drops the token before `onSuccess`. The redirect URI
 * is the request's own URL, so it must be registered as the OAuth app's callback.
 */
export function createGitHubHandler(
  auth: AuthContext,
  config: GitHubConfig | (() => GitHubConfig),
  options: OAuthHandlerOptions,
) {
  const resolve = typeof config === 'function' ? config : () => config
  return defineHandler((event) =>
    withOAuthErrors(event, options, async () => {
      const { clientId, clientSecret } = resolve()
      if (!clientId || !clientSecret) {
        throw new HTTPError({ status: 404, message: 'GitHub sign-in is not configured.' })
      }
      const origin = auth.origins.require(event)
      const redirectUri = `${origin}${new URL(event.req.url).pathname}`
      const query = getQuery(event)
      if (typeof query.code !== 'string') {
        return start(event, auth, { clientId, redirectUri }, query)
      }
      return options.onSuccess(
        event,
        await callback(event, auth, { clientId, clientSecret, redirectUri }, query),
      )
    }),
  )
}

async function start(
  event: H3Event,
  auth: AuthContext,
  { clientId, redirectUri }: { clientId: string; redirectUri: string },
  query: Record<string, unknown>,
) {
  const fields = await startFields(event, auth, query, randomToken())
  await auth.flow.seal(event, { provider: 'github', ...fields })
  const url = new URL(AUTHORIZE)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: fields.state,
    scope: '',
    allow_signup: 'true',
  }).toString()
  return redirect(url.href, 302)
}

async function callback(
  event: H3Event,
  auth: AuthContext,
  config: GitHubConfig & { redirectUri: string },
  query: Record<string, unknown>,
) {
  const flow = await auth.flow.open(event)
  if (
    flow?.provider !== 'github' ||
    !secureCompare(flow.state, typeof query.state === 'string' ? query.state : '')
  ) {
    throw oauthError('state-mismatch', {
      status: 400,
      message: 'The sign-in expired or did not start here; try again.',
    })
  }
  const linkTo = await confirmLink(event, auth, flow)

  const token = await readJsonObject(
    await fetchPublic(auth.fetch, TOKEN, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: String(query.code),
        redirect_uri: config.redirectUri,
      }),
    }),
    'The GitHub token response',
  )
  if (typeof token.access_token !== 'string') {
    throw new HTTPError({
      status: 502,
      message: `GitHub refused the code: ${typeof token.error === 'string' ? token.error : 'no access token'}.`,
    })
  }

  const response = await fetchPublic(auth.fetch, USER, {
    headers: {
      'accept': 'application/vnd.github+json',
      'authorization': `Bearer ${token.access_token}`,
      'user-agent': 'ai-rover',
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!response.ok)
    throw new HTTPError({ status: 502, message: 'GitHub did not return the profile.' })
  const user = await readJsonObject(response, 'The GitHub profile')
  if (typeof user.id !== 'number' || typeof user.login !== 'string') {
    throw new HTTPError({ status: 502, message: 'The GitHub profile has no id or login.' })
  }
  return {
    provider: 'github' as const,
    subject: String(user.id),
    profile: {
      displayName: typeof user.name === 'string' && user.name.trim() ? user.name : user.login,
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : undefined,
      handle: user.login,
    },
    linkTo,
    redirect: flow.redirect,
  }
}
