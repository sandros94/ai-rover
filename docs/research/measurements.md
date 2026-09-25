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

## Local platform emulation

`@netlify/nuxt` 1.0.1 under `nuxt-nightly@5.0.0-29796419` (Nitro 3 beta, h3 v2), 2026-09-25:

- Boots with `netlify.edgeFunctions.enabled = false`; with Edge emulation on, the bundled Deno launcher rejects the machine's Deno 2.9 (`unexpected argument '--allow-scripts'`) and Nuxt restarts in a loop.
- Emulated features reported: aiGateway, blobs, database, environmentVariables, functions, geolocation, headers, images, redirects, static.
- Blobs: `getStore` with strong consistency reads back the value written by a previous request from a Nitro handler; `Netlify-CDN-Cache-Control` and `Netlify-Cache-Tag` headers pass through untouched (CDN behaviour itself is not emulated).
- Database: `getDatabase().sql` answers from the local PGlite, which with the `@electric-sql/pglite` 0.5.8 override reports PostgreSQL 18.3.
