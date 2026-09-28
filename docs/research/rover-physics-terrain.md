# Research: rover physics, terrain, planning, rendering, pacing

Date: 2026-09-23. Evidence-based; every number cites a fetched source (see Sources, [Sn]). Items I could not confirm from a fetched page are tagged **UNVERIFIED**.

---

## 1. Perseverance reference facts

| Fact | Value | Source |
| --- | --- | --- |
| Mass | 1,025 kg (2,260 lb) | [S1] NASA rover-components; [S2] Wikipedia (dry mass) |
| Length x width x height | 3.0 m x 2.7 m x 2.2 m (NASA rounds; Wikipedia gives 2.9 x 2.7 x 2.2 m) | [S1], [S2] |
| Wheels | 6, each own motor, 52.5 cm (20.7 in) diameter, aluminium, 48 grousers, curved Ti spokes | [S1] |
| Odometry | one wheel turn, no slip = 1.65 m | [S1] |
| Suspension | rocker-bogie (differential + rocker + bogie); climbs obstacles/depressions "as large as the rover's wheel" | [S1] |
| Tilt tolerance (mechanical) | "designed to withstand a 45-degree tilt in any direction without tipping over" | [S1] |
| Obstacle / clearance | "drive over knee-high rocks up to 15.75 inches (40 centimeters)". Explicit belly-pan ground clearance not on NASA page; treat ~0.4 m as design obstacle height. Exact clearance **UNVERIFIED** | [S1] |
| Top speed | "just under 0.1 mph (152 meters per hour)" = 0.042 m/s (NASA page). JPL 2021 press: "393 feet (120 meters) per hour" = 0.033 m/s (AutoNav effective) | [S1], [S3] |
| Typical AutoNav distance/sol | "drive about 200 to 300 meters with AutoNav on a single sol" (V. Verma); IEEE: avg 201 m/sol during delta approach; NASA: sol 404 = 256.55 m, sol 405 = 264.98 m | [S4], [S5], [S6] |
| Record single-sol drive | 411.7 m on sol 1540 (2025-06-19), ~4 h 24 min -> avg 0.026 m/s incl. stops; 403 of 411 m autonomous (AVOID_ALL). Previous 347.7 m sol 753 | [S7], [S8] |
| Slope, operational | ENav at landing: max terrain tilt allowed = 16 deg (Curiosity worst-case in sand); no AutoNav possible sol 1096-1159 due to tilts >16 deg; limit later raised (Monte Carlo); crater-rim ascent = first AutoNav on slopes >20 deg | [S8] |
| Slope, mechanical | 45 deg tilt without tipping [S1]. A "30 deg operator limit" appears in search snippets only -> **UNVERIFIED** | [S1] |
| Slip | slopes with >50% slip needed "Slip Tables"; up to 94% slip observed in loose material on rim | [S8] |

AutoNav / ENav behaviour (from JPL paper on ENav [S9] and ACE paper [S10]):

- Stereo navcam -> point cloud -> **2.5D heightmap centred on rover**; each XY cell height = mean of points in cell. ACE paper test setup used a **10 cm DEM** (runtime 10-15 ms/pose) [S10]. Costmap is "lower resolution but covers a larger area" than the heightmap [S9]. Flight cell size not stated in fetched text -> **UNVERIFIED** (10 cm heightmap / coarser costmap is the documented research config).
- Costmap cell cost = weighted sum of **tilt** (plane-fit), **roughness** (mean squared residual from fitted plane), **min traverse time**; infinite if tilt extreme, plane-fit fails, or keep-in/keep-out zone violated. Unimaged cells get a finite cost above flat-known terrain [S9].
- Candidate paths: tree of constant-curvature arcs (rover cannot steer while driving): 14 turns-in-place x 11 arcs of 3 m x 11 arcs of 3 m = 1,694 paths, ~6 m lookahead [S9]. Ranked by cost (arc time + costmap samples + Dijkstra cost-to-go); then **ACE** (kinematic clearance/tilt/suspension-angle bounds, interval arithmetic over rocker-bogie kinematics) run every **25 cm** along the best path until one passes [S9], [S10]. Only the first 1 m of arc (or first 30 deg of turn) is executed, then replan [S9].
- Planning cycle ~3-4 s on RAD750; evaluating all 1,694 paths with ACE would be >22k calls, >3 min [S9]. Perseverance "thinks while driving"; it stops "when it cannot quickly determine a safe path" (i.e. when all cheap candidates fail ACE) [S3], [S5]. Modes: AVOID_ALL (avoid hazards + keep-out zones), GUARDED (stop at obstacle), UNGUARDED (blind) [S8].

Gravity: Mars equatorial surface accel 3.69 m/s^2 (NSSDC; 3.71 is the mean value commonly quoted), sol = 24.6597 h [S11]. The mission is Mars throughout (rover, gravity, sol, terrain), so every Perseverance figure applies unchanged; the Moon's 1.62 m/s^2 [S12] is kept only as the reference for a possible later lunar mission, where the same mass would carry 44% of the normal load (lower traction, longer stopping, more bounce).

---

## 2. Physics: real-time rigid-body vs kinematic vs hybrid

### (a) Full rigid-body simulation

**Rapier** (Rust -> WASM, `@dimforge/rapier3d*`, Apache-2.0; latest 0.20.0 published 2026-08-08 for `rapier3d`, `rapier3d-compat`, `rapier3d-deterministic-compat`) [S13].

- Determinism doc [S14]: the JS/WASM build "is fully cross-platform deterministic": same simulation, same initial conditions -> identical results "on two different machines (even with different browsers, operating systems, and processors)". Conditions: all bodies/colliders/joints created with identical values **and in identical order**; anything you compute with `Math.sin/cos` etc. before feeding Rapier is _not_ guaranteed cross-platform. Verify via `world.createSnapshot()` + hash.
- npm variant matrix (search summary + registry) [S15], [S13]: `-deterministic` = "less optimized build that guarantees cross-platform deterministic execution"; `-compat` = WASM base64-embedded for bundlers; `-simd` = fastest, no determinism claim. Rust feature `enhanced-determinism` = "cross-platform determinism ... across all 32-bit and 64-bit platforms that implement IEEE 754-2008 strictly"; incompatible with `simd8` [S16].
- Practical reading: the strong claim lives in the `-deterministic` package; if you pick plain `rapier3d-compat`, cross-machine bit-equality is **not** what dimforge promises. Node/serverless: WASM loads fine in Node; `-compat` avoids `.wasm` asset issues in bundlers (Nitro). Cold-start cost of instantiating ~2 MB WASM each invocation is real but unmeasured here (**UNVERIFIED** numbers).
- Heightfield collider exists; the `three-terrain-lod` README notes it exports "heightfield collision data for any physics engine" [S17].

**Jolt** (`jolt-physics` 1.1.0, 2026-07-11, MIT, Emscripten port) [S13], [S18]: 7 build variants (wasm-compat, multithread, asm...). Cross-platform determinism requires a **custom build** with `-DCROSS_PLATFORM_DETERMINISTIC=ON`; the stock npm build has no such entrypoint (search summary: "cross-platform determinism remains unproven" for stock; ~8% perf cost when enabled) [S18], [S19]. Heavier to integrate than Rapier for a JS-first team.

**cannon-es** (0.20.0, last publish 2022-08-12, MIT) [S13], [S20]: pure JS, no determinism statement, effectively dormant. Not recommended for a "real and accurate" target.

**ammo.js**: not fetched; Bullet-via-Emscripten, no cross-platform determinism claim known -> **UNVERIFIED**, skip.

Cost reality: a rocker-bogie with 6 wheel joints + 2 bogie joints + differential on a heightfield at 60-120 Hz for a 100 m / 40-min real-time segment = 144k-288k steps. Feasible in a 10-26 s Netlify sync function only if you accelerate (physics dt fixed, but wall-clock is CPU-bound, a few k steps/s of a small world is plausible) -> borderline; background function (15 min) is safe. **UNVERIFIED** throughput; benchmark before committing.

### (b) Kinematic terrain-following

Pose = heightmap sample + surface normal along a planned path; speed = f(slope, roughness), capped at 0.042 m/s; roll/pitch from plane fit under the 6 wheel contact points (or ACE-style closed-form rocker-bogie kinematics [S10] if you want authentic suspension angles). Determinism: trivially, if noise + interpolation are pure functions over fixed seeds (avoid `Math.sin` differences by baking heightmap samples into the segment record, cf. Rapier warning [S14]). Cost: O(path length / step). This is _what the real rover software does_ for planning safety (ACE is kinematic, not dynamic) [S10].

### (c) Hybrid: server precompute -> keyframes -> client interpolation

Simulate once server-side (a or b), emit keyframes (t, x, y, z, quat, wheel angles, suspension angles, speed) at e.g. 2-5 Hz plus events (stop, replan, slip); store as JSONL; clients interpolate (slerp) and drive wheel spin from arc length. Replay is byte-exact by construction: determinism moves from "engine" to "data", which is the only guarantee that survives engine upgrades (Rapier's promise holds for the _same_ engine version only; not stated for upgrades -> assume no).

### Recommendation

1. **Keyframes are the source of truth** (c). Whatever produces them, the client never re-simulates. Rapier's cross-platform determinism is nice-to-have, not load-bearing.
2. **Producer = kinematic model (b) first.** Matches how JPL plans (heightmap + plane-fit tilt/roughness + ACE clearance) [S9], [S10]; deterministic and cheap enough for a 10 s sync function; phone-safe playback. Add slip as a deterministic function of slope (data point: >50% slip on loose steep rim terrain [S8]).
3. Only if a "physics feel" gap shows up: swap the producer for `@dimforge/rapier3d-deterministic-compat` in a **background function** (15 min limit) [S21], keep the same keyframe contract. Keep the physics behind that contract so the swap is a one-module change.

Netlify limits (for sizing): background functions 15 min, available on Free/Personal/Pro/Enterprise credit plans [S21]; default memory 1024 MB, Pro/Enterprise up to 4096 MB with proportional vCPU [S22]; synchronous timeout: 10 s default, 26 s configurable — from forum/support threads only, not confirmed on a docs page I could fetch -> **UNVERIFIED** [S23], [S24]; the support guide I fetched says "30 second execution limit" [S24], so take 10-26 s as the planning envelope.

---

## 3. Terrain generation (Mars-like, pathable, reproducible)

**Base relief: fBm of simplex noise.** Sum octaves with frequency x2 and amplitude x0.5 (`[1, 1/2, 1/4, ...]`), normalise by amplitude sum; optional `pow(e, exponent)` redistribution for flat maria vs highlands; give each octave its own seed or offset so low-frequency octaves are not correlated near the origin [S25]. Red Blob recommends `simplex-noise` and FastNoiseLite for JS [S25].

**Craters superposed on top** (standard "stamp" approach):

- Profile = parabolic bowl + raised Gaussian rim + thin ejecta blanket; power-law size-frequency distribution; large craters flat-floored (complex morphology) [S26].
- Ejecta thickness (McGetchin et al. 1973, used by the CTEM lunar landscape-evolution code): `h = h_rim * (d / r)^-3`, rim height `~0.14 * R_km^0.74 * 1e3` m [S27] (from search summary of CTEM/arXiv 1902.07746; formula widely cited, treat exact constant as **UNVERIFIED** until you read McGetchin directly).
- LPSC 2023 lunar sim used an "averaged topographic profile of lunar craters <2 km diameter" as a template stamped onto LOLA DEMs (10 m/px regional, 5 m/px local) [S28] -> same stamp idea, DEM-based.
- Blending: apply craters oldest -> newest so fresh ones overprint (Alien-Worlds does craters as the last pipeline stage) [S26]; scale rim/bowl by a per-crater "age" factor to soften.

**Chunking / infinite world.** Heightmap is a pure function `h(x, y, seed)`: noise is inherently unbounded; craters need a deterministic placement scheme: hash each coarse "crater cell" (e.g. 256 m) with the world seed to decide crater count/centres/radii inside it, and when generating a chunk also evaluate craters from neighbouring cells whose radius + ejecta reach across the border. Chunks (e.g. 64-128 m, 0.5-1 m cells) are then independently generatable server- or client-side. avelune streams 32x32-tile chunks over one socket [S29]; `three-terrain-lod` uses quadtree chunks with skirts [S17].

**Seeding.** One 64-bit world seed -> derived seeds per layer (noise octaves, crater cells, rock scatter) via a hash (splitmix/xxhash), never `Math.random`. `simplex-noise` v4 takes a PRNG function so it is seedable: `createNoise2D(prng)` is what `shared/utils/terrain/world.ts` uses, with per-octave mulberry32 generators. Keep generation in integer/float32-safe pure JS; avoid `Math.sin` in the height function if you need bit-exact cross-device heights [S14] (or accept tiny drift and use server-authored heights only where it matters: the keyframes).

**Pathability guarantee.** Per cell, slope from central differences (`atan(|grad h|)`) at rover-cell scale; traversable if slope <= limit (16-20 deg operational per [S8]; 30 deg if you allow "risky") and roughness below a threshold (JPL: plane-fit residual [S9]). Then:

1. Flood-fill / connected components over traversable cells; keep the component containing the spawn; either (i) reject & re-roll seed if the largest component is < X% of area (avelune-style "re-roll on failed validation" is the common pattern [S30]), or (ii) _repair_: carve a smoothed corridor (Gaussian-blur the height along a minimum-slope-cost path between components), which keeps the seed but requires storing the repair as part of the world record.
2. For an infinite world, do this per chunk with a border-consistency rule: guarantee at least one traversable "gate" per chunk edge by construction (e.g. force crater exclusion + low-amplitude noise in a 4 m band around chunk-edge midpoints) so components chain across chunks without global analysis.
3. Destinations proposed by users are snapped to the nearest cell in the rover's component; the planner (Sec 4) then always has a path.

Noise libs on npm (registry, 2026-09-23) [S13]: `simplex-noise` 4.0.3 (MIT, 2024-07), `open-simplex-noise` 3.0.0 (Unlicense, 2026-08), `fastnoise-lite` 1.1.1 (MIT, 2024-03; fBm/ridged/cellular built in, seed int).

---

## 4. Path planning on the heightmap

- **A\*** on 8-connected grid with cost = distance * (1 + w_s * slope_cost + w_r * roughness_cost), infinite for slope > limit / keep-out. Mirrors ENav's cell cost (tilt + roughness + time) [S9]. Cheap; paths zig-zag at 45 deg multiples.
- **Theta\*** (any-angle A*): parent may be any line-of-sight ancestor; paths up to ~13% shorter than A* at "comparable runtime"; extended to non-uniform traversal costs [S31]. Good fit for open lunar plains where straight lines matter.
- **D\* / Field D\***: incremental replanning when the map changes; only worthwhile if you simulate _unknown terrain being discovered mid-drive_ (Perseverance's actual situation: unimaged cells get intermediate cost [S9]). For a turn-based server-computed segment with full map knowledge, plain A*/Theta* + a post-hoc "AutoNav stops" heuristic is enough.
- Rover-faithful option: reproduce ENav's arc-tree (turn-in-place set, then fixed-curvature 3 m arcs, ~6 m horizon, pick best, execute 1 m, repeat) [S9]. Produces authentic non-holonomic motion and natural "stop and think" events. Compute is bounded and deterministic.
- Cell size: ACE research used 10 cm DEM [S10]; ENav checks ACE every 25 cm [S9]; rover footprint ~2.7 x 3.0 m [S1]. Recommendation: **0.25 m heightmap cells** near the path for clearance checks (rock-scale, matches ACE interval), **1 m costmap cells** for A*/Theta* (matches JPL's coarser costmap idea [S9]). Roughness at 1 m = plane-fit residual over the 4x4 fine cells. Rocks < 40 cm are drive-over [S1]; anything taller = obstacle.
- Costs (starting weights): slope term `(tan(slope)/tan(limit))^2` (quadratic like ENav's squared-gradient heuristic [S9]), roughness term normalised to an obstacle-height threshold, plus turn penalty for the arc-tree variant.

---

## 5. Rendering (short)

- Three.js `PlaneGeometry` + per-vertex displacement from the chunk heightmap (CPU) or a displacement texture in a vertex shader (GPU; three has built-in displacementMap on standard materials). Normals from Sobel of the heightmap [S17].
- LOD: `@interverse/three-terrain-lod` 2.1.1 (MIT, 2026-04-20, peer three >= 0.183): quadtree LOD by camera distance, instanced chunks (single draw call), edge skirts for crack-free transitions, LOD hysteresis, TSL/WebGPU-ready default material, heightfield export for physics [S13], [S17]. Heightmap comes from an image URL/canvas/raw data, so procedurally generated chunks fit. Classic chunked-LOD reference (quadtree + screen-space error + skirts) is discussed in three.js issue #507 [S32].
- TresJS (registry 2026-09-23) [S13]: `@tresjs/core` 5.9.0 (peer vue >= 3.4, three >= 0.133), `@tresjs/nuxt` 5.7.0 (2026-09-14, bumps core to 5.9.0) [S33], `@tresjs/cientos` 5.9.0. Tres v5 announces "full support for Nuxt 4", WebGPU renderer, ESM-only [S34]; the nuxt module repo was archived 2026-02 and merged into the `Tresjs/tres` monorepo [S35]. Nuxt 5 support is not stated anywhere I fetched; Nuxt latest stable is 4.5.2, Nuxt 5 targeted Q4 2026 via `nuxt-nightly` [S36] -> **UNVERIFIED** compatibility, but see avelune below.
- **avelune** (benjamincanac) [S29], [S37]: Nuxt on `nuxt-nightly@5.0.0-…` + `nitro` 3 beta + `h3` 2 rc, `@tresjs/core ^5.9.0`, `@tresjs/nuxt ^5.7.0`, `three ^0.186.0`, `@nuxt/ui` 4, `zod` 4, Upstash Redis. Layout `app/` (Vue + composables), `shared/` (types/utils), `server/` (game logic, 20 Hz authoritative tick, crossws WebSocket), `public/`, `scripts/`. Notes: 32x32-tile chunk streaming, client-side prediction, procedurally generated terrain, runtime-generated textures. Caveat they state: single-instance-per-region because roster/chunk cache live in one function's memory. So: Tres 5 on Nuxt 5 nightly is demonstrably running; no Cientos, no LOD lib used (from package.json).
- Phone budget: keep visible chunks ~9 (3x3 of 128 m at 1 m = 16k verts each) at LOD0; renderer `powerPreference: 'high-performance'`, pixel ratio clamp <= 2.

---

## 6. Time scale and turn-based pacing

Real numbers: cap 0.042 m/s (152 m/h) [S1]; effective AutoNav ~0.026-0.033 m/s incl. stops [S3], [S7]. So 100 m = ~40 min at cap, ~50-65 min effective; a full 250 m sol-drive ~2.5-4.5 h [S7]. Nobody will watch that live; but "turn-based, users check back a few times a day" fits a sol-like cadence.

Candidate rules:

- **Rule A – Real-time clock, accelerated viewer.** Segment happens in wall-clock at real speed (100 m -> ~40-60 min); the UI shows a live "rover position" and lets you scrub/replay at 60-200x (NASA's own AutoNav video is "sped up by roughly 200 times" [S6]). Pacing: 3-6 segments/day of 100-300 m; feels like a mission. Cost: server must resolve a pending segment lazily (compute on request when its end time passes; no cron needed).
- **Rule B – Sol-batch.** One "sol" = a real-world day (or 12 h). Users queue up to ~250 m of goals (typical AutoNav sol [S4]); at sol rollover the server computes and publishes the drive; playback at 100x (250 m in ~1.5-2.5 min). Simplest server: one background function per sol. Pacing matches "check back a couple of times a day" exactly but feels slow for new users.
- **Rule C – Hybrid budget.** Each user/mission has a per-day driving budget (e.g. 300 m or 3 h rover-time) and segments resolve instantly (sync function, <10 s) but are stamped with mission-time; playback at 100x, with a "live" mode at 1x for the last N metres. Keeps engagement while the odometer/mission clock stays honest (411.7 m/sol is the record [S7]; enforce 300 m/day as the AutoNav-realistic cap).

Suggested default: **C**, with the mission clock advancing by simulated drive time (distance / effective speed + stop events) and the day budget derived from the 200-300 m/sol figure. Show real elapsed time in the HUD so "accurate" remains true even though playback is accelerated.

## 7. Steering: how the rover turns

Perseverance "shares much of its physical and electrical design" with Curiosity, including the 4.2 cm/s top wheel speed [S41], so Curiosity's mobility papers describe it: ten identical wheel-and-steer actuators, six driving and four steering; "the middle wheels are not steerable" [S38]. Only eight motor controllers serve the ten actuators, so the rover uses a **steer-then-drive** architecture: brakes released, front and rear wheels steered to their angles, brakes engaged, then the drive step runs [S38]. Steering therefore happens standing still, before the motion that needs it.

- **Turn in place.** "Implemented by steering the four corner wheels to approximately 45 degrees off-forward-axis, and driving them in the same clockwise or counter-clockwise direction"; the centre does not translate, and the corner wheels "must be steered back" before driving on [S39]. Each corner wheel's axle points at the rover's centre; the rear wheels, closer to the middle axle, "steer to a slightly smaller angle than the front wheels" [S38]. Entering and leaving the stance costs up to 90° of steering per wheel [S39].
- **Arcs.** "Traditional double Ackermann steering control, pointing each corner wheel independently along a tangent to the turning circle for that wheel's radius" [S38]. In constant-speed mode the wheel on the widest circle turns at the top rate, 0.168 rad/s (4.2 cm/s), "with other wheels' rates set in proportion" [S38].
- **Limits.** Steering has a hard stop at ±95° and a software limit of ±85° from the longitudinal axis [S38]; the URDF leaves the steer joints unlimited [S40].

Values used (body geometry from §1 and the URDF [S40]):

| Quantity | Value | Basis |
| --- | --- | --- |
| Turn-in-place stance | front ±48.0°, rear ±45.3° | axle at the centre: `atan(x / y)` of each corner wheel [S38], [S39] |
| Turn-in-place rate | 0.0264 rad/s ≈ 1.51°/s | outer corner wheel (1.59 m from the centre) at the 4.2 cm/s cap [S38] |
| Steering rate | 0.168 rad/s ≈ 9.6°/s, ≈ 5 s into the stance | **UNVERIFIED**: no figure published; the steer actuators are identical to the drive ones [S38], whose output rate this is |
| Minimum arc radius | 1.17 m | inner corner wheels at the ±85° software limit [S38] |
| Re-steer threshold | 2° | judgement call |

---

## Sources

- [S1] https://science.nasa.gov/mission/mars-2020-perseverance/rover-components/ (mass, dims, wheels, rocker-bogie, 45 deg tilt, 152 m/h, 40 cm rocks, 1.65 m/turn)
- [S2] https://en.wikipedia.org/wiki/Perseverance_(rover) (1,025 kg; 2.9x2.7x2.2 m; 44.98 km as of 2026-08-24)
- [S3] https://www.jpl.nasa.gov/news/nasas-self-driving-perseverance-mars-rover-takes-the-wheel/ (120 m/h, "thinking while driving", VCE, 48 grousers)
- [S4] https://www.planetary.org/planetary-radio/vandi-verma-perseverance-autonav-sample-collection (200-300 m/sol with AutoNav)
- [S5] https://spectrum.ieee.org/perseverance-mars-rover-autonomous-driving (201 m/sol avg; ~1,700 paths, ~6 m; stops when no safe path quickly)
- [S6] https://science.nasa.gov/resource/autonav-drives-perseverance-forward/ (sol 404/405 distances; video sped up ~200x)
- [S7] https://www.jpl.nasa.gov/images/pia26645-nasas-perseverance-breaks-own-rover-driving-record/ (411.7 m sol 1540, 4 h 24 min; 347.7 m sol 753)
- [S8] https://www-robotics.jpl.nasa.gov/media/documents/2026_RO_AAS_final.pdf (JPL, "Robotic operations power Perseverance's ascent of Jezero crater": 16 deg initial tilt limit, >20 deg AutoNav on rim, slip tables >50%, 94% slip, drive modes, 403/411 m autonomous)
- [S9] https://arxiv.org/pdf/2011.06022 (Abcouwer et al., "Machine Learning Based Path Planning for Improved Rover Navigation": ENav heightmap/costmap, cost terms, 14x11x11 arc tree, ACE 25 cm, 1 m execution, RAD750 timing)
- [S10] https://arxiv.org/pdf/1808.00031 (Otsu et al., "Fast Approximate Clearance Evaluation": kinematic rocker-bogie bounds, 10 cm DEM, 10-15 ms/pose, collision checks "typically tens of cm")
- [S11] https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html (3.69 m/s^2 equatorial; day 24.6597 h)
- [S12] https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html (1.62 m/s^2)
- [S13] https://registry.npmjs.org/ (queried 2026-09-23 via curl for: @dimforge/rapier3d, -compat, -deterministic-compat 0.20.0 Apache-2.0; @tresjs/core 5.9.0; @tresjs/nuxt 5.7.0; @tresjs/cientos 5.9.0; simplex-noise 4.0.3; open-simplex-noise 3.0.0; fastnoise-lite 1.1.1; cannon-es 0.20.0; jolt-physics 1.1.0; @interverse/three-terrain-lod 2.1.1; three 0.186.0; nuxt 4.5.2)
- [S14] https://rapier.rs/docs/user_guides/javascript/determinism (cross-platform determinism statement + conditions + Math.sin caveat)
- [S15] Web search summary of https://www.npmjs.com/package/@dimforge/rapier3d-deterministic (page itself returned 403; "-deterministic = less optimized build guaranteeing cross-platform determinism"; -compat = base64 wasm)
- [S16] https://rapier.rs/docs/user_guides/javascript/getting_started/ (page served Rust-crate feature text: `enhanced-determinism`, IEEE 754-2008, incompatible with simd8)
- [S17] https://registry.npmjs.org/@interverse/three-terrain-lod README (quadtree LOD, instancing, skirts, hysteresis, heightfield export, TSL material; peer three >= 0.182 in README, >= 0.183 in package.json)
- [S18] https://github.com/jrouwe/JoltPhysics.js (build variants, `-DCROSS_PLATFORM_DETERMINISTIC=ON`, MIT)
- [S19] Web search summary re Jolt stock npm determinism (slamdemonium PR #21; ~8% cost) — secondary, UNVERIFIED
- [S20] https://github.com/pmndrs/cannon-es (MIT, no determinism statement)
- [S21] https://docs.netlify.com/build/functions/background-functions/ (15 min, plan availability, 202 response)
- [S22] https://docs.netlify.com/build/functions/usage-and-billing/ (1024 MB default, up to 4096 MB Pro/Enterprise)
- [S23] Web search summary of Netlify forum threads (10 s default / 26 s configurable sync timeout) — UNVERIFIED on docs
- [S24] https://answers.netlify.com/t/support-guide-why-is-my-function-taking-long-or-timing-out/71689 ("30 second execution limit" sync; 15 min background)
- [S25] https://www.redblobgames.com/maps/terrain-from-noise/ (fBm octaves, redistribution, per-octave seeds, lib recommendations)
- [S26] https://github.com/bartsr94/Alien-Worlds-Generator (parabolic bowl + Gaussian rim + ejecta blanket, power-law SFD, craters last)
- [S27] Web search summary citing McGetchin et al. 1973 ejecta law `h = h_rim (d/r)^-3` and CTEM rim-height formula — formula constants UNVERIFIED
- [S28] https://www.hou.usra.edu/meetings/lpsc2023/pdf/2916.pdf (Gauthier & Wroblewski, LPSC 2023: averaged <2 km crater profile stamped on LOLA DEMs, 10 m / 5 m per px)
- [S29] https://github.com/benjamincanac/avelune (README: Nuxt/Tres/Nitro 3, 20 Hz tick, 32x32 chunks, single-instance caveat)
- [S30] Web search summary on flood-fill connectivity validation / re-roll pattern (gamedev.net tutorial, arXiv 2605.21397) — pattern-level only
- [S31] https://arxiv.org/abs/1401.3843 (Theta*: shorter than A* post-smoothed and Field D*, non-uniform costs extension)
- [S32] Web search result: https://github.com/mrdoob/three.js/issues/507 (chunked LOD quadtree + skirts discussion) — not fetched directly
- [S33] https://github.com/Tresjs/tres/releases/tag/%40tresjs/nuxt%405.7.0 (2026-09-14, bumps core 5.9.0)
- [S34] https://tresjs.org/blog/tresjs-v5 (Nuxt 4 support, WebGPU, ESM-only)
- [S35] Web search summary: Tresjs/nuxt repo archived 2026-02-01, moved to monorepo
- [S36] Web search summary: Nuxt 5 targeted Q4 2026; nuxt-nightly 5.0.0 available
- [S37] https://raw.githubusercontent.com/benjamincanac/avelune/main/package.json (exact dependency versions)
- [S38] https://www-robotics.jpl.nasa.gov/media/documents/2020-mobility-trending.pdf (Rankin, Maimone, Biesiadecki et al., "Driving Curiosity: Mars Rover Mobility Trends During the First Seven Years", IEEE Aerospace 2020: ten identical wheel and steer actuators, middle wheels not steerable, steer-then-drive, double Ackermann arcs, 0.168 rad/s = 4.2 cm/s top wheel rate with the others in proportion, ±95° hard / ±85° software steering limits, rear wheels steer less in a turn in place)
- [S39] https://www-robotics.jpl.nasa.gov/media/documents/Wheels_Made_for_Arcing.pdf (Maimone, Hilgemann, Abcouwer, Rollins et al., "These Wheels Are Made for Arc-ing", 2023: turn in place with the corner wheels about 45° off the forward axis, steered back before driving, up to 90° of steering per wheel into and out of it)
- [S40] https://github.com/nasa-jpl/m2020-urdf-models/blob/c422fc6d96f2684521fb64049448d611e670f140/rover/m2020.urdf (`LF/RF/LR/RR_STEER` revolute about the link's z, limits unbounded)
- [S41] https://www-robotics.jpl.nasa.gov/what-we-do/flight-projects/mars-2020-rover/m2020mobility/ (JPL Robotics, Mars 2020 mobility: shared design with Curiosity, 4.2 cm/s maximum wheel speed)
