import { HTTPError } from 'nitro/h3'
import type { AuthContext } from './context'
import type { CodeFlowProvider, OAuthAppConfig } from './code-flow'
import { createCodeFlowHandler } from './code-flow'
import type { GitHubFlow } from './flow'
import { fetchPublic, readJsonObject } from './http'
import type { OAuthHandlerOptions } from './oauth'

export type GitHubConfig = OAuthAppConfig

const AUTHORIZE = 'https://github.com/login/oauth/authorize'
const TOKEN = 'https://github.com/login/oauth/access_token'
const USER = 'https://api.github.com/user'

export const GITHUB: CodeFlowProvider<GitHubFlow> = {
  provider: 'github',
  label: 'GitHub',
  async authorize({ clientId, redirectUri, state }) {
    const url = new URL(AUTHORIZE)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: '',
      allow_signup: 'true',
    }).toString()
    return { url, flow: {} }
  },
  async identify(auth, { clientId, clientSecret, redirectUri, code }) {
    const token = await readJsonObject(
      await fetchPublic(auth.fetch, TOKEN, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
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
      subject: String(user.id),
      profile: {
        displayName: user.login,
        avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : undefined,
        handle: user.login,
      },
    }
  },
}

/** GitHub sign-in (see {@link createCodeFlowHandler}), with no scope: the public profile only. */
export function createGitHubHandler(
  auth: AuthContext,
  config: GitHubConfig | (() => GitHubConfig),
  options: OAuthHandlerOptions,
) {
  return createCodeFlowHandler(auth, GITHUB, config, options)
}
