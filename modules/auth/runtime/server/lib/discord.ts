import { HTTPError } from 'nitro/h3'
import type { AuthContext } from './context'
import type { CodeFlowProvider, OAuthAppConfig } from './code-flow'
import { createCodeFlowHandler } from './code-flow'
import type { DiscordFlow } from './flow'
import { fetchPublic, readJsonObject } from './http'
import type { OAuthHandlerOptions } from './oauth'
import { pkceChallenge, pkceVerifier } from './random'

export type DiscordConfig = OAuthAppConfig

const AUTHORIZE = 'https://discord.com/oauth2/authorize'
const TOKEN = 'https://discord.com/api/oauth2/token'
const USER = 'https://discord.com/api/users/@me'
const CDN = 'https://cdn.discordapp.com'

export const DISCORD: CodeFlowProvider<DiscordFlow> = {
  provider: 'discord',
  label: 'Discord',
  async authorize({ clientId, redirectUri, state }) {
    const verifier = pkceVerifier()
    const url = new URL(AUTHORIZE)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify',
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString()
    return { url, flow: { verifier } }
  },
  async identify(auth, { clientId, clientSecret, redirectUri, code, flow }) {
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
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: flow.verifier,
        }),
      }),
      'The Discord token response',
    )
    if (typeof token.access_token !== 'string') {
      throw new HTTPError({
        status: 502,
        message: `Discord refused the code: ${typeof token.error === 'string' ? token.error : 'no access token'}.`,
      })
    }

    const response = await fetchPublic(auth.fetch, USER, {
      headers: { accept: 'application/json', authorization: `Bearer ${token.access_token}` },
    })
    if (!response.ok)
      throw new HTTPError({ status: 502, message: 'Discord did not return the profile.' })
    const user = await readJsonObject(response, 'The Discord profile')
    if (
      typeof user.id !== 'string' ||
      !/^\d+$/.test(user.id) ||
      typeof user.username !== 'string'
    ) {
      throw new HTTPError({ status: 502, message: 'The Discord profile has no id or username.' })
    }
    return {
      subject: user.id,
      profile: {
        displayName:
          typeof user.global_name === 'string' && user.global_name.trim()
            ? user.global_name
            : user.username,
        avatarUrl: discordAvatarUrl(user.id, user.avatar, user.discriminator),
        handle: user.username,
      },
    }
  },
}

/**
 * The user's avatar, or the default one Discord shows when they set none: picked from the id
 * for accounts on unique usernames (discriminator `0`), from the discriminator for older ones.
 */
export function discordAvatarUrl(id: string, hash: unknown, discriminator: unknown): string {
  if (typeof hash === 'string' && /^(a_)?[0-9a-f]+$/.test(hash)) {
    return `${CDN}/avatars/${id}/${hash}.png`
  }
  const legacy =
    typeof discriminator === 'string' && /^\d+$/.test(discriminator) && discriminator !== '0'
  const index = legacy ? Number(discriminator) % 5 : Number((BigInt(id) >> 22n) % 6n)
  return `${CDN}/embed/avatars/${index}.png`
}

/** Discord sign-in (see {@link createCodeFlowHandler}), `identify` scope only, with PKCE. */
export function createDiscordHandler(
  auth: AuthContext,
  config: DiscordConfig | (() => DiscordConfig),
  options: OAuthHandlerOptions,
) {
  return createCodeFlowHandler(auth, DISCORD, config, options)
}
