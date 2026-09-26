# Research: Perseverance 3D model for the rover viewer (2026-09-26)

Scope: NASA's Perseverance GLB (facts from files downloaded and parsed locally), mobile budgets, compression
options, measured decimation/compression results, procedural alternative, recommendation.
Measurements below were produced locally with a small Node script that parses the GLB JSON chunk
and `npx @gltf-transform/cli@latest` (dedup/weld/simplify/webp/resize/draco/meshopt/join). KTX2 was NOT
produced (no `ktx`/`toktx` binary here); KTX2 sizes are estimates and marked UNVERIFIED.

## 1. NASA Perseverance model: where, formats, numbers, hierarchy, terms

Two official variants exist (same base mesh, different exports):

| | GitHub NASA-3D-Resources GLB (2024 Blender 4.2 export) | science.nasa.gov GLB (2020 Blender 2.8 export, id 25042) |
|---|---|---|
| URL | `raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/Mars%202020%20Perseverance%20Rover/Mars%202020%20Perseverance%20Rover.glb` | `assets.science.nasa.gov/content/dam/science/psd/mars/resources/gltf_files/25042_Perseverance.glb` |
| Size on disk | 4,987,176 B (4.76 MiB) | 11,687,880 B (11.15 MiB; matches page's "11.15 MB") |
| Generator | Khronos glTF Blender I/O v4.2.57 | Khronos glTF Blender I/O v1.1.46 |
| Extensions | KHR_draco_mesh_compression (REQUIRED), clearcoat, transmission, specular, ior, EXT_texture_webp | none |
| Meshes / primitives / nodes | 68 / 252 / 88 | 65 / 249 / 66 |
| Vertices (sum of POSITION counts) | 138,783 | 213,130 |
| Triangles (indices/3) | 199,521 | 199,309 |
| Materials / textures / images | 47 / 40 / 44 (22 unique images, each stored twice: webp + jpeg/png fallback) | 48 / 37 / 24 |
| Image sizes | 1024x1024 (x13 base/normal), 1024x512 (blade), 512x512 (x5), 256x256 (x3), 128/64 px masks | 1024x1024 (x12), 1024x512 (x2), 512x512 (x5), 256 (x3), 128, 64 |
| Animations / skins | 23 clips, 1 skin (15 bones; mast/arm/covers) | 0 / 0 |
| Draw calls as-authored (node instances x primitives) | 252 | 249 |
| Extra files in same folder | `.blend` 21,936,989 B; `.png` preview 867,821 B | USDZ 12.70 MB (page) |

Sibling: `.../3D Models/perseverance-GLB/GLB/Perseverance.glb` path cited by search results returns an HTML 404 page
(downloaded 269 KB of HTML) - the real path is the "Mars 2020 Perseverance Rover" folder above.

Heaviest nodes (GitHub GLB): `Wheels_objs` 34,788 verts / 68,016 tris (34% of the model, 3 primitives);
`suspension` 16,044 / 25,334; `Body_Parts` 8,449 / 11,919; `rtg` 6,345 / 11,444; `lab` 8,787 / 8,342.

**Articulation: NOT possible for mobility from either GLB.** All six wheels are a single node/mesh
(`Wheels_objs`, 3 primitives); rockers, bogies, differential and steering knuckles are one node (`suspension`,
7 primitives). No node named rocker/bogie/differential/wheel_* exists. Articulated nodes present: robotic arm
chain (`arm.003 > arm.002 > arm > arm.004`, turret parts), mast (`Cylinder > bottom > top > Cylinder.002`, head
via Armature bones), hazcam covers, `arm_01/02_joint > _pivot`, probe. Splitting wheels/suspension would require
Blender work on the `.blend` (21.9 MB, provided) - fully possible but manual.

**Articulated alternative: NASA-JPL `m2020-urdf-models`** (github.com/nasa-jpl/m2020-urdf-models, released
2022-06-10, "Credit NASA/JPL-Caltech", modeling by Zareh Gorjian). `rover/m2020.urdf` (53 KB, 114 joints incl.
fixed camera frames) has the real kinematic tree with revolute joints `CENTER_DIFFERENTIAL`, `LEFT/RIGHT_DIFFERENTIAL`,
`LEFT/RIGHT_BOGIE`, `LF/LR/RF/RR_STEER`, `LF/LM/LR/RF/RM/RR_DRIVE`, plus RSM/HGA/arm/drill joints. Meshes are
per-link glTF+bin pairs: `Left/Right_Rocker` (215 KB bin each), `Left/Right_Bogie` (239 KB), `CenterDifferential`
(68 KB), `Steer_*` (179-343 KB), `Wheel_*` x6, `CHASSIS` (4.44 MB), `Turret` (4.88 MB), arm links 0.09-1.56 MB;
single atlas texture `M2020_Rover_Texture_{1k,2k,4k,8k}.jpg` (0.8 / 3.0 / 4.6 / 19.1 MB). Total .bin for
mobility links only (rockers+bogies+diff+steer+wheels) ~2 MB before decimation (wheel .bin sizes not fetched -
UNVERIFIED). Repo has no LICENSE file (GitHub API `license: null`); usage falls back to NASA media guidelines
(UNVERIFIED that JPL applies identical terms; README only says "Credit NASA/JPL-Caltech").

**Usage terms** (NASA Images and Media Usage Guidelines, linked from the NASA-3D-Resources README which says
assets are "free and without copyright"): "NASA content - images, audio, video, and media files used in the
rendition of 3-dimensional models, such as texture maps and polygon data in any format - generally are not subject
to copyright in the United States." Educational/informational use including "computer graphical simulations and
Internet Web pages" is allowed; commercial use "must not explicitly or implicitly convey NASA's endorsement";
"NASA should be acknowledged as the source"; NASA insignia/logotype are NOT public domain (the GLB has a
`Name_Chips`/nameplate material - check for logos before shipping); no NFT/crypto use. Not CC0-licensed formally;
the Sketchfab "CC0" mention in search snippets is a third-party re-upload, UNVERIFIED.

## 2. Mobile budgets and compression options

Budgets (web, single hero object):
- three.js forum (donmccurdy): "aim for <100 draw calls for the visible objects at any given time"; "a 4K PNG
  might be a very small file, but still consumes ~100 MB of GPU memory including mipmaps"; PNG/JPEG/WebP are
  uncompressed on the GPU; KTX/Basis stay compressed and "can also improve render time a bit".
- low-poly.com 2026 budget post (secondary source): mobile web 30k-150k tris on screen; hero 3k-10k;
  product configurator up to 50k; AR/model-viewer 10k-30k tris and GLB < 3 MB; "A 12 MB GLB will tank LCP".
- model-viewer docs: use DRACO only when savings exceed decoder cost; DRACO/KTX2/meshopt decoders are loaded
  on demand and must be configured before first load; renderer auto-scales resolution to hold 38-60 fps.
- Khronos KTX guide: ETC1S = 8 B per 4x4 block (0.5 B/px, RGB) / 16 B RGBA; UASTC = 16 B per 4x4 block (1 B/px);
  ETC1S for color/albedo, UASTC for normal/ORM. Example: StainedGlassLamp JPG+PNG 13 MB file / 96 MB GPU -> KTX
  10 MB / 21 MB GPU; Duck PNG 118 KB / 1.5 MB GPU -> ETC1S 116 KB / 277 KB GPU (-82% GPU).
- Uncompressed 1024^2 RGBA = 4 MiB (+33% mips ~5.3 MiB). The NASA GLB's 13 1k textures ~70 MiB GPU with mips;
  as ETC1S ~9 MiB, as UASTC ~17 MiB (block-size arithmetic from Khronos numbers; not measured).

Decoders (three r0.186.1 on jsDelivr, content-length): Draco `draco_decoder.wasm` 192,420 B + wrapper 58,456 B;
`meshopt_decoder.module.js` 29,256 B (wasm inlined); Basis `basis_transcoder.wasm` 527,333 B + js 57,529 B.
Decode throughput: meshoptimizer README "1-3 GB/s" in wasm SIMD (js README), "3-6 GB/s" native; Draco slower -
svilenkovic.com: Draco 50-80% mesh reduction vs meshopt 30-60%, meshopt "5-10x faster decode"; for "1-3 hero
models, Draco wins", for 50+ meshes meshopt wins. No mobile ms benchmarks found (UNVERIFIED).
Measured here on this model: meshopt output was SMALLER than Draco in every case (see 3) because the file is
texture-heavy and meshopt also compresses the 23 animations; gzip on top of meshopt still helps (-19%).

gltf-transform commands used: `dedup`, `weld`, `simplify --ratio R --error E` (meshoptimizer simplifier; can't
always hit R due to per-primitive topology limits), `webp`, `resize --width --height`, `draco`, `meshopt`,
`join` (merge primitives sharing material), `etc1s`/`uastc` (need KTX-Software `ktx` on PATH - failed here).

## 3. Measured decimation/compression of the GitHub GLB (this session)

Pipeline: dedup -> weld (decodes Draco; 10.0 MB raw) -> simplify -> webp (drops jpeg/png fallbacks) -> [resize 512] -> draco|meshopt.

| Variant | Tris | Verts | Prims (draw calls) | GLB bytes | gzip'd |
|---|---|---|---|---|---|
| original (Draco, webp+jpeg dup) | 199,521 | 138,783 | 252 | 4,987,176 | - |
| weld, no compression | 199,521 | 138,483 | 252 | 10,006,244 | - |
| simplify 0.25/0.01 ("~50k" target) | 61,163 | 51,853 | 252 | 6,445,348 | - |
| simplify 0.075/0.2 ("~15k" target; floor hit) | 21,041 | 23,449 | 248 | 5,202,856 | - |
| 61k + webp 1k | 61,163 | | 252 | 4,319,256 (images 1,530,878) | 2,490,821 |
| 61k + webp 1k + draco | | | 252 | 2,712,928 | - |
| 61k + webp 1k + meshopt | | | 252 | 2,417,600 | 1,970,000 |
| 61k + webp 512 + draco | | | 252 | 1,829,328 | - |
| 61k + webp 512 + meshopt | | | 252 | 1,533,540 | - |
| 21k + webp 1k + meshopt | 21,041 | | 248 | 2,131,972 | - |
| 21k + webp 512 + meshopt | | | 248 | 1,247,668 | 878,628 |
| 61k + join (before compression) | | | 146 | - | - |
| 21k + join | | | 135 | - | - |

Notes: simplify cannot get below ~21k tris with 248 separate primitives (many tiny parts hit their floor);
reaching 15k needs `join` first or manual merge. `join` cut draw calls 252 -> 146/135; the floor is 47 materials
plus animated nodes kept separate; an atlas + material merge (manual/Blender) is needed to go under ~50.
KTX2 estimate (UNVERIFIED, from Khronos block sizes + typical BasisLZ): 22 unique images at 1k ETC1S ~0.6-1.0 MB
on disk vs 1.53 MB webp; 512 px ~0.2-0.3 MB. So a realistic shipped hero: ~1.2-1.8 MB GLB at 61k tris, ~0.9-1.2 MB
at 21k, plus one-time decoder cost (meshopt 29 KB, Basis 585 KB - the Basis transcoder outweighs the KTX2 saving
for this model unless textures are also used elsewhere, e.g. terrain).

## 4. Procedural low-poly rocker-bogie (boxes/cylinders, ~2-5k tris)

Built in code from solver joint state (rocker/bogie/differential angles, 6 wheel spins, 4 steer angles), i.e.
the same joint set as the JPL URDF. Estimated: 6 wheels x 32-seg cylinder (~190 tris each with caps) ~1.1k;
rocker/bogie/diff links as 10 boxes ~120; body box + RTG cylinder + mast cylinder+box ~300; total ~1.5-2.5k.
1 material, 1-3 draw calls if merged; ~0 KB download; no decoders. Fidelity lost vs NASA GLB: wheel cleat/grouser
pattern and spokes; arm+turret, cameras, antennas, RTG fins, cables, instrument detail; PBR textures/decals;
nameplates; the 23 authored animations; silhouette recognisability at close zoom. Kept: correct proportions if
dimensions taken from URDF link origins (UNVERIFIED that origins are in meters - typical for URDF).

## Recommendation

| Option | Tris | Draw calls | Download (est.) | Articulates suspension? | Effort | Fidelity |
|---|---|---|---|---|---|---|
| A. NASA GLB decimated (61k, webp/KTX2 1k, meshopt) | 61k | 146 (join) -> ~50 with atlas | 1.5-2.4 MB (+29 KB decoder; +585 KB if KTX2) | No - wheels/suspension are single meshes; needs Blender split of `.blend` | medium-high (Blender) | high |
| B. Procedural rocker-bogie from solver joints | 2-3k | 1-3 | ~0 | Yes, by construction | low-medium (code) | low |
| C. Both: procedural as instant/LOD1 + NASA GLB as LOD0 lazy-loaded | 2k / 61k | 3 / ~50-146 | 0 now, 1.5-2 MB later | LOD1 yes; LOD0 only if split | highest | high near, correct far |
| D. JPL URDF meshes (mobility links only) decimated | ~? (bins ~2 MB raw, UNVERIFIED tri count) | ~15 links | est. 0.5-1 MB after simplify+meshopt (UNVERIFIED) | Yes - real joints, real link meshes | medium (URDF -> glTF assembly, atlas resize) | high, no arm/turret unless added |

Pick: C if hero visuals matter, with D as the LOD0 source instead of A (it is the only NASA asset whose
wheels/rocker/bogie/differential are already separate links with named revolute joints, and its joint names map
1:1 to the solver). A alone cannot show suspension articulation without manual mesh surgery. B alone is fine for
the solver-driven view and costs nothing; ship it first, add D/A lazily.

## Sources (fetched/downloaded this session)
- https://science.nasa.gov/resource/mars-perseverance-rover-3d-model/ (glTF 11.15 MB, USDZ 12.70 MB, credit NASA/JPL-Caltech)
- https://assets.science.nasa.gov/content/dam/science/psd/mars/resources/gltf_files/25042_Perseverance.glb (downloaded, parsed)
- https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Models/Mars%202020%20Perseverance%20Rover and GitHub contents API (sizes); GLB downloaded via raw.githubusercontent.com and parsed
- https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/README.md ("free and without copyright", links usage guidelines)
- https://www.nasa.gov/nasa-brand-center/images-and-media/ (usage guideline quotes)
- https://science.nasa.gov/3d-resources/ (redirect target of nasa3d.arc.nasa.gov; refers to usage guidelines)
- https://github.com/nasa-jpl/m2020-urdf-models + raw README, `rover/m2020.urdf`, contents API for `rover/meshes` and `Textures`
- https://discourse.threejs.org/t/texture-performance/24297 (donmccurdy quotes)
- https://modelviewer.dev/examples/loading/index.html (decoder guidance)
- https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXArtistGuide.md and KTXDeveloperGuide.md
- https://github.com/zeux/meshoptimizer and js/README.md (decode speeds, simplifier)
- https://svilenkovic.com/3d/draco-vs-meshopt (Draco vs meshopt ratios/decode)
- https://gltf-transform.dev/cli, /modules/functions/functions/simplify, /textureCompress
- https://low-poly.com/blog/polygon-budgets-by-platform-2026 (secondary; budgets)
- https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/... (decoder byte sizes via HEAD)
