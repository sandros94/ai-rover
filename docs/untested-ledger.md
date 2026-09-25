# Untested surfaces ledger

Numbered list of what is known to be unverified. Reviewed at every milestone start. An item is removed once verified (the evidence goes in the relevant research note or decision); git history keeps the trail.

1. Nuxt UI 4.11 on `nuxt-nightly@5x`: boots and renders the starter page; per-component behaviour unverified.
2. Nitro `netlify` preset build of a Nuxt 5 nightly app deploys and serves SSR on Netlify.
3. Netlify sync Function timeout: docs say 60 s hard; forum threads say 10 s default / 26 s configurable. Which applies to Functions v2 today?
4. Rapier `-deterministic-compat` 0.20 cold-start cost and steps/s in Node on Netlify (only matters if Q3 picks rigid-body).
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
