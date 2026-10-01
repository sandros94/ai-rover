import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NUXT_DEVTOOLS_GROUP_ID, onDevtoolsReady } from '@nuxt/devtools-kit'
import {
  addDevServerHandler,
  addServerHandler,
  addServerPlugin,
  addServerTemplate,
  addTypeTemplate,
  createResolver,
  defineNuxtModule,
  extendPages,
} from 'nuxt/kit'

const ROUTE = '/__rover/db'

/** Development-only API routes under `/api/_dev`, by path, method and runtime file. */
const API_ROUTES = [
  { route: '/api/_dev/disk', method: 'get', file: 'disk.get' },
  { route: '/api/_dev/publish', method: 'post', file: 'publish.post' },
  { route: '/api/_dev/login', method: 'post', file: 'login.post' },
  { route: '/api/_dev/fixtures', method: 'get', file: 'fixtures.get' },
  { route: '/api/_dev/fixtures/:name', method: 'get', file: 'fixture.get' },
] as const

/**
 * Everything that exists only under `nuxt dev`, registered after the dev check so no other build
 * bundles it: the local database (migrations applied at boot, requests refused while the
 * database disagrees with its migration files, a Database tab in Nuxt DevTools to inspect,
 * migrate, reset and seed it), the `/api/_dev` routes, and the `/_dev` pages: index with a dev
 * sign-in, stop-disk viewer, the instrument playground, the rover under a free camera and the
 * social card's staged still.
 */
export default defineNuxtModule({
  meta: { name: 'rover-dev' },
  setup(_options, nuxt) {
    // Declared for every build so the type checker accepts the runtime files either way.
    addTypeTemplate(
      {
        filename: 'types/rover-dev.d.ts',
        getContents: () =>
          "declare module '#dev-migrations' {\n  const directory: string\n  export default directory\n}\n",
      },
      { nitro: true, node: true },
    )

    if (!nuxt.options.dev) return

    const resolver = createResolver(import.meta.url)
    const migrations = join(nuxt.options.rootDir, 'netlify/database/migrations')

    addServerTemplate({
      filename: '#dev-migrations',
      getContents: () => `export default ${JSON.stringify(migrations)}`,
    })
    addServerPlugin(resolver.resolve('./runtime/server/plugins/migrate'))
    addServerHandler({
      middleware: true,
      env: 'dev',
      handler: resolver.resolve('./runtime/server/middleware/refuse'),
    })
    // The JSON routes run inside the server runtime, where the refusal and the database live.
    addServerHandler({
      route: `${ROUTE}/**`,
      env: 'dev',
      handler: resolver.resolve('./runtime/server/routes/panel'),
    })
    // The page itself is static, served by the dev server and read on every request.
    addDevServerHandler({
      route: ROUTE,
      handler: async () =>
        new Response(await readFile(resolver.resolve('./runtime/panel.html'), 'utf8'), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
    })

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

    onDevtoolsReady((ctx) => {
      ctx.docks.register({
        id: 'rover-db',
        type: 'iframe',
        title: 'Database',
        icon: 'i-lucide-database',
        url: ROUTE,
        groupId: NUXT_DEVTOOLS_GROUP_ID,
      })
    })
  },
})
