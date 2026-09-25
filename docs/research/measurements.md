# Measurements

Numbers this project's sizing decisions rest on. Each entry names the machine or environment it was taken on; a desktop figure is an upper bound on what a Netlify Function (1024 MB, fractional vCPU) will do, not a substitute for it.

## Terrain disk, 500 m radius, 1 m cells (1,002,001 cells)

Throwaway Node script, 2026-09-25, AMD Ryzen 9 5950X, Node 24, single thread, `simplex-noise` 4.0.3.

| Step | Time | Notes |
| --- | --- | --- |
| Heightmap: 6-octave fBm + 40 crater stamps | ~190 ms | Float32 array, plain loops |
| Slope + traversable mask (16°) | ~10 ms | central differences |
| Flood fill from nearest traversable cell, 8-connected | ~25 ms | 61 % of the disk reachable with this seed |
| Viewshed from centre, mast 2 m, naive ray per cell | 1.6–1.9 s | O(cells × radius); 9.8 % of the disk visible from this spot |
| Viewshed, XDraw sweep (ring-by-ring, interpolated max slope) | ~15 ms | O(cells); 10.3 % visible; agrees with the ray-cast on 99.0 % of cells (XDraw's known interpolation error, slightly generous) |
| Kinematic producer, 250 m at 0.042 m/s, 10 Hz | ~4 ms | 130,616 steps, ~35 M steps/s |

Reading: with the XDraw sweep the whole disk computes in about a quarter of a second on a desktop, so even a 5–10× slower Function CPU stays well inside a synchronous call. The naive ray-cast is kept only as the reference for XDraw's accuracy. The kinematic producer is effectively free, so segment resolution stays in the synchronous path.

## Terrain core as implemented (`shared/utils/terrain`)

Desktop, 2026-09-25, three seeds:

| Step                                      | Time       |
| ----------------------------------------- | ---------- |
| `generateChunk`, 3×3 block of 64 m chunks | 8–17 ms    |
| `sampleHeights`, 1001×1001 vertices       | 160–175 ms |
| Traversable mask, 1001²                   | ~5 ms      |
| Flood fill, 1001²                         | 20–23 ms   |
| XDraw viewshed, radius 500, 1001²         | 16–19 ms   |

XDraw against a half-cell bilinear ray oracle on generated terrain (200×200, radius 99, five seeds): 99.5–99.8 % agreement.

Default world parameters produce benign ground: over a 500 m disk heights span about −17 to +12 m, 97.8–99.3 % of vertices are traversable at 16°, 97–99 % are reachable, and 24–36 % are visible from a 2 m mast. Blocked ground will need more relief or crater density than the defaults; that tuning is an open question in `docs/decisions.md`.

Chunk format v1: 20-byte header + 5 bytes per vertex, 21,145 bytes per 64 m chunk before compression.

## Stop disks as implemented (`computeStopDisk`, radius 500 m, three seeds)

| Measure | Value |
| --- | --- |
| Chunks per disk | 224 (16×16 bounding box minus 32 corner chunks outside the circle) |
| Assembled grid | 1025 × 1025 vertices |
| Compute time (desktop) | 207–252 ms |
| Chunk blobs per disk, raw | ~4.74 MB (224 × 21,145 B) |
| Visible vertices from the stop | 187k–283k (18–27 % of the grid) |
| Revealed mask blob after one stop | 50–66 KB (94–122 chunks, 537 B each) |
| Manifest JSON | ~15 KB |

Revealed mask format v1: 16-byte header ("JRRV", version, flags, vertexCount, cellSize, chunkCount) then per chunk `i32 cx, i32 cy` and ⌈vertexCount²/8⌉ packed bits, chunks sorted by (cy, cx).

The 4.7 MB of raw chunk data per stop is the number to watch for the browser: compression, a narrower first fetch, or a compact height encoding are the levers (open question in `docs/decisions.md`).

## Segment planner as implemented (`shared/utils/nav`)

Desktop, 2026-09-25, 500 m disk, goal 250 m away, revealed = the stop's own viewshed:

| Seed | Disk build | Plan | Expansions | Detour ratio | Max slope | Unrevealed share | Turns in place |
| --- | --- | --- | --- | --- | --- | --- | --- |
| mars | 239 ms | 264 ms | 124,534 | 1.05 | 6.4° | 0.43 | 1 |
| jezero | 233 ms | 161 ms | 82,096 | 1.63 | 8.6° | 0.01 | 10 |
| gale | 229 ms | 109 ms | 51,234 | 1.03 | 10.6° | 0.19 | 3 |

Theta\* on the 1 m grid plans a full segment in well under a second on a desktop, comparable to the disk build itself, so the plain A\* fallback is not needed. Default cost weights (slope weight 4, unrevealed penalty 3) and the blend rule (2 m radius, turn in place above 30°) are untuned.

## Rover kinematics as implemented (`shared/utils/rover`)

Desktop, 2026-09-25, `poseOnTerrain` on the `mars` world, 2,000 random poses, belly sampling included: ~0.09 ms per solve (~11,000 solves/s), ~141 height samples per solve (80 belly samples, ~61 for about three Newton iterations). An hour and a half of driving at 10 Hz is ~54k solves, about 5 s. A 20k-step drive in 4 mm steps had a worst wheel-height error of 1.4e-11 m. Default flat link angles: rocker 37.9°, bogie 60.7°.

## Producer as implemented (`shared/utils/drive`)

Desktop, 2026-09-25, seed `mars`, 500 m disk:

| Run | Compute | Sim steps | Replans | Planning share | Reveal share |
| --- | --- | --- | --- | --- | --- |
| 150 m at 10 Hz | 3.9 s | 50,830 | 0 | 53 ms | 80 ms |
| 250 m at 10 Hz, three goals | 5.6–6.7 s | 84–88k | 0 | 53–387 ms | 107–136 ms |
| 250 m at 2 Hz (now the default) | 1.7 s | 17.5k | 0 | 166 ms | 121 ms |

About 95 % of the time is the pose solve at every step. Effective flat-ground speed 0.0331 m/s (100 m in 3,024 s). Keyframes 547 KB per hour raw, ~1.3 MB per 250 m. Events JSON ~26 KB per 250 m, mostly per-metre pauses. Reveal deltas 1.2k–22k vertices (5–90 KB) per 250 m, at most ~245 vertices in one metre. The 50 m corridor viewshed on the 1025² grid costs 0.8–1.3 ms per metre.

Interpolation at 2 Hz against re-solved poses over 500 random times: max wheel height error 5.7e-5 m, max wheel-to-ground gap 5.8e-5 m, body height 4.8e-6 m.

The default terrain produced no replans and no slip events on any run: the relief tuning is what will make drives eventful.

## Storage as implemented (`server/utils/journey`, local Netlify Blobs emulation)

Deflate (`CompressionStream('deflate')`, served with `content-encoding: deflate`):

| Blob                         | Raw     | Deflated | Ratio |
| ---------------------------- | ------- | -------- | ----- |
| 224 chunks of one 500 m disk | 4.74 MB | 3.34 MB  | 0.70  |
| Revealed mask after one stop | 50 KB   | 8 KB     | 0.16  |
| 59 slices of a 150 m drive   | 570 KB  | 418 KB   | 0.73  |
| Two manifests                | 15.6 KB | 1.6 KB   | 0.10  |

Publishing a stop takes ~660 ms cold and ~170 ms when every chunk already exists; a segment ~70 ms. A chunk served through the route is ~15.6 KB on the wire.

## Jev judgment as measured (`server/utils/jev`, six recorded submissions, 2026-09-25)

| Case | Route summary | Feasible | Distance conf. | Time conf. | Risk | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| mars, north, short | 81 m, nearly straight, moderate slope, mostly seen, mostly loose | 0.60 | 3.19 | 2.42 | 1.48 | review |
| mars, east, long unseen | 235 m, nearly straight, gentle, mostly unseen, mostly loose | 0.18 | 1.00 | 1.35 | 2.55 | reject |
| jezero, detour | 119 m, long detour, moderate, mostly seen, some loose ground | 0.44 | 1.92 | 2.46 | 1.02 | review |
| jezero, blocked | no route (goal blocked) | 0.03 | 0.16 | 0.09 | 2.99 | reject |
| gale, mostly unseen | 140 m, nearly straight, moderate, mostly unseen | 0.24 | 1.05 | 1.16 | 2.66 | review |
| gale, detour | 176 m, moderate detour, moderate, mostly seen | 0.81 | 2.99 | 2.20 | 1.03 | accept |

About 1,150 input tokens per judgment (~$0.00005); nine live requests recorded everything (12.7k tokens). The route-choice experiment (three seeds, six cost settings each) showed Jev's top pick never matching the planner's cheapest route and probability piling onto the first of identically labelled candidates; see the withdrawn decision.

## Local platform emulation

`@netlify/nuxt` 1.0.1 under `nuxt-nightly@5.0.0-29796419` (Nitro 3 beta, h3 v2), 2026-09-25:

- Boots with `netlify.edgeFunctions.enabled = false`; with Edge emulation on, the bundled Deno launcher rejects the machine's Deno 2.9 (`unexpected argument '--allow-scripts'`) and Nuxt restarts in a loop.
- Emulated features reported: aiGateway, blobs, database, environmentVariables, functions, geolocation, headers, images, redirects, static.
- Blobs: `getStore` with strong consistency reads back the value written by a previous request from a Nitro handler; `Netlify-CDN-Cache-Control` and `Netlify-Cache-Tag` headers pass through untouched (CDN behaviour itself is not emulated).
- Database: `getDatabase().sql` answers from the local PGlite, which with the `@electric-sql/pglite` 0.5.8 override reports PostgreSQL 18.3.
