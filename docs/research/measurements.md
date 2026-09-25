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

## Local platform emulation

`@netlify/nuxt` 1.0.1 under `nuxt-nightly@5.0.0-29796419` (Nitro 3 beta, h3 v2), 2026-09-25:

- Boots with `netlify.edgeFunctions.enabled = false`; with Edge emulation on, the bundled Deno launcher rejects the machine's Deno 2.9 (`unexpected argument '--allow-scripts'`) and Nuxt restarts in a loop.
- Emulated features reported: aiGateway, blobs, database, environmentVariables, functions, geolocation, headers, images, redirects, static.
- Blobs: `getStore` with strong consistency reads back the value written by a previous request from a Nitro handler; `Netlify-CDN-Cache-Control` and `Netlify-Cache-Tag` headers pass through untouched (CDN behaviour itself is not emulated).
- Database: `getDatabase().sql` answers from the local PGlite, which with the `@electric-sql/pglite` 0.5.8 override reports PostgreSQL 18.3.
