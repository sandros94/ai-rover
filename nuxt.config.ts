import { fileURLToPath } from 'node:url'
import type { NuxtPage } from 'nuxt/schema'
import { useNuxt } from 'nuxt/kit'

/**
 * Nuxt scans only the top-level files of `shared/utils`; a module folder with an index file is
 * registered explicitly, and on both sides so its exports count as shared (app and server).
 */
const TERRAIN = fileURLToPath(new URL('./shared/utils/terrain/index.ts', import.meta.url))
const NAV = fileURLToPath(new URL('./shared/utils/nav/index.ts', import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: 'latest',
  devtools: { enabled: true },

  modules: ['@nuxt/ui', '@netlify/nuxt'],

  css: ['~/assets/css/main.css'],

  imports: { dirs: [TERRAIN, NAV] },
  nitro: { imports: { dirs: [TERRAIN, NAV] } },

  /**
   * Local Netlify emulation under `dev` and `test`. Edge Functions are off: the project deploys
   * none (Nitro's `netlify` preset emits Functions v2) and emulating them starts a Deno process
   * that the machine's Deno does not accept.
   */
  netlify: {
    edgeFunctions: { enabled: false },
  },

  hooks: {
    // TODO(dev-only): drops the `/_dev/**` pages outside `nuxt dev`; removed with those pages before launch.
    'pages:extend'(pages) {
      if (!useNuxt().options.dev) removeDevPages(pages)
    },
  },

  experimental: {
    typescriptPlugin: true,
  },

  $test: {
    nitro: {
      preset: 'node-server',
    },
  },
})

// TODO(dev-only): removed with the `pages:extend` hook above.
function removeDevPages(pages: NuxtPage[]): void {
  for (let k = pages.length - 1; k >= 0; k--) {
    const page = pages[k]!
    if (page.path === '/_dev' || page.path.startsWith('/_dev/')) pages.splice(k, 1)
    else if (page.children) removeDevPages(page.children)
  }
}
