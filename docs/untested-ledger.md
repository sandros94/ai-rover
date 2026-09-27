# Untested surfaces ledger

Numbered list of what is known to be unverified. Reviewed at every milestone start. An item is removed once verified (the evidence goes in the relevant research note or decision); git history keeps the trail.

1. Nuxt UI 4.11 on `nuxt-nightly@5x`: boots and renders the starter page; per-component behaviour unverified.
2. Nitro `netlify` preset build of a Nuxt 5 nightly app deploys and serves SSR on Netlify (the `node-server` preset builds locally and the output contains no development-only code).
3. Netlify sync Function timeout: docs say 60 s hard; forum threads say 10 s default / 26 s configurable. Which applies to Functions v2 today?
4. Rapier `-deterministic-compat` 0.20 cold-start cost and steps/s in Node on Netlify (only matters if a rigid-body producer ever replaces the kinematic one).
5. Blobs served through a Function with `Netlify-CDN-Cache-Control … durable`: observed cache hit behaviour and purge latency.
6. Blob storage/bandwidth pricing on the credit plans (not itemised in the credits table).
7. Netlify DB storage billing status after 2026-07-01.
8. Jev free tier / credits and p50 latency for ~2k-token states.
9. Jev Choice quality with many numerically similar options (jaggedness page gives no threshold).
10. TresJS 5.9 / `@tresjs/nuxt` 5.7 on Nuxt 5 nightly: works in avelune, not verified here; mobile frame budget unmeasured.
11. `unauth` main via pkg.pr.new pins `unsecure ^0.2.2`; coexistence with `unsecure` 0.3.1 unverified (semver-breaking).
12. Hand-rolled AT Protocol public client: DPoP nonce retry and handle/DID resolution against a real PDS untested.
13. Ejecta-thickness constants (McGetchin 1973) cited second-hand.
14. Client-side planner preview performance on phones over a 500 m disk of terrain.
15. Turn-in-place rate of 3°/s: no published Perseverance figure found.
16. Slip model constants (gain 1.2, stuck above 0.6 for 3 m, loose-regolith noise at 80 m wavelength): judgement calls, untested against the JPL slip data beyond the qualitative 50–94 % figures.
17. `drizzle-orm/netlify-db` driver against a deployed Netlify Database (HTTP + WebSocket pool inside Functions): only PGlite and the local emulation have run.
18. Migration application on a real deploy: Netlify applies `netlify/database/migrations/*/migration.sql` before publish; unexercised until the first deploy.
19. `unauth` `defineSession` does not forward `sessionHeader` to `unjwt`, so a sealed session token is also accepted from a request header, not only the cookie; upstream fix pending, then pass `sessionHeader: false`.
20. `unjwt` always adds `cty: application/json` to a `dpop+jwt` header; bsky.social accepted it, other authorization servers untested.
21. Nitro bundles h3 rc.22 while the project pins rc.29; both load side by side and work, but the mixed versions are unverified beyond the current routes.
22. Jev re-judgments at settlement run inside the tick transaction under the advisory lock; an upstream outage stalls settlement until it answers.
23. The local PGlite data directory (`.netlify/db`) was corrupted once by an abrupt dev-server kill (`RuntimeError: Aborted()` at start); moving it aside and letting the module re-migrate fixed it. Unknown whether the platform emulator guards against this.
24. Real GitHub and AT Protocol sign-ins in a browser: only the PAR leg of atproto ran live; the callback and the GitHub flow ran on mocked responses.
25. The 3D scene on a phone: 60 fps on a desktop GPU measured; mobile frame rate and the ~235 KB gzip three.js chunk unmeasured on real devices.
26. `@tresjs/nuxt` pins `@nuxt/kit` 4.1 and logs a deprecated devtools call; behaviour under the Nuxt 5 nightly beyond the playground unverified.
27. Chunk blobs carry the true heights and traversable bits of unrevealed ground, so a script combining them with the public plan can anticipate where a drive stops short. Accepted as a known limitation: the views hide fogged ground, and only the served chunks expose it.
28. The attempt cap is checked before an insert without being atomic with it; concurrent submits can exceed it by a few.
29. Lock ordering between settlement, withdrawals and likes is tested on call order only: the local test database runs every connection in one session, so two-connection races are unverified.
30. The reachability flood fill crosses unseen ground, so whether a seen vertex is pathable can depend on hidden terrain.
31. Netlify's CDN may normalise `Accept-Encoding` before caching variants of the journey blobs; the identity/deflate split is unverified on a deploy.
32. The end-to-end flow has been exercised locally with scripted browsers (two users, plan, submit, LGTM, flag, drive, settlement, replay, phone width); the failure path (not-moving cut, three strikes, reset) is covered by unit tests only, never by a scripted browser run.
33. A denied GitHub consent (callback with `error=` and no `code`) is treated as a fresh start and bounces back to GitHub instead of showing `refused`.
