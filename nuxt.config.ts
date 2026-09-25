import { fileURLToPath } from 'node:url'

/**
 * Nuxt scans only the top-level files of `shared/utils`; a module folder with an index file is
 * registered explicitly, and on both sides so its exports count as shared (app and server).
 */
const TERRAIN = fileURLToPath(new URL('./shared/utils/terrain/index.ts', import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: 'latest',
  devtools: { enabled: true },

  modules: ['@nuxt/ui', '@netlify/nuxt'],

  css: ['~/assets/css/main.css'],

  imports: { dirs: [TERRAIN] },
  nitro: { imports: { dirs: [TERRAIN] } },

  /**
   * Local Netlify emulation under `dev` and `test`. Edge Functions are off: the project deploys
   * none (Nitro's `netlify` preset emits Functions v2) and emulating them starts a Deno process
   * that the machine's Deno does not accept.
   */
  netlify: {
    edgeFunctions: { enabled: false },
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
