import { fileURLToPath } from 'node:url'
import { IMMUTABLE_CACHE } from './shared/utils/cache.ts'

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

  modules: ['@nuxt/ui', '@netlify/nuxt', '@tresjs/nuxt', './modules/dev', './modules/auth'],

  css: ['~/assets/css/main.css'],

  /** The rover's model files are named by their content (`scripts/rover-model.ts`). */
  routeRules: { '/models/**': { headers: { 'cache-control': IMMUTABLE_CACHE } } },

  /** Brand marks Lucide does not carry, as `i-brand-<file>`. */
  icon: { customCollections: [{ prefix: 'brand', dir: './app/assets/icons' }] },

  runtimeConfig: {
    /** TypeSafe API key for Jev, from `NUXT_TYPESAFE_TOKEN`; server only. */
    typesafeToken: '',
    /**
     * Seals the session cookies, from `NUXT_SESSION_KEY`: the JSON of an `oct` JWK for A256GCM,
     * or a random secret of at least 32 characters the key is derived from.
     */
    sessionKey: '',
    /**
     * The identities that may use `/admin`, from `NUXT_ADMIN_IDENTITIES`: a comma list of
     * `provider:subject` keys; empty allows nobody.
     */
    adminIdentities: '',
    oauth: {
      /** Comma list of origins sign-in may redirect to, from `NUXT_OAUTH_ORIGINS`. */
      origins: '',
      /** From `NUXT_OAUTH_GITHUB_CLIENT_ID` and `NUXT_OAUTH_GITHUB_CLIENT_SECRET`. */
      github: { clientId: '', clientSecret: '' },
      /** From `NUXT_OAUTH_DISCORD_CLIENT_ID` and `NUXT_OAUTH_DISCORD_CLIENT_SECRET`. */
      discord: { clientId: '', clientSecret: '' },
    },
  },

  imports: { dirs: [TERRAIN, NAV, ROVER, DRIVE, MISSION] },
  /**
   * The shared modules import one another explicitly, so they are import sources only: injecting
   * into them makes Nitro's bundled scanner, which misses `class X extends Y` declarations, import
   * an error class into the file that declares it.
   */
  nitro: {
    imports: {
      dirs: [TERRAIN, NAV, ROVER, DRIVE, MISSION],
      exclude: [/[\\/]node_modules[\\/]/, /[\\/]shared[\\/]utils[\\/]/],
    },
  },

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
