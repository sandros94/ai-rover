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

const PREVIEW_URL = ['deploy-preview', 'branch-deploy'].includes(process.env.CONTEXT ?? '')
  ? process.env.DEPLOY_PRIME_URL
  : undefined

/**
 * The deploy's own addresses on Netlify, which the platform sets at build only: the site's main
 * address, and this deploy's primary and unique ones (a deploy preview's or branch deploy's, or a
 * production deploy's permalink). Empty elsewhere.
 */
const NETLIFY_ADDRESSES = process.env.NETLIFY
  ? {
      site: process.env.URL ?? '',
      deploy: [process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL].filter(Boolean).join(','),
    }
  : { site: '', deploy: '' }

export default defineNuxtConfig({
  compatibilityDate: 'latest',
  devtools: { enabled: true },

  modules: ['@nuxt/ui', '@netlify/nuxt', 'nuxt-pglite', '@tresjs/nuxt', './modules/dev'],

  css: ['~/assets/css/main.css'],

  /** The rover's model files are named by their content (`scripts/rover-model.ts`). */
  routeRules: { '/models/**': { headers: { 'cache-control': IMMUTABLE_CACHE } } },

  /** Brand marks Lucide does not carry, as `i-brand-<file>`. */
  icon: { customCollections: [{ prefix: 'brand', dir: './app/assets/icons' }] },

  runtimeConfig: {
    public: {
      /**
       * The site's own origin, for the absolute URLs link previews need, from
       * `NUXT_PUBLIC_SITE_URL`. A Netlify deploy preview or branch deploy points at itself.
       */
      siteUrl: PREVIEW_URL ?? 'https://rover.s94.dev',
    },
    /** TypeSafe API key for Jev, from `NUXT_TYPESAFE_TOKEN`; server only. */
    typesafeToken: '',
    /**
     * The identities that may use `/admin`, from `NUXT_ADMIN_IDENTITIES`: a comma list of
     * `provider:subject` keys; empty allows nobody.
     */
    adminIdentities: '',
    oauth: {
      /** Comma list of origins every provider signs in on, from `NUXT_OAUTH_ORIGINS`. */
      origins: '',
      /** The site's main address on Netlify (`URL`): every provider signs in on it too. */
      siteUrl: NETLIFY_ADDRESSES.site,
      /**
       * This deploy's own addresses on Netlify (`DEPLOY_PRIME_URL`, `DEPLOY_URL`): AT Protocol
       * signs in on them as well, GitHub and Discord not, their apps' callbacks being registered
       * on the origins above only.
       */
      deployUrls: NETLIFY_ADDRESSES.deploy,
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
   * that the machine's Deno does not accept. Database emulation is off: the PGlite socket below
   * stands in for Netlify Database.
   */
  netlify: {
    edgeFunctions: { enabled: false },
    database: { enabled: false },
  },

  /**
   * PGlite built from `server/pglite.config.ts` (every generated migration applied). Under
   * `nuxt dev` the socket serves it over the wire protocol at a pinned port, which
   * `drizzle.config.ts` names too, exporting `NETLIFY_DB_URL` and `NETLIFY_DB_DRIVER=server` while
   * unset so `useDB()` reaches it as it reaches Netlify Database; the test databases
   * (`nuxt-pglite/testing`) are built from the same config. The server keeps Netlify Database:
   * nothing of PGlite is bundled.
   */
  pglite: {
    server: { enabled: false },
    socket: { port: 5456, provider: 'netlify' },
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
