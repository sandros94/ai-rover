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
} from 'nuxt/kit'

const ROUTE = '/__jev/db'

/**
 * The local database under `nuxt dev`: migrations applied at boot, requests refused while the
 * database disagrees with its migration files, and a Database tab in Nuxt DevTools to inspect,
 * migrate, reset and seed it. Registers nothing outside a development server.
 */
export default defineNuxtModule({
  meta: { name: 'jev-dev-db' },
  setup(_options, nuxt) {
    // Declared for every build so the type checker accepts the runtime files either way.
    addTypeTemplate(
      {
        filename: 'types/jev-dev-db.d.ts',
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

    onDevtoolsReady((ctx) => {
      ctx.docks.register({
        id: 'jev-db',
        type: 'iframe',
        title: 'Database',
        icon: 'i-lucide-database',
        url: ROUTE,
        groupId: NUXT_DEVTOOLS_GROUP_ID,
      })
    })
  },
})
