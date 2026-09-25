# Platform research: Nuxt 5 nightly + Netlify (2026-09-23)

Scope: Nuxt app on Netlify needing (a) live rover-position push to many browsers, (b) submissions + votes, (c) seconds-to-minutes server-side physics precompute per segment, (d) relational data in Netlify DB, long-term journey logs in Netlify Blobs served via CDN.

Evidence rule: every fact below is tied to a source in the Sources section (S#). Anything not directly verified is marked **UNVERIFIED**.

---

## 1. Nuxt v5 status

| Item | Value | Source |
| --- | --- | --- |
| Latest stable `nuxt` | 4.5.2 (published 2026-08-05); dist-tags: `latest=4.5.2`, `3x=3.21.11`, `rc=4.0.0-rc.0` | S1 |
| Nuxt 5 released? | **No.** `main` branch = `5.0.0-0`; PR "v5.0.0" #34497 still open/draft (updated 2026-09-16) | S2, S3 |
| Nightly channel for v5 | `nuxt-nightly` dist-tag **`5x`** = `5.0.0-29836350.ccbf4a57` (published 2026-09-23T16:32Z). `latest` nightly tag = `4.6.0-…` (tracks 4.x). `3x` also exists | S1 |
| package.json alias | `"nuxt": "npm:nuxt-nightly@5x"` (pattern from the nightly docs, which document only `@latest`/`@3x`; `5x` tag confirmed on npm and named in PR #34497 body: "so `nuxt-nightly@5x` is as non-breaking as possible") | S3, S4 |
| Node engines (5x nightly) | `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0` | S1 |
| Nitro used by 5x | `@nuxt/nitro-server-nightly@5.0.0-…` depends on **`nitro: ^3.0.260903-beta`** (Nitro v3 beta, no `nitropack`). Latest `nitro` on npm = `3.0.260903-beta` (2026-09-03) | S1 |
| h3 used by 5x | Nitro v3 → **h3 v2**. npm `h3` dist-tags: `latest=2.0.1-rc.32`, `1x=1.15.11` | S1 |
| Nuxt 4.5.2 for comparison | `@nuxt/nitro-server@4.5.2` → `nitropack ^2.13.4`, `h3 ^1.15.11` | S1, S2 |
| Nuxt 5 timeline (maintainer, PR body) | "Nitro v3 is currently in beta, and we expect RC soon… after Nitro v3 is released, there will be at least another month of testing… before a release." Open checklist: nitro v3 release, typed routing via fetchdts, remove stale experimental options, module ecosystem testing | S3 |

### Notable breaking changes v5 vs v4 (docs + PR changelog)

- Nitro v3 rewrite on Web-standard `Request`/`Response`; imports `nitropack` → `nitro`; h3 utils via `nitro/h3`; Nuxt 5 also ships a `nuxt/server` import surface for `defineEventHandler`, `getQuery`, etc. (S5)
- **Nitro/h3 auto-imports disabled** in server code (the template's `server/api/hello.get.ts` imports `defineHandler, getQuery` from `'nitro/h3'`) (S5, S6)
- Vite 8 migration (PR changelog: "⚠️ Migrate to Vite 8"), Vite Environment API (S3)
- vue-router v5; file-system routing via `unrouting`; case-sensitive routing; normalized page names; typed pages + typed `$fetch` on by default (S3, S5)
- Vue Options API compiled out by default; `jiti` no longer bundled; `experimental.externalVue` removed; `experimental.parseErrorData` forced on; legacy `_renderResponse` removed (S5)
- `future.compatibilityVersion: 5` in Nuxt ≥4.2 previews the flaggable subset on v4 (S5)

---

## 2. Template `sandros94/nuxt-starters` branch `v5`

Last commit `f7ec87b` 2026-09-22 ("chore(deps): update all non-major dependencies (#1305)"). Branches: main, module, templates, ui, v5 (+ renovate/*). (S6)

### package.json (exact)

```json
{
  "name": "nuxt-v5",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "nuxt build",
    "clear": "nuxt cleanup",
    "dev": "nuxt dev",
    "generate": "nuxt generate",
    "lint": "oxlint . && oxfmt --check .",
    "fmt": "oxlint --fix . && oxfmt .",
    "typecheck": "nuxt typecheck --checker=golar",
    "preview": "nuxt preview",
    "postinstall": "nuxt prepare && pnpm simple-git-hooks",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:e2e": "vitest run --project e2e",
    "test:nuxt": "vitest run --project nuxt",
    "test:browser": "playwright test"
  },
  "dependencies": {
    "@iconify-json/lucide": "npm:@iconify-json/lucide@^1.2.135",
    "@nuxt/icon": "npm:@nuxt/icon@^2.5.1",
    "@nuxt/ui": "npm:@nuxt/ui@^4.11.1",
    "h3": "npm:h3@2.0.1-rc.29",
    "nitro": "npm:nitro@3.0.260610-beta",
    "nuxt": "npm:nuxt-nightly@5.0.0-29796419.a2fd06ab",
    "tailwindcss": "npm:tailwindcss@^4.3.3",
    "vue": "npm:vue@^3.5.43"
  },
  "devDependencies": {
    "@dxup/unimport": "npm:@dxup/unimport@^0.1.2",
    "@golar/vue": "npm:@golar/vue@^0.1.10",
    "@nuxt/test-utils": "npm:@nuxt/test-utils-nightly@4.1.1-20260826-115945-218c180",
    "@playwright/test": "npm:@playwright/test@^1.63.0",
    "@vue/test-utils": "npm:@vue/test-utils@^2.5.1",
    "golar": "npm:golar@^0.1.10",
    "h3-next": "npm:h3@2.0.1-rc.29",
    "happy-dom": "npm:happy-dom@^20.14.5",
    "oxfmt": "npm:oxfmt@^0.68.0",
    "oxlint": "npm:oxlint@^1.83.0",
    "oxlint-tsgolint": "npm:oxlint-tsgolint@~7.0.2002",
    "playwright-core": "npm:playwright-core@^1.63.0",
    "simple-git-hooks": "npm:simple-git-hooks@^2.14.0",
    "typescript": "npm:typescript@^7.0.2",
    "vitest": "npm:vitest@^4.1.11",
    "vue-tsc": "npm:vue-tsc@^3.3.11"
  },
  "simple-git-hooks": { "pre-commit": "pnpm lint && pnpm typecheck" },
  "packageManager": "pnpm@11.17.0"
}
```

Notes: nuxt pinned to an exact nightly (`5.0.0-29796419.a2fd06ab`), nitro pinned to `3.0.260610-beta` (older than nuxt-nightly 5x's own `^3.0.260903-beta` requirement — pnpm resolves the workspace pin; potential mismatch to watch). `h3` and `h3-next` both alias `h3@2.0.1-rc.29` (test-utils nightly imports `h3-next/generic`, patched to `h3/generic`).

### nuxt.config.ts

```ts
export default defineNuxtConfig({
  compatibilityDate: 'latest',
  devtools: { enabled: true },
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  experimental: { typescriptPlugin: true },
  $test: { nitro: { preset: 'node-server' } },
})
```

### vitest.config.ts (3 projects)

- aliases `~`→`app`, `~~`→root, `#shared`→`shared`, `#server`→`server`; `resolve.tsconfigPaths: true`
- projects: `unit` (`test/unit/**`, env node), `nuxt` (`await defineVitestProject({ test: { name:'nuxt', include:['test/nuxt/**'], environment:'nuxt' } })` from `@nuxt/test-utils/config`), `e2e` (`test/e2e/**`, env node, uses `setup()`/`$fetch` from `@nuxt/test-utils/e2e`)
- browser tests separate: `playwright.config.ts` with `@nuxt/test-utils/playwright` fixtures, `testDir: ./test/browser`

### Other config

- `.nuxtrc`: `setups.@nuxt/test-utils="4.1.1-20260826-115945-218c180"`
- `pnpm-workspace.yaml`: `minimumReleaseAgeStrict: true` with exclusions for `nuxt`, `nuxt-nightly`, `@nuxt/*`; `overrides: vitest-environment-nuxt: ^2.0.0` (nightly ships unreplaced `workspace:*`); `patchedDependencies: '@nuxt/test-utils-nightly': .patches/@nuxt__test-utils-nightly.patch` (rewrites `h3-next/generic`→`h3/generic` and replaces `src/*.ts` exports with `dist/*` exports); `allowBuilds` list (better-sqlite3, sharp, simple-git-hooks true; esbuild etc false)
- `golar.config.ts`: `defineConfig({})` from `golar/unstable` + `import '@golar/vue'` (typecheck via golar, not vue-tsc CLI)
- `tsconfig.json`: project references to `.nuxt/tsconfig.{app,server,shared,node}.json`, `files: []`; `test/tsconfig.json` extends `.nuxt/tsconfig.shared.json`
- `.oxlintrc.json`, `.oxfmtrc.json`, `.editorconfig`, `.vscode/settings.json`, `renovate.json`
- CI (`.github/workflows/ci.yml`): pnpm/action-setup@v6, actions/setup-node@v7 node 24.17.0, `pnpm install --frozen-lockfile`; jobs: check (lint+typecheck) → test matrix [unit, nuxt, e2e, browser] with `playwright install --with-deps chromium` for e2e/browser. Triggers only on push to `main` / PRs → last recorded v5-branch run: success 2026-07-04 (S6)

### Folder layout

```
app/{app.vue, app.config.ts, assets/css/main.css, components/AppGreeting.vue, composables/useGreeting.ts, pages/index.vue}
server/api/hello.get.ts        # import { defineHandler, getQuery } from 'nitro/h3'
shared/utils/greeting.ts
test/{unit,nuxt,e2e,browser}/  + test/tsconfig.json
public/favicon.ico
```

`app.config.ts`: `ui.colors = { primary:'orange', neutral:'neutral', info:'sky' }`. README quick start: `npm create nuxt@latest <dir> -- --packageManager pnpm -t gh:sandros94/nuxt-starters#ui --gitInit --no-modules` (README still references the `ui` branch; for v5 use `#v5`).

---

## 3. Nuxt UI

| Item | Value | Source |
| --- | --- | --- |
| Current major | **v4**; `@nuxt/ui@latest = 4.11.2` (2026-09-22); only one dist-tag (`latest`); no `@nuxt/ui-nightly` package (404) | S1 |
| Peer deps (relevant) | `vue-router ^4.5.0 \|\| ^5`, `tailwindcss ^4`, `typescript ^5.6.3 \|\| ^6 \|\| ^7`, `zod ^3.24 \|\| ^4`; **no explicit `nuxt` peer range** | S1 |
| Repo dev catalog | `nuxt: ^4.5.2`, `h3: 1.15.11` (pnpm-workspace catalog on main) — it is developed/tested against Nuxt 4 + h3 v1 | S7 |
| Nuxt 5 support | No issue/PR in nuxt/ui mentions Nuxt 5 / nitro v3 (search returned none). Template pins `@nuxt/ui ^4.11.1` alongside `nuxt-nightly@5` and its last CI (July) passed, so it _loads_ under 5x nightly. **UNVERIFIED** that every component works on Nuxt 5 nightly; vue-router v5 peer range (`^5`) is already in place (Nuxt 5 uses vue-router v5) | S1, S3, S6, S7 |

---

## 4. Netlify realtime / WebSockets

### Facts

- **No official Netlify doc describes server-side WebSocket (upgrade) handling** in Functions or Edge Functions. Functions API reference: WebSockets not mentioned; streaming via `ReadableStream` is supported. (S8)
- Edge Functions API lists "WebSocket API" under supported Web APIs (i.e. the Deno `WebSocket` client global). No mention of `Deno.upgradeWebSocket`/inbound upgrades. (S9) → **UNVERIFIED** whether inbound upgrade works; practically bounded by Edge limits (50 ms CPU/request, 40 s response-header timeout) (S10).
- Support-forum staff answers: 2019-10-16 "No server side processing is supported at Netlify (outside of Functions used for API calls)"; 2020-04-01 / 2021-02-12 "We do not support proxying websockets… don't think this will get added to the roadmap anytime soon." Users report socket.io failures as late as 2023. (S11, S12)
- Netlify's own guidance for realtime = third party. Blog "Web Sockets in a Serverless World" (page dated 2026-09-23) uses **Ably**, with a Netlify Function only minting tokens. Netlify Integrations directory lists Ably and Jamsocket. No native Netlify pub/sub product found. (S13, S14)
- Nitro WebSocket tracker #2171: Netlify / netlify-edge / netlify-lambda listed under "requires investigation"; supported: node, bun, deno, cloudflare, vercel. (S15)
- `netlify-cli` 27.8.1 current; nothing websocket-related found.

### What _is_ available on Netlify (push-ish)

| Mechanism | Limit | Source |
| --- | --- | --- |
| Functions v2 streaming (`ReadableStream` body, e.g. `text/event-stream`) | **60 s** execution limit, **20 MB** streamed payload | S8, S16 |
| Edge Functions streaming | 40 s response-header timeout; 50 ms CPU/request; 512 MB; body streaming duration not documented → **UNVERIFIED** | S10 |
| Background function | 15 min, returns 202 immediately, **no response streaming** | S17 |
| CDN-cached polling | Function response with `Netlify-CDN-Cache-Control: public, max-age=N, stale-while-revalidate=M[, durable]` + `Netlify-Cache-Tag` + `purgeCache()` on write | S18 |

Conclusion: SSE from a Netlify Function is capped at 60 s per connection (client must reconnect; `Last-Event-ID` pattern). For "many browsers watching a playback", true fan-out WebSockets need a third party or Cloudflare.

### Third-party options (pricing verified 2026-09-23)

| Provider | Free | Paid | Source |
| --- | --- | --- | --- |
| Ably | 6M msgs/mo, 200 concurrent conns, 200 channels | Standard $29/mo (10k conns, 2.5k msg/s) + $2.50/M msgs, $1/M conn-min; Pro $399/mo | S19 |
| Pusher Channels | 200k msgs/day, 100 concurrent conns | Startup $49 (500 conns, 1M msgs/day); Pro $99 (2k conns) … | S20 |
| Cloudflare Durable Objects (+ `partyserver` 0.5.10 / `partysocket` 1.3.0, PartyKit joined Cloudflare 2024) | 100k req/day, 13k GB-s/day, SQLite 5 GB | Workers Paid: 1M req/mo incl. + $0.15/M; 400k GB-s incl. + $12.50/M GB-s; WebSocket Hibernation cuts duration billing | S21, S22 |

Nuxt/Nitro note: Nitro has first-class WebSocket support on Cloudflare/Node/Deno/Bun (S15) — a split deploy (Nuxt on Netlify + a tiny Nitro/partyserver worker on Cloudflare for fan-out) is a coherent option; **UNVERIFIED** in this project.

---

## 5. Netlify DB (Neon-backed)

| Item | Value | Source |
| --- | --- | --- |
| Status | **GA 2026-04-28** ("Netlify Database"); native primitive, no extension. Beta "Netlify DB" (Neon extension) stopped creating new DBs 2026-04-13; beta DBs must be **claimed into a Neon account within 7 days** or deleted | S23, S24 |
| Backing | Neon (Netlify blog: "partners with Neon to power the databases", Netlify now fully manages the experience; Neon blog 2025-06-05 "Powered by Neon") | S25, S26 |
| Plans | Credit-based plans only (Free/Personal/Pro/Enterprise) | S27 |
| Packages | **`@netlify/database` 2.0.1** (2026-09-02; deps `@neondatabase/serverless ^1.1.0`, `pg ^8.13`, `waddler`, `ws`). Exports `getConnectionString()`, `getDatabase({connectionString?,debug?})` → `db.sql` tagged template (Waddler; `.stream()`, `.chunked()`, `sql.identifier/values/raw/unsafe/default`) and `db.pool` (`pg.Pool`, for transactions). Auto-picks connector per environment (build/long-running server vs Functions/Edge) and correct branch | S1, S28 |
| Legacy | `@netlify/neon` 0.1.2 (2026-07-16; wraps `@neondatabase/serverless`, uses `NETLIFY_DATABASE_URL`, `netlify db init`). Netlify skill text: beta extension "deprecated… do not install for new projects" (per search snippet; npm shows no `deprecated` flag) — treat as legacy | S1, S24 |
| Provisioning | `netlify database init` (installs pkg, choose Drizzle or raw SQL, scaffolds migrations, optional seed); or UI Data & Storage > Database; DB auto-provisioned on first deploy | S29 |
| Branching | Production deploys → main DB; every Deploy Preview / agent run gets its own branch (copy of prod data) | S27 |
| Migrations | `netlify/database/migrations/` `<number>_<slug>.sql` (or `<dir>/migration.sql`), lexicographic; applied just before publish (prod) / before preview available; failure blocks publish. Drizzle-kit compatible | S30 |
| Local dev | Real local Postgres started by `netlify dev` or `@netlify/vite-plugin` (and by extension `@netlify/nuxt`); injects **`NETLIFY_DB_URL`**; `netlify database connect --json` for psql/DataGrip. State shared between CLI and Vite plugin | S31 |
| Billing | Compute **10 credits/compute-unit**; bandwidth **20 credits/GB**; storage **free until 2026-07-01** (docs still say "billed no earlier than"; **UNVERIFIED** whether storage billing has actually started as of today) | S32 |

### DB limits by plan (S32)

| Limit | Free | Personal | Pro | Enterprise |
| --- | --- | --- | --- | --- |
| Databases/account | 3 | 5 | 50 | 500 |
| Branches/DB | 20 | 100 | 300 | 450 |
| Compute units min/max | 1/1 | 1/4 | 1/16 | 4/32 |
| Sleep on inactivity | 5 min | 5 min | always on | always on |
| Total compute/period | 48 units | ∞ | ∞ | ∞ |
| Data written / bandwidth / storage (per period) | 5 GB each | 100 GB each | 100 GB each | ∞ |
| Backup retention | 3 d | 7 d | 30 d | 30 d |

REST API exists: `POST/GET /sites/{id}/database`, `/database/branch`, `/database/snapshot…` (S28). PCI/HIPAA not covered.

---

## 6. Netlify Blobs

| Item | Value | Source |
| --- | --- | --- |
| Package | `@netlify/blobs` 11.1.0 (2026-09-14) | S1 |
| Consistency | Default **eventual**: single-region store, edge-cached; new blob globally available immediately; updates/deletes propagate to all edges **within 60 s**. Opt-in **strong** per store `getStore({name, consistency:'strong'})` or per read `store.get(key,{consistency:'strong'})` (slower reads). CLI always strong | S33 |
| Limits | object ≤ **5 GB**; metadata ≤ 2 KB; key ≤ 600 bytes, no leading `/`; store name ≤ 64 bytes, no `/` `:` | S33 |
| Semantics | last-write-wins, **no concurrency control**, **no TTL/expiry**; conditional reads via `etag`; site-wide vs deploy-scoped stores; regions us-east-1/2, eu-central-1, ap-southeast-1/2; not readable from Go functions; local dev = sandboxed store | S33 |
| Public serving / CDN | No public URL for blobs. Serve through a Function/Edge Function and set `Netlify-CDN-Cache-Control` (function responses are **not cached by default**); `durable` directive (functions only) shares cache across edge nodes; tag with `Netlify-Cache-Tag` and invalidate via `purgeCache({tags})` from `@netlify/functions`. Blobs' own edge cache (eventual mode) is separate from the CDN response cache | S18, S33 |
| Pricing | **UNVERIFIED** — credits rate table lists Production deploys 15, Compute 10/GB-h, Bandwidth 20/GB, Web requests 2/10k, AI 180/$1; no separate Blobs line. Pricing page lists "Blob storage" as included on Free. Assume storage not separately metered today; bandwidth/requests apply | S34, S35 |

Pattern for journey logs served via CDN (from docs):

```ts
import { getStore } from '@netlify/blobs'
export default async (req) => {
  const body = await getStore('journeys').get(key, { type: 'stream' })
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Netlify-CDN-Cache-Control': 'public, max-age=31536000, durable',
      'Netlify-Cache-Tag': `journey-${id}`,
    },
  })
}
```

(Immutable logs → long max-age; on rewrite call `purgeCache({ tags })`.)

---

## 7. Netlify Functions / compute limits

### Default values (S16, S17, S36)

| Setting | Value | Configurable |
| --- | --- | --- |
| Sync function execution limit | **60 s** (hard) | No |
| Streaming function | 60 s, 20 MB streamed payload | No |
| Scheduled function | 30 s; min interval hourly; prod deploys only; no payload | No |
| Background function | **15 min**; immediate `202`; retried after 1 min then 2 min on error; no streaming; 256 KB req/resp payload | No |
| Buffered payload | 6 MB (≈4.5 MB binary base64) | No |
| Memory | default **1024 MB**, up to **4096 MB** (Pro/Enterprise credit plans); vCPU 0.5–2 proportional | Pro/Ent |
| Region | default `cmh` (US East, Ohio) | Pro/Ent |
| Node runtime | follows build Node version (fallback Node 24); `AWS_LAMBDA_JS_RUNTIME` env | Yes |
| Compute billing | 10 credits per GB-hour | — |
| Background functions availability | Credit-based plans incl. Free/Personal/Pro + Enterprise (not legacy non-Enterprise) | S17, S36 |

### Edge Functions (S10)

| Limit                   | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| CPU time                | 50 ms / request                                                    |
| Response header timeout | 40 s                                                               |
| Memory                  | 512 MB per deployed set                                            |
| Code size               | 20 MB compressed                                                   |
| Billing                 | metered "Web requests" 2 credits/10k; cached responses don't count |

### Async Workloads (durable functions) — exact name **"Netlify Async Workloads"** (S37–S41)

- Extension (team-level; Starter/Free plan → per-site API key), npm **`@netlify/async-workloads`** 0.0.106 (2026-07-16). GA, "any plan level"; billed as underlying functions + blobs.
- API: `asyncWorkloadFn(event)`, `export const asyncWorkloadConfig = { events: [...], eventFilter?, maxRetries? (default 4 → 5 attempts), backoffSchedule? (default 5s ×4 each retry, max 1 week) }`; `AsyncWorkloadsClient().send(name,{data})`; `step.run(id, fn)` (memoized, workload re-invoked after each new step), `step.sleep(id, '1 day')`; `ErrorDoNotRetry`, `ErrorRetryAfterDelay`.
- Limits: event payload **≤ 500 KB**; router batches 10; per-invocation timeout = underlying function (**60 s** sync, or **15 min** if the workload function is a background function — `AWL_SERVERLESS_TIMEOUT` config); pending upper limit 2000; chain limit 20; scheduler interval 60 s default (10–900 s); dead-letter retention 30 days; FIFO with priority −50..+50.
- Fit for (c): physics precompute of seconds→minutes → background function (15 min) or Async Workload with steps; result to Blobs/DB, client polls or subscribes via third-party realtime.

### Nitro `netlify` presets (Nitro v3 source, S42, S43)

| Preset | Output | Notes |
| --- | --- | --- |
| `netlify` (auto-detected, `stdName: netlify`) | `.netlify/functions-internal/server/server.mjs` (Functions v2), publish `dist/` | writes `_headers`/`_redirects`, `deploy/v1/config.json` from `nitro.netlify.config` (Frameworks API: `functions`, `edge_functions`, `headers`, `images`, `redirects`); runtime sets `req.ip` from `x-nf-client-connection-ip`; `routeRules.isr` → `Netlify-CDN-Cache-Control: public, max-age=…, stale-while-revalidate | must-revalidate, durable` |
| `netlify-edge` | `.netlify/edge-functions/server/server.js` + `manifest.json` (path `/*`, excludes static) | extends `base-worker`, Deno unenv; must be set explicitly (not auto-detected) |
| `netlify-static` | `dist/` only | pre-rendered |
| Netlify Nuxt guide: standard SSR auto-uses `netlify`; pnpm users historically needed `PNPM_FLAGS=--shamefully-hoist` (S44). |

---

## 8. `@netlify/nuxt`

| Item | Value | Source |
| --- | --- | --- |
| Version | **1.0.1** (2026-08-28); repo `netlify/framework-adapters` `packages/nuxt-module` | S1, S45 |
| Deps | `@netlify/dev ^5.0.2`, `@netlify/dev-utils ^6.0.1`, **`@nuxt/kit ^4.4.8`**, **`h3 ^1.15.11`**; devDep `nuxt ^4.4.8`; engines node ≥22.12 | S1, S45 |
| What it does | "local emulation of the Netlify platform directly in `nuxt dev`"; repackages `@netlify/vite-plugin` (3.0.1). Emulates: Functions, Edge Functions, Blobs, Netlify Database (local Postgres), Cache API, Image CDN, redirects/rewrites, headers, env vars, AI Gateway | S44, S45, S46 |
| Install | `npx nuxi module add @netlify/nuxt` → `modules: ['@netlify/nuxt']` | S45 |
| Nuxt 5 nightly compat | **UNVERIFIED** — depends on `@nuxt/kit` v4 and **h3 v1**; no issue in framework-adapters mentions Nitro v3/Nuxt 5. Expect friction with h3 v2 handler signatures; needs a spike | S1, S45 |
| Related | `@netlify/dev` 5.1.2 (emulator lib used by CLI/Vite plugin); `@netlify/functions` 6.0.0 (`purgeCache`, `Config` types); `netlify-cli` 27.8.1 | S1, S46 |

---

## Key takeaways for this app

1. Nuxt 5 = nightly only (`npm:nuxt-nightly@5x`, Nitro 3 beta, h3 v2); release gated on Nitro v3 GA + ≥1 month. Template v5 is a working pin but drifts (nitro pin older than nuxt-nightly's peer).
2. Nuxt UI 4.11.2 installs alongside 5x nightly; official support unstated.
3. Netlify has **no server WebSockets**. Realtime fan-out → Ably/Pusher or Cloudflare DO (Nitro WS-native). SSE from Functions works but 60 s/connection.
4. Precompute (seconds–minutes) → Background Function (15 min) or Async Workloads; sync path is 60 s hard.
5. Netlify DB GA, Neon-backed, `@netlify/database` v2 (`getDatabase().sql` / `.pool`), branches per preview, migrations in `netlify/database/migrations`, local Postgres via `@netlify/nuxt`/CLI, Free plan: 1 CU, 48 CU-hours/period, 5 GB.
6. Blobs: eventual (≤60 s) by default, strong opt-in, 5 GB/object, no public URL — serve through a function with `Netlify-CDN-Cache-Control … durable` + cache tags.
7. `@netlify/nuxt` 1.0.1 targets Nuxt 4 / h3 v1 — compatibility with 5x nightly unproven.

---

## Sources

- S1 — npm registry via `npm view` (2026-09-23): `nuxt`, `nuxt-nightly`, `@nuxt/nitro-server(-nightly)`, `nitro`, `nitropack`, `h3`, `@nuxt/ui`, `@netlify/nuxt`, `@netlify/database`, `@netlify/neon`, `@netlify/dev`, `@netlify/blobs`, `@netlify/functions`, `@netlify/vite-plugin`, `@netlify/async-workloads`, `netlify-cli`, `ably`, `partysocket`
- S2 — `gh api repos/nuxt/nuxt/releases`, `repos/nuxt/nuxt/contents/packages/{nuxt,nitro-server}/package.json` (main, 4.x)
- S3 — https://github.com/nuxt/nuxt/pull/34497 (v5.0.0 PR body, via `gh api`)
- S4 — https://nuxt.com/docs/4.x/guide/going-further/nightly-release-channel and https://nuxt.com/docs/5.x/guide/going-further/nightly-release-channel
- S5 — https://nuxt.com/docs/5.x/getting-started/upgrade and https://nuxt.com/docs/4.x/getting-started/upgrade
- S6 — https://github.com/sandros94/nuxt-starters/tree/v5 (files via raw.githubusercontent.com/sandros94/nuxt-starters/v5/…; tree/commits/actions via `gh api`)
- S7 — `gh api repos/nuxt/ui/contents/{package.json,pnpm-workspace.yaml}`; `gh api search/issues?q=repo:nuxt/ui+…`
- S8 — https://docs.netlify.com/build/functions/api/
- S9 — https://docs.netlify.com/build/edge-functions/api/
- S10 — https://docs.netlify.com/build/edge-functions/limits/ ; https://docs.netlify.com/build/edge-functions/usage-and-billing.md
- S11 — https://answers.netlify.com/t/does-netlify-support-websocket-programming/4213
- S12 — https://answers.netlify.com/t/does-netlify-support-websocket-proxying/11230
- S13 — https://www.netlify.com/blog/web-sockets-in-a-serverless-world/
- S14 — WebSearch results: https://www.netlify.com/integrations/ably/ , https://www.netlify.com/integrations/jamsocket/
- S15 — https://github.com/nitrojs/nitro/issues/2171
- S16 — https://docs.netlify.com/build/functions/configuration/ (default values table)
- S17 — https://docs.netlify.com/build/functions/background-functions/ ; https://docs.netlify.com/build/functions/scheduled-functions/
- S18 — https://docs.netlify.com/build/caching/caching-overview/
- S19 — https://ably.com/pricing
- S20 — https://pusher.com/channels/pricing/
- S21 — https://developers.cloudflare.com/durable-objects/platform/pricing/
- S22 — WebSearch: https://github.com/cloudflare/partykit ; https://npmx.dev/package/partyserver
- S23 — https://www.netlify.com/changelog/2026-04-28-netlify-database/
- S24 — https://www.netlify.com/changelog/2026-04-13-netlify-db-ga-coming-soon/ ; WebSearch snippet from https://tessl.io/registry/skills/github/netlify/context-and-tools/netlify-database
- S25 — https://www.netlify.com/blog/netlify-database/
- S26 — https://neon.com/blog/netlify-db-powered-by-neon
- S27 — https://docs.netlify.com/build/data-and-storage/netlify-database.md
- S28 — https://docs.netlify.com/build/data-and-storage/netlify-database/api.md
- S29 — https://docs.netlify.com/build/data-and-storage/netlify-database/getting-started/
- S30 — https://docs.netlify.com/build/data-and-storage/netlify-database/migrations.md
- S31 — https://docs.netlify.com/build/data-and-storage/netlify-database/local-development/
- S32 — https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/
- S33 — https://docs.netlify.com/build/data-and-storage/netlify-blobs.md (and /netlify-blobs/)
- S34 — https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/
- S35 — https://www.netlify.com/pricing/ and https://www.netlify.com/pricing.md
- S36 — https://docs.netlify.com/build/functions/usage-and-billing/
- S37 — https://docs.netlify.com/build/async-workloads/overview/
- S38 — https://docs.netlify.com/build/async-workloads/get-started/
- S39 — https://docs.netlify.com/build/async-workloads/writing-workloads.md
- S40 — https://docs.netlify.com/build/async-workloads/multi-step-workloads.md ; https://docs.netlify.com/build/async-workloads/lifecycle/
- S41 — https://docs.netlify.com/build/async-workloads/limitations/ ; https://docs.netlify.com/build/async-workloads/optional-configuration.md
- S42 — https://github.com/nitrojs/nitro/blob/main/src/presets/netlify/preset.ts and runtime/netlify.ts (via `gh api`)
- S43 — https://nitro.build/deploy/providers/netlify ; raw docs/2.deploy/20.providers/netlify.md
- S44 — https://docs.netlify.com/build/frameworks/framework-setup-guides/nuxt/
- S45 — https://github.com/netlify/framework-adapters (packages/nuxt-module/{package.json,README.md})
- S46 — https://github.com/netlify/primitives (packages/dev/README.md)
- Docs index used to locate pages: https://docs.netlify.com/llms.txt
