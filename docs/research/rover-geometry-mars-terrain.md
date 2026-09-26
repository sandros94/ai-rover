# Research: rocker-bogie geometry + Mars terrain statistics (2026-09-25)

Evidence-based; every number cites a fetched source [Sn] or is tagged DERIVED (computed here from a fetched source) or UNVERIFIED (search snippet / secondary / not confirmed).

## Part 1 — Rocker-bogie geometry (Perseverance ≈ Curiosity chassis)

### 1.1 Published dimensions

| Item | Value | Source |
| --- | --- | --- |
| Perseverance body L×W×H | 3.0 × 2.7 × 2.2 m; 1025 kg | [S1] |
| Perseverance wheel diameter | 52.5 cm (20.7 in), 48 grousers, 1.65 m/rev | [S1] (52.6 cm in [S2]) |
| Perseverance wheel width | "narrower than Curiosity's"; no official number found. Model-derived 0.335 m (DERIVED, [S4]) | [S2][S3] |
| Curiosity wheel | 50 cm dia × 40 cm wide, 6 identical wheels | [S5] p.2 |
| Curiosity body | 2.9 × 2.7 × 2.2 m, 899 kg; ground clearance 60 cm; max obstacle 65 cm; tilt 30° operational, ≥50° survivable | [S6] (Wikipedia — secondary, UNVERIFIED) |
| Obstacle capability (M2020) | drives over rocks/depressions "as large as the wheel" (52.5 cm); "knee-high rocks up to 40 cm"; 45° tilt without tipping, ops avoid >30° | [S1] |
| Belly-pan clearance | not published directly. M2020 landing constraint: P(rock taller than **0.6 m** under belly pan) < 0.5 % ⇒ belly clearance ≈ 0.6 m (DERIVED). Model belly bottom 0.67 m above wheel-contact plane (DERIVED [S4]) | [S7][S4] |
| Suspension articulation range | "250 mm" (UNVERIFIED, LabXchange page text not retrievable) | [S8] |
| MER design rules (for scale) | 20 cm obstacle, 45° static stability, ≤6 g; body not below 20 cm ground height | [S9][S10] |
| Rover NAV frame | origin = midpoint of middle-wheel axles on flat ground; +X forward, +Z down (MSL SPICE FK) | [S11] |

### 1.2 Wheel layout — DERIVED from NASA's official GLB models [S4][S12]

Method: parsed glTF nodes; clustered wheel-mesh vertices per side / longitudinal gap. Models are metric (Perseverance scene bbox 2.705 m wide × 2.232 m tall; wheel mesh height 0.526 m = 52.5 cm ⇒ scale validated). Coordinates: X lateral, Y up (ground = 0), Z forward (+Z = arm/hazcam side, RTG at −Z).

| Wheel      | Perseverance centre (x, y, z) m | Curiosity centre z (m) |
| ---------- | ------------------------------- | ---------------------- |
| Front L/R  | (∓1.063, 0.263, +1.095)         | +1.098                 |
| Middle L/R | (∓1.185, 0.263, −0.090)         | −0.087                 |
| Rear L/R   | (∓1.063, 0.263, −1.165)         | −1.162                 |

- Longitudinal (rover frame origin at middle axle): front **+1.185 m**, middle 0, rear **−1.075 m**; wheelbase front→rear **2.26 m**. Identical (±3 mm) in the Curiosity model ⇒ same chassis.
- Track (centre-to-centre): front/rear **2.13 m**, middle **2.37 m** (middle wheels protrude; outer edge = 2.705 m overall width). Lateral centres taken as outer-edge − half wheel width; ±2 cm.
- Wheel radius 0.263 m; wheel width (Perseverance model) 0.335 m; Curiosity official 0.40 m [S5].
- Pivots (exact, from the JPL `m2020-urdf-models` URDF at commit c422fc6, converted to x forward / z up): rocker (differential) pivot at x +0.304, z 0.893; bogie pivot at x −0.450, z 0.663, i.e. 0.45 m behind the middle axle. The earlier mesh-eyeballed estimates (rocker x +0.34 / z 0.92, bogie x −0.33 / z 0.85) were 12–19 cm off.
- Link lengths that follow: rocker pivot→front wheel 1.083 m, rocker pivot→bogie pivot 0.788 m; bogie pivot→middle wheel 0.602 m, bogie pivot→rear wheel 0.742 m. Flat-ground link angles: rocker 35.6°, bogie 41.6°. URDF wheel mounts sit at y ±1.0625 (front/rear) and ±1.1845 (middle), 2.5 mm from the values used here.
- Body (model): belly bottom y ≈ 0.67 m, body z-extent −1.18…+0.90 m, width 1.55 m.

### 1.3 Rocker-bogie kinematics — ACE, Otsu et al. arXiv 1808.00031 [S13]

Frames: body frame forward-right-down (FRD); origin at centre of middle wheels at ground-contact height on flat ground; wheel "heights" z point **down** (larger z = wheel lower). Terrain from DEM/point cloud.

Triangle primitive (Fig. 5; sides l_ca, l_ab, included angle φ_a):

- (1) z_c = z_a − l_ca · sin κ(z_a, z_b)
- (2) κ(z_a, z_b) = φ_a + asin((z_a − z_b)/l_ab); solution exists only if |z_a − z_b| ≤ l_ab.

Rocker-bogie (per side; f,m,r = front/middle/rear wheel; b = bogie joint; d = differential/rocker joint; l_bm = bogie-joint→middle-wheel link; l_df = differential→front link; κ_d0, κ_b0 = initial rocker/bogie link angles on flat ground):

- (8) z_b = z_m − l_bm · sin κ_b(z_m, z_r)
- (9) z_d = z_f − l_df · sin κ_d(z_f, z_b)
- (10) δ_l = −δ_r = [κ_d(z_f^r, z_b^r) − κ_d(z_f^l, z_b^l)] / 2 (rocker angles relative to body; differential forces equal & opposite)
- (11) β_l = κ_d(z_f^l, z_b^l) − κ_b(z_m^l, z_r^l) − κ_d0 + κ_b0 (12) β_r likewise (bogie angles)
- (13) roll φ = asin((z_d^r − z_d^l) / (2·y_od)) y_od = lateral offset body-centre→differential joint
- (14) pitch θ = κ_d0 − [κ_d(z_f^l, z_b^l) + κ_d(z_f^r, z_b^r)] / 2 (= body pitch is the mean of the two rocker link angles)
- (15) body height z_o = (z_d^l + z_d^r)/2 + x_od·sinθ·cosφ − z_od·cosθ·cosφ (x_od, z_od = offsets origin→differential joint) Belly pan is rigid to body ⇒ clearance from z_o, θ, φ; ACE's conservative clearance = lowest belly-pan point (plane w_p × l_p at nominal clearance c_0, eq. 31) minus highest ground point under the pan (eq. 32).

ACE bounding (Sec. 3): per wheel a rectangular "wheel box" in body x-y covers the footprint over all attitudes/suspension states; take min/max terrain height in each box ⇒ [z_i]; propagate through (21)–(30) using monotonicity of asin; worst case of the 8 min/max combinations of the 3 wheels per side (Fig. 7). Bogie-angle bounds are deliberately loose. Note: for M2020 the convex minimum of (1) "is located outside of the mechanical limits" so monotonic intervals are valid.

Safety metrics used for M2020 (Sec. 3.6, no numeric thresholds given in paper): ground clearance > threshold; body tilt (from roll+pitch) < threshold; suspension angles within predefined ranges; wheel drop (span of wheel-height uncertainty) < threshold.

Numeric limits from Curiosity flight ops (Rankin et al., JPL) [S5]: nominal flight limits **bogie 17°, differential 7°, pitch/roll ±15°, tilt 30°** (limits raised per-drive when simulation predicts more). Max experienced through sol 2488: bogie 25.2°, differential 9.4°, pitch 25.22°, roll 20.69°, tilt 25.34°. Wheelie: bogie angle rising while a wheel spins freely (sol 313, +11.9°). Tilt = angle between body z-axis and gravity. Bogie angle increases when middle wheel climbs and/or rear wheel descends.

Recommended sim limits: warn at tilt 30°, pitch/roll 15°, bogie 17°, differential 7°; hard fail (tip-over) at 45° [S1]; clearance fail if terrain under belly-pan plane < 0 with c_0 = 0.60 m.

## Part 2 — Mars terrain statistics for the procedural heightmap

### 2.1 Rover-scale slopes

- M2020 engineering constraints: slopes **< 25–30° at 2–5 m length scales**; **< ~100 m relief over 1–1000 m baselines**; rock abundance ≈ 12 % max (see 2.2) [S7][S14].
- HiRISE DTM (1 m/post) adirectional slope statistics for M2020 candidate DTMs, mean / SD in degrees [S15, Table 1] (baseline not stated in table; abstract lists 1-, 2-, 5-m for HiRISE, 20 m for CTX ⇒ assume 1 m; CTX rows are 20 m): Jezero_W 4.5/4.2, Jezero_C 6.7/4.9, Jezero_CE 4.0/3.6, Jezero_E 4.2/3.3, Jezero_XW (CTX) 5.5/5.1; Columbia Hills 3.2–4.6/2.5–3.7; NE Syrtis 4.7–6.2/3.9–4.7. "Jezero and NE Syrtis contain slopes at local scales that pose a hazard… small enough to be avoidable using TRN."
- InSight (Elysium plains, smoothest case): mean slope at 1 m baseline **3.2°**, **>99 % of area < 15°** [S16].
- Martian lava-flow plains, HiRISE profiles at 2–12 m: RMS slope **1.5–1.7° ± 0.8°** (range 0–7°), **Hurst H = 0.7 ± 0.1** (0.4–0.9) [S17]; another set: RMS slope 0.2–11°, H 0.5–0.8 [S18].
- DERIVED exceedance fractions at ~1 m (gamma fit to mean/SD above; judgement): Jezero_W-like (4.5/4.2): >10° ≈ 11 %, >15° ≈ 3–4 %, >20° ≈ 1 %. Jezero_C-like (6.7/4.9): >10° ≈ 20 %, >15° ≈ 8 %, >20° ≈ 3 %. InSight-like: >15° < 1 %.

### 2.2 Rock abundance (Golombek exponential model)

- Model: **F_k(D) = k·exp[−q(k)·D]**, F = cumulative fractional area covered by rocks ≥ D (m), k = total rock CFA, **q(k) = 1.79 + 0.152/k** [S19]. Viking/Pathfinder sites k = 5–40 % [S19].
- k values: Phoenix 2 %, Spirit 5 %, InSight ≈ 3 % (near-field 0.6–5 %, orbital 4–5 %) [S20]. Jezero: "CFA up to 15–20 % based on orbital reconnaissance", higher than any previous rover site; GESTALT planner "frequently fails" at 10 % CFA; ACE tests used 5/10/15/20 % [S13].
- DERIVED from the model (rocks per hectare): k=0.05: >0.3 m 820, >0.5 m 140, >1 m 4; k=0.10: 2150 / 510 / 31; k=0.15: 3430 / 910 / 73. CFA(>0.5 m) = 0.45 / 1.9 / 3.7 %.
- Recommend k = 0.07–0.10 for floor plains; 0.15 for rocky patches. Belly-pan hazard ⇒ rocks > 0.4 m are the drive-over limit [S1]; 0.6 m is the landing belly-pan criterion [S7].

### 2.3 Small-crater size-frequency (2–100 m)

- Hartmann (2005) Table 2, col. 9 — **1.0 Gyr isochron, craters/km² per √2 diameter bin** (bin lower edge → value; verified against craterstats config) [S21][S22]: 3.9 m: 4040 · 5.5 m: 2330 · 7.8 m: 1140 · 11 m: 458 · 15.6 m: 191 · 22 m: 66.6 · 31 m: 24.0 · 44 m: 9.44 · 62.5 m: 3.30 · 88 m: 1.22 · 125 m: 0.437 · 177 m: 0.147 · 250 m: 0.047 · 1 km: 3.08e-4. Hartmann & Daubar (2016) revision for D < 31 m [S22]: 3.9 m: 11000 · 5.5 m: 4200 · 7.8 m: 1600 · 11 m: 600 · 15.6 m: 190 · 22 m: 67 (then same as above). Chronology (Hartmann 2005 as corrected by Michael 2013): N(1 km) = 3.79e-14·(e^{6.93T} − 1) + 5.84e-4·T, T in Gyr ⇒ densities scale ≈ linearly with age for T < 3 Gyr [S22].
- DERIVED: cumulative N(>D) ∝ D^−2.8 for 10–100 m (per-√2-bin ratio 2.6–3.0); production sum for D 4–125 m ≈ 8.3e3 (H2005) or 1.8e4 (H&D2016) per km² per Gyr.
- Project value: 16 craters / 256 m cell with radii 2–60 m ≈ **244 km⁻²** ⇒ production-equivalent age ≈ 30 Myr (H2005) / 14 Myr (H&D2016). Jezero floor is 2.7–3.1 Ga (N(1 km) = 1.1–1.5e-3 km⁻²) [S23], so small craters are in erosion equilibrium, not production: e.g. at 100 nm/yr abrasion a 20 m crater (~4 m deep) lasts ~40 Myr, a 100 m crater (~20 m deep) ~200 Myr [S24]. Equilibrium density ≈ production rate × lifetime ⇒ D 10–20 m bins ≈ 60–90 km⁻², D 60–125 m ≈ 1 km⁻²; total 4–120 m ≈ **100–300 km⁻²** (DERIVED, judgement on lifetimes). ⇒ 244 km⁻² is plausible; keep it, but make the size distribution steep (N(>D) ∝ D^−2.8) so most stamps are 4–15 m, and depth/diameter mostly 0.05–0.1 (degraded) with a few fresh 0.2 (fresh d/D ≈ 0.2 from [S24] example, UNVERIFIED generally).

### 2.4 Relief amplitude vs. wavelength (km scale)

- DERIVED from MOLA MEGDR 128 ppd (463 m/px) [S25], RMS of elevation differences at lag L (both axes; Jezero floor-only box 18.30–18.55 N, 77.45–77.80 E — Máaz/Séítah area): L = 0.46 km: 6.2 m (0.76°) · **0.93 km: 10.5 m (0.65°; median |Δh| 6 m, p90 16 m)** · 1.85 km: 17 m · 3.7 km: 27 m ⇒ local Hurst 0.66–0.77. Same box including delta+rim (18.1–18.8 N, 77.2–78.0 E): 44 m at 0.93 km, 76 m at 1.85 km. Isidis plains (17–19 N, 86–89 E): 12 m at 0.93 km, 17 m at 1.85 km, 23 m at 7.4 km (H ≈ 0.5→0.2, flattening). Nili Fossae highlands: 37 m at 0.93 km. Caveat: MOLA gridded product interpolates between ~km-spaced tracks ⇒ sub-km values are underestimates.
- Kreslavsky & Head (2000) MOLA roughness rasters [S26]: relative roughness at 0.6 km baseline, Jezero ≈ 1.9× global median, Gale ≈ 3.1×, InSight ≈ 0.6×; at 2.4 km Jezero 1.7×, InSight 0.27×. (Absolute conversion of DN to slope UNVERIFIED — readme formula gives implausibly small values; use ratios only.)
- Consistency check (DERIVED): fBm with H = 0.7 anchored at 10.5 m RMS Δh at 0.93 km gives RMS Δh 0.088 m at 1 m (**5.0° RMS slope**), 0.14 m at 2 m (4.1°), 0.44 m at 10 m (2.5°), 2.2 m at 100 m (1.3°) — matches HiRISE Jezero 1 m means (4–6.7°) and lava-flow 2–12 m RMS slopes (1.5–1.7°) without extra tuning.

### 2.5 Recommended parameter set (fBm + crater stamps)

| Parameter | Value | Basis |
| --- | --- | --- |
| Base relief: RMS Δh at 1 km lag | **10 m** (floor plains); 5 m for Isidis-like smooth plains; 30–40 m if rim/delta-scale features are wanted | DERIVED [S25] |
| Hurst exponent / octave gain | **H = 0.70** ⇒ amplitude gain 2^−0.7 ≈ **0.62 per octave** (lacunarity 2); keep H in 0.6–0.8 | [S17][S18], DERIVED [S25] |
| Spectrum range | octaves from ≥1 km down to ~0.5 m (below that rocks, not fBm) | judgement |
| Resulting 1 m slopes | mean ≈ 4–5°, >15° ≈ 3–5 %, >20° ≈ 1 % | [S15][S16], DERIVED |
| Slope limits for "traversable" | ≤ 25–30° at 2–5 m (mission constraint); rover sim warn 30° tilt / 15° pitch-roll, fail 45° | [S7][S1][S5] |
| Crater density | keep **~250 km⁻² for D 4–120 m** (16 per 256 m cell); size PDF ∝ D^−3.8 (cumulative D^−2.8), min D 4 m; d/D 0.05–0.10 typical, 0.2 fresh (≤10 %) | [S21][S22][S24], DERIVED |
| Rock field | CFA k = 0.07–0.10 (patches 0.15); exponential model q(k) = 1.79 + 0.152/k; ~500 rocks/ha > 0.5 m at k = 0.10 | [S19][S20][S13] |
| Belly clearance / rock drive-over | c_0 = 0.60 m; rocks ≤ 0.40 m drivable, 0.40–0.52 m only by wheel-over, > 0.52 m obstacle | [S1][S7] |

## Sources

- [S1] NASA, Perseverance Rover Components — https://science.nasa.gov/mission/mars-2020-perseverance/rover-components/
- [S2] NASA, Curiosity's and Perseverance's Wheels — https://science.nasa.gov/resource/curiositys-and-perseverances-wheels/
- [S3] JPL news, Perseverance gets its wheels and air brakes — https://www.jpl.nasa.gov/news/nasas-perseverance-mars-rover-gets-its-wheels-and-air-brakes/
- [S4] NASA Perseverance 3D model (GLB, metric), downloaded from https://mars.nasa.gov/system/resources/gltf_files/25042_Perseverance.glb (page: https://science.nasa.gov/resource/mars-perseverance-rover-3d-model/); parsed locally.
- [S5] Rankin et al. (JPL), "Driving Curiosity: Mars Rover Mobility Trends During the First Seven Years" — https://www-robotics.jpl.nasa.gov/media/documents/2020-mobility-trending.pdf (JFR version: https://www-robotics.jpl.nasa.gov/media/documents/ROB-20-0040_R3.pdf)
- [S6] Wikipedia, Curiosity (rover) — https://en.wikipedia.org/wiki/Curiosity_(rover)
- [S7] Golombek et al., LPSC 2015 #1653, Mars 2020 science objectives / engineering constraints — https://www.hou.usra.edu/meetings/lpsc2015/pdf/1653.pdf
- [S8] LabXchange, Perseverance wheels and legs (250 mm articulation appeared only in search snippet) — https://www.labxchange.org/library/items/lb:LabXchange:f1c148d9:html:1
- [S9] Wikipedia, Rocker-bogie — https://en.wikipedia.org/wiki/Rocker-bogie
- [S10] Harrington & Voorhees 2004, MER rocker-bogie design — https://esmats.eu/amspapers/pastpapers/pdfs/2004/harrington.pdf
- [S11] NAIF MSL frames kernel msl_v08.tf — https://naif.jpl.nasa.gov/pub/naif/pds/data/msl-m-spice-6-v1.0/mslsp_1000/data/fk/msl_v08.tf
- [S12] NASA Curiosity 3D model (Curiosity_static.glb) via https://solarsystem.nasa.gov/gltf_embed/2398/ ; parsed locally.
- [S13] Otsu et al., "Fast Approximate Clearance Evaluation for Rovers with Articulated Suspension Systems", arXiv:1808.00031 — https://arxiv.org/pdf/1808.00031
- [S14] Fergason et al., LPSC 2017 #2163, Mars 2020 landing site slope & physical property assessment — https://www.hou.usra.edu/meetings/lpsc2017/pdf/2163.pdf
- [S15] Fergason et al., LPSC 2018 #1611, DTM procedure and slope statistics (Table 1) — https://www.hou.usra.edu/meetings/lpsc2018/pdf/1611.pdf
- [S16] Fergason et al. 2017, Analysis of local slopes at the InSight landing site (USGS abstract) — https://pubs.usgs.gov/publication/70177060
- [S17] Surface texture of Martian lava flows from decimeter/meter roughness, PSJ — https://iopscience.iop.org/article/10.3847/PSJ/abbfac
- [S18] LPSC 2019 #2807, roughness of Martian lava flows from HiRISE DTMs — https://www.hou.usra.edu/meetings/lpsc2019/pdf/2807.pdf
- [S19] Golombek et al. 2003, Rock size-frequency distributions on Mars… MER (NTRS abstract) — https://ntrs.nasa.gov/citations/20030111177
- [S20] Golombek et al. 2021, Rock size-frequency distributions at the InSight landing site (abstract via Semantic Scholar API) — https://doi.org/10.1029/2021EA001959
- [S21] Hartmann 2005 Table 2 image, PSI "Isochrons for Martian Crater Populations" — https://www.psi.edu/epo/resources/special-topics-in-planetary-science/isochrons-for-martian-crater-populations/ (image https://www.psi.edu/wp-content/uploads/table2-853x1024.jpg)
- [S22] craterstats config functions.txt (Hartmann 2005, Hartmann & Daubar 2016 tabular PFs; Michael 2013 chronology) — https://github.com/ggmichael/craterstats/blob/main/src/craterstats/config/functions.txt
- [S23] Lagain et al. 2021, A new martian crater chronology: implications for Jezero — https://arxiv.org/pdf/2102.05625
- [S24] Kite & Mayer 2016, Mars sedimentary rock erosion rates from crater counts — https://arxiv.org/pdf/1610.02748
- [S25] MOLA MEGDR 128 ppd tile megt44n000hb.img/.lbl (rows 17–20 N fetched by byte range; statistics computed locally) — https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/
- [S26] Kreslavsky 2025 Zenodo dataset (MOLA roughness rasters + readme; Kreslavsky & Head 2000) — https://zenodo.org/records/15734221
- Not retrievable (403/redirect): Wiley JGR/GRL papers (Golombek 2008, Kreslavsky & Head 2000, Orosei 2003, Annex 2024), Springer SSR InSight papers, marsjournal.org Golombek 2012, Hartmann 2005 full text.
