# City generation — rebuild plan

Monaco (`mc-1929`) is the test bed: the steepest terrain, the tightest buildings, the
only tunnel. Anything that works there works everywhere. The reference look is Apple
Maps' 2025 Monaco Grand Prix city experience — stylised realism, not a photograph and
not a Minecraft block.

This document is the plan of record. It states what is broken and how that was
measured, the decisions taken, the data contracts they imply, and the order of work.
Update it as decisions change; do not let the code and this file disagree in silence.

---

## 1. What is broken today, measured

All numbers from `public/environments/mc-1929/` as generated on 2026-07-01.

### 1.1 Terrain resolution

```
gridSize      64
widthMeters   2735.7
heightMeters  2974.3
minElevation  -59      (seabed)
maxElevation  292      (Tête de Chien side)
```

That is **~43 m per cell** across a 351 m range. Le Rocher — the headland carrying the
palace, and the wall the track climbs at Sainte-Dévote — is about eight vertices wide.
No amount of shading fixes a hill sampled eight times. This is the root cause of the
"bent landscape", and every other terrain complaint downstream of it.

### 1.2 Two independent truths about height

The track's Y comes from `public/elevations/<id>` — SRTM, then the three-stage cleanup
in `lib/track/elevation` (outlier removal, distance-weighted smoothing, grade limit).
The ground's Y comes from the terrain grid through `lib/env/terrain-sampler`. In
terrain mode the ribbon re-samples the terrain and smooths over 120 m
(`TERRAIN_TRACK_SMOOTH_RADIUS_M`), and `TERRAIN_TRACK_OFFSET = 4.5` lifts it clear.

A constant offset is not a joint. Where the DEM is coarse the ribbon floats metres
above the hill; where it dips the hill eats the ribbon; and buildings, which sample the
same coarse grid, sit at a third height again. Hence floating buildings and a track
that passes through walls.

### 1.3 Sea level is not a datum

`lib/env/terrain-sampler.ts`:

```ts
terrainReferenceElevation(terrain)  // lowest NON-NEGATIVE sample in the grid
terrainLocalHeight(h, ref)          // Math.max(0, h - ref)
buildTerrainSampler(...)            // isWater(lon,lat) ? 0 : terrainLocalHeight(...)
```

Three consequences:

1. The seabed (−59 m at Monaco) is clamped flat to zero. There is no bathymetry, only
   a plane.
2. "Sea level" is whichever sample happened to be the lowest non-negative one. It is
   an accident of the DEM tile, not a datum. Regenerate with a different grid size and
   the whole city moves vertically.
3. **The coastline is decided twice.** Land comes from the DEM; water comes from OSM
   polygons via the `isWater` mask. Two sources, one boundary — they never agree. This
   is exactly the "harbour half on land, half the city underwater" failure, and it is
   structural, not a tuning problem.

### 1.4 Tunnels are not in the schema

`RoadLine` carries `id`, `kind`, `highway`, `points`. The Overpass query never asks for
`tunnel`, `bridge` or `layer`, so nothing downstream can know that the stretch from the
Fairmont hairpin to Portier runs *under* the hill. The track is drawn straight through
solid rock, which is both a visual bug and a logical one.

### 1.5 Buildings are boxes

```
800 features, all kind="building"
height from OSM building:levels (× 3 m), flat tops, no roof form
```

Monaco is terraced high-rises and tiled pitched roofs. Flat prisms read as a grey block
model. `building:levels` is also missing or wrong across much of the Principality, so
even the box heights are unreliable.

### 1.6 Geometry is built in the browser

`src/components/three/environment-layer.tsx` is 1024 lines of runtime meshing:
footprint triangulation, road ribbons, terrain grid, corridor trimming — all on the
main thread at load. It is capped at `MAX_BROADCAST_BUILDINGS = 900` and
`LOW_DETAIL_MAX_BUILDINGS = 400` precisely because that is where the cost bites. The
cap is a symptom: detail is limited by what the browser can build, not by what the
scene can draw.

---

## 2. Decisions

| # | Decision | Consequence |
|---|---|---|
| **D1** | One generator for every circuit, plus a versioned per-circuit overrides file. Only a few circuits (Monaco first) get hand corrections. | Fixes live in git, not in a binary. 23 other circuits keep working. |
| **D2** | One height field is the single source of truth. The track supplies hard constraint lines; the field relaxes locally to meet them. Buildings, roads and water all read the same field. | "Floating building" becomes impossible by construction, not by tuning an offset. |
| **D3** | High-resolution DEM, adaptive: **4 m** near the track (the source's native cell — see P0.1), 8 m in the city belt, 16 m at the edge. DTM for the ground, DSM/MNH for building heights. | Le Rocher gets hundreds of samples instead of eight. |
| **D4** | Tunnels render as portals with a short vault, not a boolean cut. Real CSG excavation is a follow-up (P4.1). | ~95% of the visual for ~200 triangles and no runtime CSG. |
| **D5** | Budget: ≤ 15 MB per circuit over the wire, ≥ 30 fps on mobile, ≥ 60 fps on desktop, ≤ 120 draw calls including the car fleet. | Every later decision is checked against these numbers by `env:audit`. |
| **D6** | Geometry is baked to GLB at generation time. The browser loads, it does not build. | No main-thread triangulation, no 900-building cap, and the output can be opened in Blender to see what broke. |
| **D7** | Three detail belts measured from the track centreline: **core** ≤ 150 m, **city** ≤ 600 m, **far** to the bbox edge. | Detail follows the camera's actual interest. The harbour and Le Rocher land in core/city automatically. |
| **D8** | Building height comes from IGN **MNH** (height above ground, already DSM − DTM at source), not OSM tags. Roof form comes from ~8 parametric archetypes selected by `roof:shape` where present, by heuristic otherwise. | Real ridge heights; silhouettes that read as Monaco. |
| **D9** | Ambient occlusion is baked into vertex colours. No screen-space passes. Colour from the palette; no facade textures. | The city and the sun are both static — paying per frame for a static effect is the wrong trade (AGENTS.md). |
| **D10** | Overrides may edit **data** (heights, add/remove buildings, terrain points), **masks** (no-build, water, tunnel, grandstand) and **splines** (quay wall, barrier, breakwater). Authored GLB props by coordinate follow in P4.2. | Covers every named bug class without becoming a level editor. |
| **D11** | `env:audit` reports numbers and fails on regression. | Regressions are caught by a threshold, not by someone happening to look. |
| **D12** | ~~GDAL/PDAL CLI~~ **Superseded by P0.3.** Elevation comes from the IGN Géoplateforme WMS as `image/x-bil;bits=32` — a raw little-endian float32 raster in EPSG:4326, at whatever grid we ask for. TypeScript reads the response body straight into a `Float32Array`. No GDAL, no PDAL, no Python. | Nothing to reproject, clip or convert. The whole raster step is one `fetch` and a `DataView`. A provider interface keeps the door open for non-French circuits. |
| **D13** | The track's visual mesh (ribbon, kerbs, apron, markings) is baked into the GLB. The centreline curve stays live for the simulation, camera and start/finish calibration — both produced by one pass. | The heaviest runtime build in the scene is static; the curve that must stay live, stays live. |
| **D14** | Three files per circuit: `far.glb`, `city.glb`, `core.glb`. Loaded far → city → core. No 3D Tiles streaming. | Fast first frame; per-belt byte budgets. 3 km² does not repay a streaming runtime. |
| **D15** | Heights are metres above sea level as the DEM reports them. Water is a plane at `y = 0` in that datum. **The coastline is the DEM's nodata boundary for open sea, and the flat-constant rule of §5.6 for enclosed basins** — IGN carries no bathymetry, so the sea is nodata rather than negative depth (P0.1), while a harbour arrives stamped with one repeated value. OSM water polygons are used only for inland water and as an audit assertion — never to decide the coast. | One source for the boundary means it cannot disagree with itself. The implementation is the nodata mask, not a zero crossing, but the principle is unchanged. |
| **D16** | Props whose absence reads as a bug — barriers, fences, grandstands, tunnel portals — ship in the core belt, instanced, one draw call per type. Trees and yachts follow via D10 props. | Detail without spending the draw-call budget. |
| **D17** | Both paths live side by side while circuits migrate: a baked GLB is used when present, otherwise the old runtime path. The last migrated circuit deletes `environment-layer.tsx`. | A safety net with a written termination condition, so the dead branch actually dies. |

---

## 3. Target architecture

### 3.1 Pipeline

```
  IGN WMS (float32 BIL) ────────────────────→ dtm.f32 / mnh.f32  (+ .json header)
  Overpass (OSM) ───────────────────────────→ buildings / roads / water / landuse
  bacinger GeoJSON ─────────────────────────→ centreline
  overrides/<id>.json ──────────────────────→ data edits, masks, splines
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  height field (D2, D3, D15)  │   ← single source of truth
                    │  adaptive grid, datum = MSL, │
                    │  track constraints burned in │
                    └──────────────────────────────┘
                                   │
             ┌─────────────────────┼──────────────────────┐
             ▼                     ▼                      ▼
      terrain + water        buildings + roofs      track visual (D13)
             └─────────────────────┼──────────────────────┘
                                   ▼
                      belt split (D7) → meshopt → GLB
                                   ▼
              public/environments/<id>/{far,city,core}.glb
                                   ▼
                        runtime loader → scene
                                   +
                       centreline curve (live, same pass)
```

### 3.2 Module layout

New:

```
scripts/env/raster.ts        IGN WMS float32 fetch, nodata cleanup, disk cache
scripts/env/heightfield.ts   adaptive grid, datum, constraint burn-in
scripts/env/belts.ts         core/city/far classification from the centreline
scripts/env/bake-terrain.ts  terrain + water meshes
scripts/env/bake-buildings.ts  footprint → archetype → extrusion
scripts/env/bake-track.ts    ribbon, kerbs, apron, markings (shares code with lib/track)
scripts/env/bake-props.ts    barriers, fences, grandstands, portals (instanced)
scripts/env/ao.ts            vertex AO bake
scripts/env/write-glb.ts     belt assembly, meshopt, manifest v2
scripts/audit-environment.ts `bun run env:audit`
src/lib/env/city-loader.ts   GLB fetch, belt ordering, disposal
src/components/three/city-layer.tsx   the thin runtime that mounts the GLBs
public/environments/<id>/overrides.json   hand corrections (D10), tracked in git
```

Changed:

- `src/lib/env/environment-types.ts` — manifest v2, tunnel/bridge/layer on roads,
  overrides schema.
- `src/lib/env/terrain-sampler.ts` — loses the `Math.max(0, …)` clamp and the
  `isWater` flattening; becomes a reader over the baked height field (D15).
- `src/lib/scene-config.ts` — `TERRAIN_TRACK_OFFSET` and
  `TERRAIN_TRACK_SMOOTH_RADIUS_M` become obsolete once the track is a constraint on
  the field rather than a thing floated above it.

Deleted at the end (D17): `src/components/three/environment-layer.tsx`.

### 3.3 Data contracts

**Raster intermediate** — the WMS body is already a plain `Float32Array`; it is cached
to disk as-is beside a JSON header, so nothing has to parse a raster format:

```jsonc
// dtm.json (mnh.json is identical in shape)
{
  "schemaVersion": 1,
  "path": "dtm.f32",         // row-major float32, NaN for no-data
  "width": 2048, "height": 2048,
  "originLon": 7.4087, "originLat": 43.7233,
  "pixelSizeLon": 1.6e-5, "pixelSizeLat": 1.2e-5,
  "datum": "EPSG:4326+5720", // heights are metres above mean sea level
  "layer": "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES",
  "nodata": -99999,
  "nativeCellM": 3.9
}
```

**Height field** — adaptive, so not a single grid. Stored as a quadtree of tiles, each
a fixed 64×64 block at its own resolution:

```jsonc
{
  "schemaVersion": 1,
  "datum": "msl",            // negatives preserved (D15)
  "bbox": { ... },
  "tiles": [
    { "level": 0, "x": 0, "y": 0, "resolutionM": 16, "offset": 0 },
    { "level": 3, "x": 5, "y": 2, "resolutionM": 2,  "offset": 4096 }
  ],
  "seaLevel": 0
}
```

**Manifest v2** — replaces the v1 manifest; the loader accepts both while D17 holds:

```jsonc
{
  "schemaVersion": 2,
  "circuitId": "mc-1929",
  "style": "city",
  "center": { "lon": …, "lat": … },
  "bbox": { … },
  "datum": "msl",
  "belts": {
    "far":  { "file": "far.glb",  "bytes": 1_800_000, "radiusM": null },
    "city": { "file": "city.glb", "bytes": 6_400_000, "radiusM": 600 },
    "core": { "file": "core.glb", "bytes": 5_100_000, "radiusM": 150 }
  },
  "counts": { "buildings": 0, "props": 0, "triangles": 0, "drawCalls": 0 },
  "overridesApplied": 0,
  "sources": { … },
  "attribution": "© OpenStreetMap contributors",
  "generatedAt": "…"
}
```

**Overrides** (D10), hand-written, tracked in git, applied after OSM and before baking:

```jsonc
{
  "schemaVersion": 1,
  "circuitId": "mc-1929",
  "buildings": {
    "remove": ["way/123456"],
    "height": { "way/234567": 42.5 },
    "add": [{ "id": "manual/casino", "height": 28, "roof": "hipped",
              "footprint": [[lon, lat], …] }]
  },
  "terrain": {
    "points": [{ "lon": …, "lat": …, "elevation": 63.2, "radiusM": 30 }]
  },
  "masks": [
    { "kind": "no-build", "polygon": [[lon, lat], …] },
    { "kind": "tunnel",   "polygon": [[lon, lat], …], "roofElevation": 34 },
    { "kind": "water",    "polygon": [[lon, lat], …] },
    { "kind": "grandstand", "polygon": [[lon, lat], …], "rows": 14 }
  ],
  "splines": [
    { "kind": "quay",       "points": [[lon, lat], …], "topElevation": 3.5 },
    { "kind": "barrier",    "points": [[lon, lat], …], "heightM": 1.0 },
    { "kind": "breakwater", "points": [[lon, lat], …], "topElevation": 6 }
  ]
}
```

### 3.4 The height field, in detail

This is the heart of D2/D3/D15. Four steps, in order:

1. **Datum.** Take the DTM as metres above mean sea level. Do not shift, do not clamp.
   The seabed stays negative; `y = 0` is the sea surface everywhere on every circuit.
2. **Adaptive resample.** Compute distance to the centreline for each candidate tile.
   Subdivide while `distance < 150 m` down to 2 m, `< 600 m` down to 8 m, otherwise
   16 m. Also subdivide on local relief: any tile whose height range exceeds 25 m
   subdivides one extra level regardless of distance — that is what keeps Le Rocher's
   cliff from being a staircase.
3. **Constraint burn-in.** The centreline (with its cleaned elevation profile) is a
   hard constraint polyline. Within a corridor of half-width `w = trackWidth/2 + 2 m`,
   set the field to the track's elevation. From `w` to `w + 6 m`, blend with a
   smoothstep so the ground meets the track without a one-cell cliff. Quay splines and
   terrain override points burn in the same way, after the track.

   The 6 m verge and 25 m blend this section first specified were measured and thrown
   out: they moved ground cells by up to 24 m, because a street circuit's road is a
   shelf cut into a slope with a wall at its edge, not an embankment. A wide corridor
   flattens the hillside the buildings stand on. Both are options on the constraint, so
   a parkland circuit can ask for the wider ramp.
4. **Storage.** Uniform at the provider's native cell, not the adaptive quadtree this
   section first sketched. Monaco is 2 MB at 3.9 m — a build-time array that is never
   shipped, so an adaptive layout would add a lookup per sample and save nothing. D3's
   belt resolutions still govern how finely the *mesh* is built.
5. **Consistency pass.** Re-derive nothing. Everything else — building bases, road
   drape, water clipping, prop placement — *reads* this field. No module is allowed to
   compute a height from a DEM again.

### 3.5 Belts and budget (D5, D7, D14)

| Belt | Extent from centreline | Contents | Bytes | Triangles | Draw calls |
|---|---|---|---|---|---|
| `core` | ≤ 150 m | Terrain at 2 m, buildings with roof archetypes + AO, track visual, barriers, fences, grandstands, tunnel portals | ≤ 6 MB | ≤ 450 k | ≤ 40 |
| `city` | ≤ 600 m | Terrain at 8 m, buildings with roof archetypes, no props | ≤ 7 MB | ≤ 350 k | ≤ 25 |
| `far` | to bbox edge | Terrain at 16 m, buildings as flat-topped silhouettes, water | ≤ 2 MB | ≤ 120 k | ≤ 10 |
| — | — | Car fleet, HUD, existing scene furniture | — | — | ≤ 45 |
| **Total** | | | **≤ 15 MB** | **≤ 920 k** | **≤ 120** |

One material per belt per class, meshes merged inside a belt so a belt is a handful of
draw calls, not one per building. Props are `InstancedMesh`, one call per prop type.

---

## 4. `env:audit` checks (D11)

`bun run env:audit mc-1929` reads the baked GLBs and the height field, and prints a
table. Non-zero exit on any failure.

| Check | Threshold |
|---|---|
| Buildings whose base is above the field under their footprint | 0 (tolerance 0.15 m) |
| Buildings whose base is buried more than 1.5 m at any footprint vertex | 0 |
| Building footprints intersecting the track corridor | 0 |
| Road vertices further than 0.3 m from the field | 0 |
| Track vertices whose field height differs from the ribbon by > 0.05 m | 0 |
| Coastline from the field vs the OSM water polygon | max deviation ≤ 15 m — an assert on the DEM tile, never a reason to patch geometry with a mask |
| Water surface polygons above `y = 0` | 0 |
| Bytes per belt | within §3.5 |
| Triangles per belt | within §3.5 |
| Draw calls, whole scene | ≤ 120 |
| Buildings with no height source (no DSM, no tags, no override) | reported, not fatal |

Add `env:audit` to the "Done means" list in `AGENTS.md` alongside `race:kerbs` and
friends.

---

## 5. Data source — settled by P0

### 5.1 The source

**IGN Géoplateforme WMS**, `https://data.geopf.fr/wms-r/wms`, WMS 1.3.0, requested as
`FORMAT=image/x-bil;bits=32`. The response body is a raw little-endian float32 raster,
row-major, north-up, `WIDTH × HEIGHT × 4` bytes, in the CRS requested. No header, no
compression, no container. Nodata is `-99999`.

Layers in use:

| Purpose | Layer | Verified over Monaco |
|---|---|---|
| Ground (DTM) | `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES` | yes |
| Surface (DSM) | `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS` | yes |
| Height above ground | `IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G` | yes |

Rate limit from the response headers: `x-ratelimit-limit-second: 1`. Irrelevant in
practice — the whole Monaco bbox is one request.

### 5.2 Q-A — does the data cover Monaco? **Yes.**

The Principality is fully covered; the only nodata in the bbox is the Mediterranean.
Spot checks against the served raster:

| Point | Served | Reality |
|---|---|---|
| Prince's Palace, Le Rocher | 62.2 m | ~60 m |
| Port Hercule quay | 1.2 m | quayside |
| Casino square | 44.7 m | ~45 m |
| Sainte-Dévote | 24.8 m | plausible |
| Fairmont hairpin | 46.7 m | plausible |
| Sea south of the harbour | nodata | — |

**Native cell size ≈ 3.9 m.** Measured by requesting a 250 m bbox at 0.98 m/px and
measuring run lengths of identical values: median 4 px. Asking for a finer grid returns
interpolation, not detail. So 4 m is the floor from this source, and D3 was amended
from 2 m to 4 m. Against today's 43 m that is an **11× improvement**, and Le Rocher
goes from eight samples across to roughly ninety.

### 5.3 Q-B — is there a DSM? **Yes, and better than expected.**

Over a 200 m × 300 m patch of the Casino district:

```
MNT (ground)   min 31.6  max  55.0
MNS (surface)  min 34.0  max 124.7
MNH (height)   min -0.6  max  73.3
MNS − MNT      median 4.6 m, p90 28.8 m, max 72.7 m
```

MNS − MNT and MNH agree (72.7 vs 73.3 m for the tallest structure), and ~70 m matches
Monaco's Casino-district towers. **MNH is used directly** — IGN has already done the
subtraction, so D8 reads one raster instead of differencing two.

### 5.4 Q-C — bathymetry: none, and that is fine

IGN serves nodata over the sea, not depth. Consequences, both recorded in D15:

1. The coastline is the nodata boundary. One source, so it cannot disagree with itself.
2. No seabed is rendered. Under an opaque water plane at `y = 0` it would never be seen.

### 5.5 Trap: nodata contamination at the coast

The WMS resamples, and it blends valid pixels with the `-99999` nodata value. In the
1024² Monaco raster, **620 pixels carry impossible values between −1 m and −974 m, and
89% of them are directly adjacent to a nodata pixel.** These are interpolation
artefacts along the shoreline — precisely where Monaco's most visible geometry is.

The raster reader must therefore:

- treat anything below −20 m as nodata (there is no real terrain below that here), and
- **erode the valid mask by one cell** before the height field consumes it,

or the harbour edge gets a ring of pixels diving hundreds of metres — a new and worse
version of the bug in §1.3. The erosion has to run **before** any averaging: a single
contaminated pixel that survives into a block average drags the whole output cell
below sea level.

### 5.6 Enclosed water is stamped, not left empty

The open sea is nodata, but a harbour is not. The service fills sheltered water with a
single constant, and each basin gets its own:

| Value | Area | Centre | What it is |
|---|---|---|---|
| 1.20 m | 22.5 ha | 43.7353, 7.4261 | Port Hercule |
| 0.68 m | 8.1 ha | 43.7244, 7.4147 | Cap d'Ail marina |
| 0.61 m | 7.0 ha | 43.7293, 7.4209 | Fontvieille |
| −0.23 m | 4.3 ha | 43.7461, 7.4353 | Larvotto bay |

Left alone, all four render as flat grey land — the harbour Monaco is famous for,
paved over. The quay beside Port Hercule reads 1.20 m as well, so no elevation
threshold can separate basin from quayside.

What separates them is **constancy**: real ground is never bit-identical over hectares.
A connected region of one repeated value, at least 0.46 ha (300 cells at 3.9 m) and
below 50 m, is the source saying it filled water there. Marking those NaN keeps the
coastline decided by the DEM alone, exactly as D15 requires, instead of borrowing an
OSM polygon that would not line up with it. On Monaco the rule finds all four basins
and nothing else, taking water from 39.6% to 44.7% of cells.

The elevation cap is a safety valve against a man-made flat surface, not a claim about
water; a mountain lake above it would be missed, and an override (D10) is the fix.

### 5.7 Trap: the source grid is not square

The service's cell is **3.90 m across and 4.35 m down**. Requesting a grid at one pixel
per cell therefore beats against the source, and the mismatch lays a periodic ridge
across the raster **every fourth row**: measured, the mean row-to-row step was 1.169 m
against 0.733 m column-to-column, with 64 of 80 spike-gaps exactly 4 rows apart. On a
hillside that reads as terracing — the "bent landscape" all over again, from a new
cause.

The fix is to fetch at twice the pitch and average 2 × 2 blocks down (`supersample`,
default 2). After it, the row step is 0.735 m against 0.721 m for columns and the
period is gone. Four times the bytes, all of which stay in the disk cache.

---

## 6. Plan

### P0 — Prove the data exists — **DONE**

- [x] **P0.1** Coverage confirmed over the whole Monaco bbox at ~3.9 m native. Sea is
      nodata. Landmark spot checks match reality. See §5.2. D3 amended 2 m → 4 m.
- [x] **P0.2** DSM confirmed, plus MNH (height above ground) which is better. See §5.3.
      D8 amended to read MNH directly.
- [x] **P0.3** GDAL and PDAL are **not installed on this machine** — and are not
      needed. The WMS returns float32 BIL that TypeScript reads directly. D12
      superseded; §3.3's raster intermediate collapses to a fetch plus a header.
      Contamination trap found and recorded in §5.5.

### P1 — Thin slice: the joints, and nothing else

Deliberately ugly. Terrain, boxes, track, water — baked, loaded, audited. This phase
exists to prove the joints hold before any effort goes into how it looks.

- [x] **P1.1** `scripts/env/raster.ts`: a `fetchElevationRaster(bbox, layer, size)`
      over the IGN WMS (§5.1) returning a `Float32Array` plus a header, with the nodata
      handling from §5.5 (threshold at −20 m, erode the valid mask by one cell), cached
      on disk like the existing Overpass cache. Behind a provider interface, so a
      non-French circuit can supply a different source later. **Done.** Monaco
      returns 702 × 763 at exactly 3.90 m/px; after the nodata pass the minimum
      is −0.23 m instead of −498.6 m. Landmark samples verified against §5.2.
      `bun scripts/env/raster.ts --bbox=… --kind=dtm` prints the coverage map.
- [x] **P1.2** `scripts/env/heightfield.ts`: MSL datum, track constraint burn-in
      (§3.4), uniform native-cell storage. **Done.** Monaco builds 702 × 763 at 3.90 m,
      ground −0.23…452.52 m, water 39.6% of cells, track profile 1.12…42.96 m over
      1184 samples. Burn-in touches 1.1% of cells; 73 cells (0.014%) move more than
      8 m, all of them on the cut sections below Casino where a retaining wall stands
      in reality — those arrive with the props in P3.4. Verified against a hillshade
      render: harbour basin, Le Rocher and the amphitheatre all read correctly, and the
      §5.7 terracing is gone. Port Hercule, Fontvieille, Larvotto and the Cap d'Ail
      marina read as water rather than pavement, found by the §5.6 rule.
- [ ] **P1.2b** Rewrite `src/lib/env/terrain-sampler.ts` as a reader over the baked
      field; delete the `Math.max(0, …)` clamp and the `isWater` flattening. Deferred
      to P1.3, which is what first produces a baked field for the runtime to read.
- [x] **P1.3** Bake: terrain mesh + extruded building boxes + track visual + water
      plane at `y = 0`, split by belt, meshopt-compressed, three GLBs + manifest v2.
      **Done** (`scripts/env/bake.ts`, `belts.ts`, `mesh.ts`, `plane.ts`). Monaco bakes
      in 3.3 s to **0.92 MB** across the three belts — 5.87 MB before meshopt —
      156 654 triangles and **8 draw calls**, against budgets of 15 MB, 920 k and 120.
      785 buildings placed, 19 footprints pushed off the corridor, none left inside it.
      World bounds read back at 2736 x 2974 m with terrain to 452 m, so quantisation
      keeps the placement. Belt seams are hidden with a 3 m skirt rather than stitched;
      water is one quad at the datum, since the terrain edge already is the coastline.
      Terrain is emitted per triangle, not per cell: dropping a whole cell when one
      corner is water costs up to 16 m of coast in the far belt and reads as teeth of
      sea biting into the city.
      The manifest is `city-manifest.json` (v2), beside the belt files. Run it with
      `bun run env:bake mc-1929`, look at it with `bun run env:preview`.

      Two bugs the preview caught and the numbers did not: terrain and water were
      wound clockwise, so both were back-faces and invisible from above; and belt
      membership decided per cell left a hairline of unclaimed ground along each
      boundary, since an 8 m cell and the 16 m cell over it disagree about which
      side of the radius they are on. Ownership is now decided once on the coarsest
      grid and the finer grids divide into it exactly.

      Still runtime, not baked, contrary to D13: kerbs, apron and painted markings. The
      ribbon is baked; the rest follow once the loader proves the joint holds.
- [x] **P1.4** `city-loader.ts` and `city-layer.tsx`: fetch far → city → core, mount
      beside the existing layer, gated so a circuit without GLB keeps the old path
      (D17). **Done.** Monaco loads **354 KB** over the wire (54 + 185 + 115 KB
      gzipped) against 2.1 MB of diorama JSON before, which is no longer fetched at
      all when a city manifest exists.

      The datum is the joint: the manifest carries one height per centreline vertex,
      and the runtime builds its curve from those with no offset, so the ribbon lands
      on the ground the bake burned it into. `terrain-sampler` is bypassed entirely in
      city mode — the field already decided where the ground is.

      Two leftovers: the ribbon still sits `TRACK_SURFACE_RAISE` (1.1 m) above the
      curve, which P1.5 should measure and P1.2b should remove; and the info panel's
      elevation profile still reads the old SRTM array, so it disagrees with the scene
      it describes.
- [x] **P1.5** `scripts/audit-environment.ts` with the §4 checks; `bun run env:audit
      mc-1929`. **Done, and Monaco passes every fatal check.** Measured:

      ```
      total bytes                      0.84 MB                  limit 15 MB
      city draw calls                  7                        limit 75
      terrain follows the field        worst 0.47 m / 10 276     limit 0.6 m
      water sits on the datum          0 vertices off            limit 0
      track profile matches the field  worst 0.005 m             limit 0.05 m
      buildings floating               0                         limit 0
      baked walls in the corridor      0                         limit 0
      ground range under a footprint   709 of 785, worst 46.1 m  reported
      ```

      The geometry checks read the shipped GLB rather than the bake's own report,
      dequantising through each node's transform. Three thresholds are set by
      measurement, not by wish: 0.6 m for terrain (position quantisation moves a
      vertex by up to half a step), 0.5 m of corridor slack for the same reason, and
      the coastline cross-check reports "no reference data" instead of a fake pass —
      OSM has no polygon for the Mediterranean, and Monaco's water layer is villa
      swimming pools sitting hundreds of metres up a hillside.

      **The finding that matters: 709 of 785 footprints span more than 1.5 m of
      ground, the worst 46.1 m.** A flat-based prism from the lowest corner turns a
      terraced block on a hillside into a 46 m cliff of wall — those are the tall
      slabs in `images/bake-harbour.png`. This is P3's problem to solve, and it is
      now a number that moves rather than an impression.

**Exit criterion: met.** `bun run env:audit mc-1929` reports zero floating buildings,
zero baked walls in the track corridor, 0.005 m of track/field disagreement, and every
belt an order of magnitude inside its byte budget.

### P2 — The things Monaco cannot be without

- [ ] **P2.1** Overpass query gains `tunnel`, `bridge`, `layer`; `RoadLine` and the
      building schema carry them.
- [x] **P2.2** Tunnel portals (D4): an arched sleeve standing 1 m out of the hillside
      at each mouth, 8 m of dark vault behind it, capped at the far end, with a 2.5 m
      headwall around the opening. **400 triangles for eight mouths.** The sleeve's
      faces point inward, so its near side is culled and the camera sees the dark far
      side through the arch. The hill is untouched — a height field cannot hold a
      cavity — and P4.1 still owns the real excavation.

      The headwall gets its own mesh rather than riding the buildings' material: it
      stands over the road on purpose, and merged in it made `env:audit` report 360
      walls in the track corridor. One extra draw call, and the check stays honest.
- [ ] **P2.3** Quay walls from `man_made=quay` and the harbour splines; Piscine as its
      own object; the breakwater. This is where §1.3's coastline fix becomes visible.
- [ ] **P2.4** Overrides file format and loader (D10) — data edits, masks, splines.
- [ ] **P2.5** Monaco's first hand-override pass: Le Rocher, Port Hercule, the tunnel
      run, and whatever `env:audit` still flags.

### P3 — The look

- [ ] **P3.1** Building heights from DSM − DTM (D8), with the OSM-tag fallback.
- [ ] **P3.2** Roof archetypes: flat-with-parapet, gabled, hipped, mansard, stepped
      terrace, shed, sawtooth, domed. Selection by `roof:shape` where tagged, else by
      footprint area / elongation / height heuristic.
- [ ] **P3.3** Vertex AO bake (D9) and the palette pass over `diorama-palette.ts`.
- [ ] **P3.4** Core-belt props, instanced: barriers, debris fences, grandstands (D16).

### P4 — Deferred on purpose

- [ ] **P4.1** Real tunnel excavation — boolean cut through the hill (D4's target).
- [ ] **P4.2** Authored GLB props placed by coordinate: Casino, yachts, harbour cranes
      (D10's third tier).
- [ ] **P4.3** Trees and vegetation.
- [ ] **P4.4** Migrate the remaining 23 circuits, then **delete
      `environment-layer.tsx`** and the old runtime path. This is D17's termination
      condition — the plan is not finished while both paths exist.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| ~~No high-res data over Monaco~~ | **Retired by P0.1** — 3.9 m coverage confirmed across the bbox. |
| IGN is a single point of failure, and covers France only | The raster step sits behind a provider interface (P1.1). Rasters are cached on disk and the cache is what the bake reads, so a generation run does not depend on IGN being up. Circuits outside France need a provider before they migrate (P4.4). |
| Nodata contamination at the shoreline (§5.5) | Threshold and one-cell erosion in the raster reader; `env:audit`'s coastline check catches a regression. |
| The flat-constant water rule fires on a man-made surface | Needs 0.46 ha of one bit-identical value below 50 m, which no natural or paved ground produces. `env:audit` reports the count and centroid of every region it marks, so a wrong one is visible rather than silent. |
| 15 MB is not enough at 2 m core terrain | Core terrain is the largest single consumer. Lever order: reduce core radius 150 → 120 m, then core resolution 2 → 3 m, then far-belt building silhouettes. Measured by `env:audit`, not guessed. |
| Bake time makes iteration painful | Cache every stage (raster, OSM, height field) as the Overpass cache already is. A geometry-only rebake must not refetch anything. |
| The two paths (D17) drift and both rot | P4.4 is in the plan with an explicit deletion. `env:audit` runs only on the new path, so the old one gains no new work. |
| Baked AO looks wrong once the scene light changes | AO is occlusion, not shading — it is light-direction independent. If the art direction changes to a low sun, revisit D9 rather than patching the bake. |
