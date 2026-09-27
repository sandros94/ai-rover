import {
  addImports,
  addPlugin,
  addRouteMiddleware,
  addServerHandler,
  addServerImports,
  addServerPlugin,
  createResolver,
  defineNuxtModule,
} from 'nuxt/kit'

const SERVER_UTILS = [
  'getUserSession',
  'setUserSession',
  'replaceUserSession',
  'clearUserSession',
  'requireUserSession',
  'defineOAuthGitHubEventHandler',
  'defineOAuthAtprotoEventHandler',
]

/**
 * Sessions and sign-in: a JWE cookie session, GitHub OAuth and AT Protocol OAuth (public client),
 * with server utils, the `useUserSession()` composable, an `authenticated` route middleware and
 * the types at `#auth`. The sign-in routes themselves are the app's: it mounts the
 * `defineOAuth…EventHandler`s and decides in `onSuccess` which user an identity belongs to.
 * Configured through `runtimeConfig.sessionKey` and `runtimeConfig.oauth`.
 */
export default defineNuxtModule({
  meta: { name: 'rover-auth' },
  setup(_options, nuxt) {
    const resolver = createResolver(import.meta.url)

    nuxt.options.alias['#auth'] = resolver.resolve('./runtime/types')

    const utils = resolver.resolve('./runtime/server/utils/auth')
    addServerImports(SERVER_UTILS.map((name) => ({ name, from: utils })))
    addServerPlugin(resolver.resolve('./runtime/server/plugins/key'))

    const routes = resolver.resolve('./runtime/server/routes')
    addServerHandler({
      route: '/api/_auth/session',
      method: 'get',
      handler: `${routes}/session.get`,
    })
    addServerHandler({
      route: '/api/_auth/session',
      method: 'delete',
      handler: `${routes}/session.delete`,
    })
    addServerHandler({
      route: '/api/auth/providers',
      method: 'get',
      handler: `${routes}/providers.get`,
    })
    addServerHandler({
      route: '/api/auth/atproto/client-metadata.json',
      method: 'get',
      handler: `${routes}/client-metadata.get`,
    })

    addImports({
      name: 'useUserSession',
      from: resolver.resolve('./runtime/app/composables/useUserSession'),
    })
    addPlugin(resolver.resolve('./runtime/app/plugins/session.server'))
    addPlugin(resolver.resolve('./runtime/app/plugins/session.client'))
    addRouteMiddleware({
      name: 'authenticated',
      path: resolver.resolve('./runtime/app/middleware/authenticated'),
    })
  },
})
