import { fileURLToPath } from 'node:url'

/**
 * Nuxt scans only the top-level files of `shared/utils`; a module folder with an index file is
 * registered explicitly, and on both sides so its exports count as shared (app and server).
 */
const TERRAIN = fileURLToPath(new URL('./shared/utils/terrain/index.ts', import.meta.url))
const NAV = fileURLToPath(new URL('./shared/utils/nav/index.ts', import.meta.url))
const ROVER = fileURLToPath(new URL('./shared/utils/rover/index.ts', import.meta.url))
const DRIVE = fileURLToPath(new URL('./shared/utils/drive/index.ts', import.meta.url))
const MISSION = fileURLToPath(new URL('./shared/utils/mission/index.ts', import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: 'latest',
  devtools: { enabled: true },

  modules: ['@nuxt/ui', '@netlify/nuxt', './modules/dev', './modules/auth'],

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    /** TypeSafe API key for Jev, from `NUXT_TYPESAFE_TOKEN`; server only. */
    typesafeToken: '',
    /** JSON of an `oct` JWK for A256GCM sealing the session cookies, from `NUXT_SESSION_KEY`. */
    sessionKey: '',
    oauth: {
      /** Comma list of origins sign-in may redirect to, from `NUXT_OAUTH_ORIGINS`. */
      origins: '',
      /** From `NUXT_OAUTH_GITHUB_CLIENT_ID` and `NUXT_OAUTH_GITHUB_CLIENT_SECRET`. */
      github: { clientId: '', clientSecret: '' },
    },
  },

  imports: { dirs: [TERRAIN, NAV, ROVER, DRIVE, MISSION] },
  nitro: { imports: { dirs: [TERRAIN, NAV, ROVER, DRIVE, MISSION] } },

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
