import type { PGliteSocketAction } from 'nuxt-pglite'
import { addServerHandler, createResolver, defineNuxtModule, extendPages } from 'nuxt/kit'
import type { Nuxt } from 'nuxt/schema'

/** Development-only API routes under `/api/_dev`, by path, method and runtime file. */
const API_ROUTES = [
  { route: '/api/_dev/disk', method: 'get', file: 'disk.get' },
  { route: '/api/_dev/publish', method: 'post', file: 'publish.post' },
  { route: '/api/_dev/login', method: 'post', file: 'login.post' },
  { route: '/api/_dev/seed', method: 'post', file: 'seed.post' },
  { route: '/api/_dev/journey/clear', method: 'post', file: 'journey/clear.post' },
  { route: '/api/_dev/fixtures', method: 'get', file: 'fixtures.get' },
  { route: '/api/_dev/fixtures/:name', method: 'get', file: 'fixture.get' },
] as const

/**
 * Everything that exists only under `nuxt dev`, registered after the dev check so no other build
 * bundles it: the `/api/_dev` routes (seeding a mission, clearing the local journey store, a dev
 * sign-in, the disk and publish smokes, the fixtures), the "Seed mission" and "Clear journey
 * store" actions in Nuxt DevTools' PGlite tab, which call those routes on the running dev server,
 * and the `/_dev` pages: index with a dev sign-in, stop-disk viewer, the instrument playground,
 * the rover under a free camera and the social card's staged still.
 */
export default defineNuxtModule({
  meta: { name: 'rover-dev' },
  setup(_options, nuxt) {
    if (!nuxt.options.dev) return

    const resolver = createResolver(import.meta.url)

    const api = resolver.resolve('./runtime/server/routes/api')
    for (const { route, method, file } of API_ROUTES) {
      addServerHandler({ route, method, env: 'dev', handler: `${api}/${file}` })
    }

    const pages = resolver.resolve('./runtime/app/pages')
    extendPages((routes) => {
      routes.push(
        { name: 'dev', path: '/_dev', file: `${pages}/index.vue` },
        { name: 'dev-disk', path: '/_dev/disk', file: `${pages}/disk.vue` },
        { name: 'dev-og', path: '/_dev/og', file: `${pages}/og.vue` },
        { name: 'dev-rover', path: '/_dev/rover', file: `${pages}/rover.vue` },
        { name: 'dev-playground', path: '/_dev/playground', file: `${pages}/playground/index.vue` },
        {
          name: 'dev-playground-entry',
          path: '/_dev/playground/:id',
          file: `${pages}/playground/entry.vue`,
          // As a prop: the typed router has no dev routes in builds where types are generated.
          props: true,
        },
      )
    })

    nuxt.hook('pglite:devtools:actions', (actions) => {
      actions.push(
        devRouteAction(nuxt, {
          id: 'rover-dev:seed',
          label: 'Seed mission',
          description: 'Lands a mission at the origin of world "mars" on the empty database',
          path: '/api/_dev/seed',
        }),
        devRouteAction(nuxt, {
          id: 'rover-dev:journey-clear',
          label: 'Clear journey store',
          description: 'Deletes every key of the local journey blob store',
          path: '/api/_dev/journey/clear',
        }),
      )
    })
  },
})

/**
 * A DevTools action that posts to `path` on the running dev server, naming the dev server as the
 * origin so the route's same-origin check passes, and shows what the route answers.
 */
function devRouteAction(
  nuxt: Nuxt,
  action: { id: string; label: string; description: string; path: string },
): PGliteSocketAction {
  const { path, ...info } = action
  return {
    ...info,
    async run() {
      const url = new URL(path, nuxt.options.devServer.url)
      const response = await fetch(url, { method: 'POST', headers: { origin: url.origin } })
      const body = await response.json().catch(() => null)
      if (!response.ok)
        throw new Error(body?.message ?? `${response.status} ${response.statusText}`)
      return body
    },
  }
}
