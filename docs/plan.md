# Build plan (dependency order)

Each phase is thin: a wrong assumption in phase N should invalidate at most phase N+1. Phases are ordered by "what, if wrong, invalidates the most other work". Narrative counterpart: `docs/vision.md`.

## Phase 0 — Platform spikes (nothing depends on the answers being _yes_, everything depends on knowing)

- Nuxt 5 nightly (`nuxt-nightly@5x`) + Nuxt UI 4 + `@netlify/nuxt` (h3 v1 dep) + `@netlify/database-dev` (PGlite → PG 18 override) boot together, patched locally where they do not. Deploy a hello-world to Netlify with the Nitro `netlify` preset.
- Netlify Function CPU budget: measure how many kinematic steps a 1024 MB function does in 10 s (sizes the segment precompute: sync vs background function).
- Blobs → CDN: serve one blob through a function with `Netlify-CDN-Cache-Control … durable` + cache tag, verify hit/miss headers.
- Terrain-disk budget: time a 500 m disk (chunks + cost map + flood fill + viewshed at 1 m cells) in a 1024 MB function.
- Ledger items retire with the measured numbers.

## Phase 1 — World model (the data everything else reads) — terrain core, stop disks, revealed mask and manifests exist; segment record pending

- Deterministic Martian heightmap `h(x, y, seed)`: fBm simplex + crater stamps, chunked, hash-seeded, no `Math.random`, no host-dependent transcendental drift in stored data.
- On-demand computation: chunks, cost map, pathability and viewshed (line of sight from ~2 m mast height) for a ~500 m disk around each stationary point, computed server-side when the rover arrives there, stored as blobs (chunk data + revealed mask) and served via CDN. Benchmark this step in Phase 0.
- Slope/roughness masks, connected-component pathability with chunk-edge gates; destination snapping to the rover's component.
- Viewshed by XDraw sweep from mast height (measured ~15 ms per 500 m disk), accumulated into the revealed mask.
- Segment record schema (JSONL keyframes + events + outcome) — the wire format the journal, the replay and the live view all consume. This is the contract that survives engine swaps.

## Phase 2 — Planner + producer (server, pure functions over Phase 1) — dev viewer, planner, kinematics, producer and keyframe codec exist; slicing and time-gated release belong to Phase 4

- Dev-only 2D shaded-relief viewer of a stop disk (tagged `TODO(dev-only)`) to see the ground while tuning relief and craters.

- Theta* over the 1 m costmap (slope² + distance) on revealed cells, unrevealed cells at penalty cost, polyline smoothed into turn-in-place + arc motions; navigation metrics with every plan; 0.25 m clearance checks along the path sampled from the analytic height function (ENav/ACE-shaped). Roughness lives here, not in the 1 m chunk masks, where a smooth height function leaves it near zero.
- Rocker-bogie kinematics (ACE equations, geometry from `research/rover-geometry-mars-terrain.md`): wheel contacts, suspension angles, body pose, belly clearance, limit checks.
- Producer drives the true terrain motion by motion, replans on discovery, applies the slip model, stops at the last safe pose when the way is blocked, and records per-metre reveals.
- Segment record: binary 2 Hz keyframes plus events and reveal deltas, stored as time-indexed slices with release times.
- Kinematic terrain-following producer (Mars gravity, lunar look) → keyframes; failure detection (slope, obstacle, slip) → failed record with death pose.
- Safe-stop detection → intermediate checkpoint record (progress kept) vs hazard → failed record.
- Golden tests: fixed seed + fixed destination → byte-identical keyframes.

## Phase 3 — Jev judgments (over Phase 2 outputs) — done: summary labels, one-request judgment, cache, fixtures, offline experiment

- One request per submission: `feasible` (Noul), `distance_band` (Choice), `distance_confidence` / `time_confidence` (Score), `risk` (Score). Semantic labels in state, numbers computed in code.
- Early experiment: candidate-route Choice over 3–8 code-generated routes, compared against the code planner's own pick on recorded fixtures.
- Cache keyed by hash(state, questions, model); pin `jev-1.13.0`. Recorded fixtures for tests; live calls only in a tagged manual suite.

## Phase 4 — Persistence + lifecycle (Netlify DB + Blobs) — done: schema and migrations, local database module, lifecycle tick, submissions, likes, rounds, settlement, failure zones, public routes

- Schema: user, submission, like, segment (attempt), checkpoint; state machine idle → collecting → driving → arrived | failed.
- Journal writer: one immutable blob per attempt; CDN route with cache tags.
- Segment resolution: lazy, in the first request after window close, under a DB lock (background function only if the Phase 0 measurement demands).

## Phase 5 — Auth — done: session module, GitHub, AT Protocol public client, login page

- JWE cookie session (`unauth` h3v2 + `unjwt`) with nuxt-auth-utils-like DX; GitHub OAuth hand-rolled; AT Protocol OAuth hand-rolled public client (PAR, PKCE, DPoP via `unjwt`/`unsecure`, handle→DID→PDS discovery), login-only.

## Phase 6 — Live delivery + UI — data layer done (journey client, chunk cache, sampler, playback clock, slice stream, composables); development module and playground exist

- Keyframe playback against wall-clock + polled CDN-cached mission-state endpoint (see `docs/decisions.md`).
- Ten instruments built in the playground (attitude, speed and efficiency, sol clock, event feed, slip, reveals, planner telemetry, judgment card, round countdown, journey stats). Done.
- Tres/Three stop-disk scene with LOD, procedural rover, trail, ghosts and route: on the public page behind a 2D/3D toggle, fog lifting with the drive's reveals. Remaining: the hero rover model.
- Journey: `/drives` lists settled drives; `/drives/<id>` replays one on the disk and mask the rover knew then.
- Dashboard assembly: done on the home page with live playback, vote cards and the instrument grid.
- 2D fogged picking map with relief, client-side path preview using the shared planner, submit → server judgment. Done.

## Phase 7 — Failure voting, resets, moderation, community

- Not-moving flags with scaled quorum and automatic backstop; moderator pause; `/community` tallies; winner-may-submit precedence; auto self-LGTM; LGTM and planning-phase naming.
- Drive realism: no per-metre stops, imaging stops, AutoNav status events and HUD element.
- Fog that hides on both views; relief with contours; full-viewport HUD layout with floating panels; 3D default.
- JPL URDF hero rover.
- Multi-segment replay: done.
- Inspectable map objects: done on the live page; the replay page is not inspectable yet.

## Later — Biomes

- Biome regions in the height function (parameter sets selected by low-frequency noise), rover ground analysis surfaced on the map, biome labels in Jev state.

- Community "not moving" vote fallback, 3-strike reset to the previous checkpoint, exclusion zone around failed spots for new submissions.
