import type { H3Event } from 'nitro/h3'
import { getQuery, HTTPError } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import type { FlowIntent, FlowResult, ProvenIdentity as ProviderIdentity } from 'unauth/n'
import { isPublicServer, UnauthError } from 'unauth/n'
import type {
  AtprotoClientMetadata,
  AtprotoProfile,
  AtprotoProvider,
} from 'unauth/n/providers/atproto'
import { defineAtprotoHandler, defineAtprotoProvider } from 'unauth/n/providers/atproto'
import type { DiscordProfile } from 'unauth/n/providers/discord'
import { defineDiscordHandler } from 'unauth/n/providers/discord'
import type { GitHubProfile } from 'unauth/n/providers/github'
import { defineGitHubHandler } from 'unauth/n/providers/github'
import type { DB } from '../database/db'
import type { ProvenIdentity } from '../repositories/users'
import type { SecretKey } from './app-secret'
import { appSecretKey } from './app-secret'
import { useDB } from './db'
import type { AuthSessions } from './session'
import { signedInUser, useAuthSessions } from './session'
import { completeSignIn, failSignIn, safeRedirectPath } from './sign-in'

/** An OAuth app registered with a provider: a confidential client. */
export interface OAuthApp {
  clientId: string
  clientSecret: string
}

/** What the sign-in routes reach beyond the request; tests pass their own. */
export interface OAuthSignInContext {
  db: () => DB
  sessions: Pick<AuthSessions, 'use'>
  /** Seals the flow cookie. */
  flowKey: SecretKey
  /**
   * The origins every provider signs in on: the callback is the route on the origin a request
   * came to.
   */
  origins: string[]
  /** The deploy's own addresses besides {@link origins}, where AT Protocol alone signs in. */
  deployOrigins?: string[]
  /** Under `nuxt dev` the flow cookie is `unauth-flow` without `Secure`, for plain-http loopback. */
  dev: boolean
  /**
   * Replaces the global `fetch` for the requests to the provider, and for AT Protocol to what a
   * sign-in resolves and to the public Bluesky profile.
   */
  fetch?: typeof globalThis.fetch
}

/** What a start that asks to link seals for its callback: the user who asked. */
export interface LinkMemo {
  userId: string
}

/** One sign-in route, both legs. */
export type SignInRoute = (event: H3Event) => Promise<unknown>

/**
 * GitHub sign-in on `app`, with the preset's default of no scope: the public profile only. The
 * identity is named by the account's login, with its avatar. See {@link signInHooks} for what the
 * route reads and answers; answers 404 until the client id and secret are set.
 */
export function createGitHubSignIn(app: OAuthApp, context: OAuthSignInContext): SignInRoute {
  if (!isConfigured(app)) return notConfigured('GitHub')
  return defineGitHubHandler({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    ...flowOptions(context),
    ...signInHooks<GitHubProfile>(context, { identity: githubIdentity }),
  })
}

/**
 * Discord sign-in on `app`, with the preset's default `identify` scope only. The identity is named
 * by the display name, else the username, with the avatar or Discord's default one. See
 * {@link signInHooks} for what the route reads and answers; answers 404 until the client id and
 * secret are set.
 */
export function createDiscordSignIn(app: OAuthApp, context: OAuthSignInContext): SignInRoute {
  if (!isConfigured(app)) return notConfigured('Discord')
  return defineDiscordHandler({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    ...flowOptions(context),
    ...signInHooks<DiscordProfile>(context, { identity: discordIdentity }),
  })
}

/** AT Protocol sign-in: both legs on one route, and the client metadata of the origin. */
export interface AtprotoSignIn {
  /**
   * Both legs, on the client of the origin the request came to; any other origin is refused as
   * an untrusted one, the way GitHub and Discord refuse it.
   */
  route: SignInRoute
  /** The client metadata document of the request's origin; 404 where none is published. */
  metadata: (event: H3Event) => AtprotoClientMetadata
}

const ATPROTO_ROUTE = '/api/auth/atproto'
const ATPROTO_METADATA = '/api/auth/atproto/client-metadata.json'

/**
 * AT Protocol sign-in as a public client, sign-in only, with the preset's default `atproto` scope
 * and server policy. The client is the origin's own, built on first use: on an https origin the
 * one whose `client_id` is its {@link ATPROTO_METADATA} document, so each listed origin (a deploy
 * preview too) publishes its own; on a loopback origin the atproto development client, whose
 * callback is on `127.0.0.1` (see {@link atprotoCallbackOrigin}). The account is the `handle`
 * field of the start's form (see {@link signInHooks}, which also names what else the route reads
 * and answers). The identity is named by its verified handle, else its DID, with its public
 * Bluesky avatar when that answers.
 */
export function createAtprotoSignIn(context: OAuthSignInContext): AtprotoSignIn {
  const origins = [...context.origins, ...(context.deployOrigins ?? [])]
  const clients = new Map<string, { provider: AtprotoProvider; route: SignInRoute }>()
  const clientOf = (origin: string) => {
    const callback = atprotoCallbackOrigin(origin, origins)
    if (!callback) return undefined
    let client = clients.get(callback)
    if (!client) {
      const provider = defineAtprotoProvider(atprotoClientConfig(callback, origins))
      const route = defineAtprotoHandler({
        provider,
        ...flowOptions(context),
        ...signInHooks<AtprotoProfile>(context, {
          identity: (identity) => atprotoIdentity(identity, context.fetch),
          loginHint: formHandle,
        }),
      })
      client = { provider, route }
      clients.set(callback, client)
    }
    return client
  }
  return {
    route: (event) => {
      const origin = new URL(event.req.url).origin
      const client = clientOf(origin)
      if (!client) return failSignIn(event, untrustedOrigin(origin), context.sessions)
      return client.route(event)
    },
    metadata: (event) => {
      const document = clientOf(new URL(event.req.url).origin)?.provider.client.metadata
      if (!document) {
        throw new HTTPError({ status: 404, message: 'No AT Protocol client is published here.' })
      }
      return document
    },
  }
}

/**
 * Whether AT Protocol sign-in can run on `origin`: an https origin without a port, the only
 * `client_id` a published client may have, or a plain-http loopback one, for the development
 * client.
 */
export function atprotoServes(origin: string): boolean {
  const url = new URL(origin)
  return (url.protocol === 'https:' && url.port === '') || isLoopbackOrigin(origin)
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopbackOrigin(origin: string): boolean {
  const url = new URL(origin)
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname)
}

/**
 * The origin the AT Protocol callback of `origin` returns to: the origin itself, but `localhost`
 * on `127.0.0.1`, since the atproto profile takes a development client's callback only on a
 * loopback IP. Answers for a listed origin AT Protocol serves, and for the callback origin of
 * one, where the sign-in continues; `undefined` for any other.
 */
function atprotoCallbackOrigin(origin: string, listed: string[]): string | undefined {
  const callback = loopbackIp(origin)
  return listed.some(
    (entry) =>
      atprotoServes(entry) &&
      (entry === origin || (loopbackIp(entry) === callback && callback === origin)),
  )
    ? callback
    : undefined
}

function loopbackIp(origin: string): string {
  if (!isLoopbackOrigin(origin)) return origin
  const url = new URL(origin)
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return url.origin
}

/**
 * The client of the callback origin `callback`. An https one publishes its metadata, named after
 * the app. A loopback one is the development client: every other listed loopback origin
 * returning to it is one of its `devOrigins`, whose sign-ins it moves to `callback` and hands
 * back once complete.
 */
function atprotoClientConfig(callback: string, listed: string[]) {
  if (!isLoopbackOrigin(callback)) {
    return {
      clientId: `${callback}${ATPROTO_METADATA}`,
      redirectUri: `${callback}${ATPROTO_ROUTE}`,
      clientName: 'AI Rover',
      clientUri: callback,
    }
  }
  const devOrigins = listed.filter(
    (entry) => entry !== callback && isLoopbackOrigin(entry) && loopbackIp(entry) === callback,
  )
  return { redirectUri: `${callback}${ATPROTO_ROUTE}`, devOrigins }
}

/** The `ERR_AUTHN_ORIGIN_UNTRUSTED` (421) a provider answers a start on an origin it does not run on. */
function untrustedOrigin(origin: string): UnauthError {
  return new UnauthError(
    'AT Protocol sign-in is not served on this address.',
    'ERR_AUTHN_ORIGIN_UNTRUSTED',
    { status: 421, cause: { origin } },
  )
}

/** The `handle` field of a submitted form; any other start names no account. */
async function formHandle(event: H3Event): Promise<string | undefined> {
  if (event.req.method !== 'POST') return undefined
  const type = event.req.headers.get('content-type') ?? ''
  if (
    !type.startsWith('application/x-www-form-urlencoded') &&
    !type.startsWith('multipart/form-data')
  ) {
    return undefined
  }
  const form = await event.req.formData().catch(() => undefined)
  const handle = form?.get('handle')
  return typeof handle === 'string' && handle.trim() ? handle.trim() : undefined
}

/**
 * An AT Protocol account as the app keeps it: by its DID, named and handled by its verified
 * handle, else named by the DID, with its public Bluesky avatar when that answers.
 */
export async function atprotoIdentity(
  { subject, profile }: ProviderIdentity<AtprotoProfile>,
  fetch?: typeof globalThis.fetch,
): Promise<ProvenIdentity> {
  return {
    provider: 'atproto',
    subject,
    profile: {
      displayName: profile.handle ?? subject,
      avatarUrl: await blueskyAvatar(subject, fetch),
      handle: profile.handle ?? null,
    },
  }
}

const BSKY_PROFILE = 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile'

/**
 * The account's avatar on Bluesky's public AppView, when it answers within 5 s with one on a
 * public https host; `null` otherwise, without failing the sign-in.
 */
export async function blueskyAvatar(
  did: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
  try {
    const url = new URL(BSKY_PROFILE)
    url.searchParams.set('actor', did)
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const avatar = ((await response.json()) as { avatar?: unknown } | null)?.avatar
    return typeof avatar === 'string' && isPublicServer(avatar) ? new URL(avatar).href : null
  } catch {
    return null
  }
}

/** A GitHub account as the app keeps it: named and handled by its login. */
export function githubIdentity({
  subject,
  profile,
  avatar,
}: ProviderIdentity<GitHubProfile>): ProvenIdentity {
  return {
    provider: 'github',
    subject,
    profile: { displayName: profile.login, avatarUrl: avatar ?? null, handle: profile.login },
  }
}

/** A Discord account as the app keeps it: named by its display name, else its username. */
export function discordIdentity({
  subject,
  profile,
}: ProviderIdentity<DiscordProfile>): ProvenIdentity {
  return {
    provider: 'discord',
    subject,
    profile: {
      displayName: profile.global_name?.trim() ? profile.global_name : profile.username,
      avatarUrl: discordAvatarUrl(profile.id, profile.avatar, profile.discriminator),
      handle: profile.username,
    },
  }
}

const DISCORD_CDN = 'https://cdn.discordapp.com'

/**
 * The user's avatar, animated ones as a still, or the default one Discord shows when they set
 * none: picked from the id for accounts on unique usernames (discriminator `0`), from the
 * discriminator for older ones.
 */
export function discordAvatarUrl(id: string, hash: unknown, discriminator: unknown): string {
  if (typeof hash === 'string' && /^(a_)?[0-9a-f]+$/.test(hash)) {
    return `${DISCORD_CDN}/avatars/${id}/${hash}.png`
  }
  const legacy =
    typeof discriminator === 'string' && /^\d+$/.test(discriminator) && discriminator !== '0'
  const index = legacy ? Number(discriminator) % 5 : Number((BigInt(id) >> 22n) % 6n)
  return `${DISCORD_CDN}/embed/avatars/${index}.png`
}

/**
 * The origins of a comma list, each once. The redirect URI derives from the request, so an
 * unlisted Host header could otherwise steer the provider's callback elsewhere.
 */
export function oauthOrigins(list: string): string[] {
  return [
    ...new Set(
      list
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => new URL(entry).origin),
    ),
  ]
}

/**
 * Where sign-in runs, from `runtimeConfig.oauth`, each origin once: every provider on
 * `NUXT_OAUTH_ORIGINS` and the site's main address, AT Protocol on the deploy's own addresses too.
 */
export function signInOrigins(oauth: {
  origins: string
  siteUrl: string
  deployUrls: string
}): Pick<OAuthSignInContext, 'origins' | 'deployOrigins'> {
  const origins = oauthOrigins(`${oauth.origins},${oauth.siteUrl}`)
  const deployOrigins = oauthOrigins(oauth.deployUrls).filter((origin) => !origins.includes(origin))
  return { origins, deployOrigins }
}

/**
 * The flow every provider shares: the flow cookie sealed with the context's key (10 minutes,
 * single use), and the listed origins as the trusted ones: for GitHub and Discord the redirect
 * URI is the route's own URL on whichever of them the request came to, any other origin refused;
 * a form on any of them may start a sign-in that links or names the account.
 */
function flowOptions(context: OAuthSignInContext) {
  return {
    key: context.flowKey,
    trustedOrigins: context.origins,
    cookie: { secure: !context.dev },
    fetch: context.fetch,
  }
}

/** What a provider adds to the hooks every sign-in shares. */
interface SignInHookOptions<Profile> {
  /** The identity as the app keeps it. */
  identity: (identity: ProviderIdentity<Profile>) => ProvenIdentity | Promise<ProvenIdentity>
  /** The account the start names, for a provider that needs one. */
  loginHint?: (event: H3Event) => Promise<string | undefined>
}

/**
 * The hooks every provider shares. A start reads `?redirect=`, a same-origin path to land on, and
 * `?link`, which attaches the identity to the signed-in user: such a start is taken only as a
 * `POST` from the app's own pages, a form, and only while someone is signed in; so is one naming
 * the account (`loginHint`). The callback hands the identity to `completeSignIn`; the provider's
 * tokens go no further. Every failure, the flow's or the sign-in's, lands through `failSignIn`.
 */
function signInHooks<Profile>(context: OAuthSignInContext, options: SignInHookOptions<Profile>) {
  const { sessions } = context
  return {
    onStart: async (event: H3Event): Promise<FlowIntent<LinkMemo>> => {
      const query = getQuery(event)
      const redirect = safeRedirectPath(query.redirect)
      const loginHint = await options.loginHint?.(event)
      const intent: FlowIntent<LinkMemo> = loginHint ? { redirect, loginHint } : { redirect }
      if (query.link === undefined) return intent
      const user = signedInUser(await sessions.use(event))
      if (!user) {
        throw new UnauthError('Sign in before linking an account.', 'ERR_AUTHN_UNAUTHENTICATED', {
          status: 401,
        })
      }
      return { ...intent, memo: { userId: user.id } }
    },
    onSuccess: async (
      event: H3Event,
      { identity, memo, redirect }: FlowResult<Profile, LinkMemo>,
    ) => {
      try {
        return await completeSignIn(
          event,
          { db: context.db(), sessions },
          {
            identity: await options.identity(identity),
            linkTo: memo?.userId,
            redirect: redirect ?? '/',
          },
        )
      } catch (error) {
        return failSignIn(event, error, sessions)
      }
    },
    onError: (event: H3Event, error: UnauthError) => failSignIn(event, error, sessions),
  }
}

/** Whether `app` has both its client id and secret set. */
export function isConfigured(app: OAuthApp): boolean {
  return Boolean(app.clientId && app.clientSecret)
}

function notConfigured(label: string): SignInRoute {
  return () => {
    throw new HTTPError({ status: 404, message: `${label} sign-in is not configured.` })
  }
}

let platform: OAuthSignInContext | undefined

/**
 * The server's context: the platform database and sessions, the flow cookie sealed with the key
 * Nuxt derives from `NUXT_APP_SECRET` for `ai-rover:flow`, and `NUXT_OAUTH_ORIGINS`.
 */
function useOAuthSignInContext(): OAuthSignInContext {
  return (platform ??= {
    db: useDB,
    sessions: useAuthSessions(),
    flowKey: appSecretKey('ai-rover:flow'),
    ...signInOrigins(useRuntimeConfig().oauth),
    dev: Boolean(import.meta.dev),
  })
}

let github: SignInRoute | undefined
let discord: SignInRoute | undefined
let atproto: AtprotoSignIn | undefined

/** The server's GitHub sign-in, on `runtimeConfig.oauth.github`; built on first use. */
export function useGitHubSignIn(): SignInRoute {
  return (github ??= createGitHubSignIn(useRuntimeConfig().oauth.github, useOAuthSignInContext()))
}

/** The server's Discord sign-in, on `runtimeConfig.oauth.discord`; built on first use. */
export function useDiscordSignIn(): SignInRoute {
  return (discord ??= createDiscordSignIn(
    useRuntimeConfig().oauth.discord,
    useOAuthSignInContext(),
  ))
}

/** The server's AT Protocol sign-in; built on first use. */
export function useAtprotoSignIn(): AtprotoSignIn {
  return (atproto ??= createAtprotoSignIn(useOAuthSignInContext()))
}
