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
| **D4** | Tunnels render as portals with a swept vault, and the approaches are excavated into the height field rather than cut out of it as solids (P4.1). | ~95% of the visual for ~900 triangles and no CSG anywhere. |
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
- [x] **P2.3** Quay walls from OSM's `natural=coastline`, `man_made=quay` and
      `man_made=breakwater` (`scripts/env/shore.ts`). **511 wall segments built, 313
      skipped, 41 piers skipped.**

      The rule is agreement, and it is what keeps D15 intact: a segment is built only
      where the raster has water on one side of the line and ground on the other. An
      OSM line running across dry ground or out in open water is a line the DEM
      disagrees with, and a wall there would be a slab in a street or a fence in the
      sea. The first pass probed 5 m either side and skipped 82% of segments; the two
      surveys are simply drawn a few metres apart, so the probe now widens to 12 m —
      OSM gives the wall its direction, the raster gives it its position.

      Piers are skipped by kind: the line runs down the middle of the deck, so both
      sides are the same thing and the water test says nothing. Piscine is not modelled
      yet.
- [ ] **P2.4** Overrides file format and loader (D10) — data edits, masks, splines.
- [ ] **P2.5** Monaco's first hand-override pass: Le Rocher, Port Hercule, the tunnel
      run, and whatever `env:audit` still flags.

### P3 — The look

- [x] **P3.1** Building heights measured from IGN MNH (`scripts/env/building-heights.ts`).
      **794 of 800 measured, 6 left on OSM tags, median move 7.0 m, tallest 114.6 m.**

      MNH is sampled on its own grid *inside* each footprint — sampling the outline
      would read the street the building stands beside — and the height is the 75th
      percentile of those readings, so a block reads as its main mass rather than as
      its tallest aerial. A footprint smaller than a raster cell falls between the
      sample points, so it gets its centroid as its one reading.

      A 7 m median move is the difference between a grey block model and a skyline:
      compare `images/bake-harbour.png` with `images/heights.png`.
- [x] **P3.1b** The bake takes its buildings from Overpass directly, with tags, instead
      of the old pipeline's `buildings.json`. That file held **800 footprints**; the
      query returns **4 792**, so the old generator was dropping five buildings in six.
      Baked: 4 776 buildings, **1.87 MB** total and 226 k triangles, still an order of
      magnitude inside D5. It also removes a dependency on the path D17 will delete,
      and brings the tags — `roof:shape`, `building:levels`, `height` — that roofs need.

      One trap on the way: Overpass answers a refusal with **HTTP 200, an empty element
      list and a `remark`**. Taken at face value that cached an empty city, so the
      client now treats an empty-with-remark answer as a failure and moves to the next
      endpoint.

- [x] **P3.2** Roof archetypes (`scripts/env/roofs.ts`): flat with a parapet, gabled,
      hipped, pyramidal, skillion. Monaco comes out **1 614 flat, 655 gabled, 2 503
      hipped, 4 pyramidal**, at 2.43 MB and 264 k triangles.

      Only 72 of 4 792 buildings carry `roof:shape`, so the tag decides where it exists
      and size, height and elongation decide everywhere else. A pitch needs to know
      which way the building faces, which a ring of coordinates does not say, so the
      direction comes from the footprint's **minimum-area bounding rectangle** (convex
      hull, then rotating calipers). A footprint that fills less than 72% of its own
      rectangle — an L, a courtyard block — keeps a flat roof, because a ridge across a
      plan like that lands in mid-air.

      The measured height is the top of the roof, not the top of the walls: the roof
      takes its height off the eaves, so measuring and shaping do not fight.

      The audit found the one real consequence: a roof built on the bounding rectangle
      can overhang the pushed footprint, and three vertices leaned 1.37 m over the
      track corridor. Eaves over a road are what buildings do; walls in a road are not.
      The check now separates them by height above the ground rather than banning
      both.
- [x] **P3.3** Ambient occlusion baked into vertex colours (`scripts/env/ao.ts`).
      Monaco: **3.40 MB total, 10 draw calls**, and the bake still runs in under two
      seconds.

      What is computed is sky visibility — from each vertex, how much of the sky the
      surroundings block — sampled over 8 azimuths and 8 distances against a 4 m grid
      holding the terrain with everything standing on it stamped on top.

      Two things had to be fixed before it showed at all. The grid was first stamped
      per **vertex**, and a wall carries vertices only where its footprint turns, so a
      40 m block occluded two cells and left the street beside it in full sun; every
      triangle is now rasterised. And raw sky visibility is a gentle quantity — a
      street with towers either side still sees three quarters of the sky — so it read
      as no shading at all until the openness was put through a curve. Both are
      recorded in the module.

      Colour is still the palette: glTF multiplies vertex colour into the base colour,
      so this shades the palette rather than replacing it, and there are no textures.
- [x] **P3.4** Barriers down both sides of the circuit in the core belt — **12 324
      triangles**, one mesh, nothing built through the tunnel. They are a thin box
      rather than two faces back to back: coincident quads fight over depth and the
      face turned away from the sun wins half the time, which draws a black line down
      the circuit. They are also left out of the AO pass, since a thin object at street
      level comes back from it nearly black.

      **Not done: grandstands.** Monaco's are temporary and OSM does not carry them, so
      there is nothing to place them from. That wants either an override (D10) or the
      authored props of P4.2, and guessing at their positions would be inventing a
      racetrack rather than modelling one.

      Debris fences are skipped for the same reason a fence is hard without textures:
      a solid panel is wrong and a transparent one costs a sorted draw. It waits for
      the material work that P4 can carry.

### P4

- [x] **P4.0** The coast is cut against the surveyed line, not the grid —
      `scripts/env/coastline.ts`.

      The height field only knows land from water per raster node, so every water
      edge it could draw ran along a grid line: teeth 4 m across in the core belt
      and 16 m in the far one. Per-triangle emission (P1.4) removed the *holes* in
      the shoreline but not its grain, and no cell size removes a staircase — it
      only makes the steps smaller while paying for them over the whole surface.

      So the terrain is emitted by marching squares against a scalar that is the
      signed distance to the OSM shoreline, and it is the crossing of that scalar,
      not the cell boundary, that ends the land. A cut cell keeps its dry corners,
      gains a vertex wherever its rim crosses the line, and is fanned. The cut edge
      is shared by both cells that own it, so it cannot open a seam, and it carries
      its own skirt down past the datum — the grid-aligned skirt now only fires on
      a dry rim, which is the belt boundary and the edge of the bbox.

      **Which side is dry** is the part that cannot come from geometry. OSM orients
      `natural=coastline` with the land on its left, and across Monaco's 25
      coastline ways the raster agrees with that on **every segment it has an
      opinion about** (measured: 0 ways on one side, 25 on the other), so the tag is
      taken at its word. That matters beyond tidiness: the old majority vote threw
      away a 59-segment coastline because the raster could only separate the sides
      on 2 of them. A quay or a breakwater carries no such promise and is still
      oriented by probing the field along its length.

      Where the surveyed line is not near, the raster mask still decides, so an
      enclosed basin with no OSM line behind it keeps the old edge.

      **Result:** 28 of 94 ways cut the terrain (540 segments after the
      corroboration filter); the 66 that do not are 41 piers — a pier is drawn down the middle of its own deck, so it has no
      land side and cutting against it would slice the deck in half — and 2 quays
      whose sides the raster cannot separate, and 23 `natural=water` rings that turn
      out to be Monaco's fountains and swimming pools — OSM does not draw the sea
      as an area, so the `MIN_BASIN_M2` floor earns its keep by refusing to open a
      hole in a courtyard. Cost over the whole of P4.0: **3.58 → 3.65 MB**.

      One correction on the way in: a node the line calls land can be one the
      raster calls sea and has no height for, and feeding that `NaN` into a vertex
      threw triangles across the scene. Such a node now takes the nearest dry
      reading rather than the datum, which is also what keeps the quay a wall
      instead of a beach.

      `env:audit` had to learn the difference too: on the cut line the mesh and the
      field are *meant* to disagree, so vertices within one far-belt cell of either
      cut source are counted and reported separately (**1 377 at the cut coast,
      worst 2.41 m**) while the ground proper holds **worst 0.42 m** over 9 067
      vertices.

      **Three defects found by looking at it afterwards**, each with a different
      cause:

      *The headland hung in the air.* The coast's skirt dropped a fixed 3 m, so a
      cliff standing 30 m above the sea got a 3 m hem and open air below it — from
      the water the whole south shore read as a shelf on nothing. It now runs to a
      fixed depth **below the datum** instead, which is the same two triangles.

      *The marina read back as a comb.* Pontoons, moored hulls and a crane or two
      leave strips of dry cells one or two wide running out into the basin, and
      the shoreline grows tongues and sheds flakes from them. Smoothing the edge
      cannot help: the mask itself says the land is there. `openLand` erodes the
      land mask and dilates what survives, deleting anything narrower than 10 m
      and leaving a real quay — tens of metres across — exactly where it was. It
      runs before the speck filter, so flakes it cuts loose are then removed
      rather than left floating.

      The radius is measured, not guessed, and the first attempt got it wrong:
      at 5 m the erosion is three cells, which leaves nothing of a five-cell
      jetty but a chewed remnant — the quays came back gnawed. A marina pontoon
      is 3–4 m across and Monaco's quays are 10–20 m, so the cut belongs between
      them: one cell, deleting strips up to about 4 m wide and leaving anything
      wider untouched.

      **A block the water runs through is drawn at the city belt's cell**, however
      far it is from the circuit. The cut is only ever as fine as the grid it is
      sampled on, so a 16 m cell left the far-belt coast as 16 m steps no matter
      how smooth the line behind it. A coastline is looked at from anywhere,
      unlike the ground behind it. Cost: **+2 959 triangles in the city belt,
      −471 in the far**, 3.65 → 3.69 MB.

      *Islets speckled the harbour.* A LiDAR return off a moored boat or a pontoon
      leaves a few dry cells in the middle of a basin and the terrain dutifully
      built an island there. `despeckleLand` in `raster.ts` returns any enclosed
      land component under **150 m²** to water, before the box average can blur it
      into its neighbours. Monaco now has **zero** enclosed land components.

      *Larvotto still came out as 16 m steps.* 97% of the shore was cut by a line,
      but the remaining 93 nodes sat **26–160 m** (median 76) from any mapped way,
      and there the scalar fell back on the land/water flag — which is boolean, so
      its edge was the grid again. `shore-distance.ts` replaces that fallback with
      a **smoothed signed distance to the water**, built by a chamfer transform
      over the field and blurred twice, so the zero crossing lands between the
      nodes rather than on one. Every metre of coast is now cut against something
      continuous.

      *The cliff edge was a palisade.* A cut vertex inherited the height of the dry
      node behind it, which is right for a quay and wrong for a cliff: Le Rocher
      rises 53 m within 30 m of the sea, so its waterline inherited the clifftop
      and neighbouring edge vertices stood **30 m apart** (median jump 3.6 m). The
      edge is now capped at `SHORE_EDGE_MAX_M` = 3 m — the waterline belongs at the
      water, and the rise belongs to the ground behind it. A quay keeps 3 m of its
      own height, which is what its wall covers anyway.

      Above the waterline the cliff is still terraced, and that is the raster, not
      the mesh: a transect reads 53, 50, 43, 37, 27 m and then nodata, because a
      DTM cannot represent an overhang and steps down instead. Nothing in the bake
      can invent the face it did not measure.

      That fallback exposed the real conflict underneath. Around Larvotto the
      mapped line and the LiDAR disagree by up to 160 m — reclaimed land in one
      source and open sea in the other — so at the edge of the line's influence
      the scalar jumped across zero and the shore came out as a *band of loose
      triangles*, worse than the staircase. The fix is not to blend two sources
      that contradict each other but to drop the one that cannot be corroborated:
      a segment now only cuts if the raster finds water on its wet side and ground
      on its dry side within 15 m. **270 of 810 segments** fail that and the
      smoothed distance takes those stretches instead.

- [x] **P4.0b** Two defects the coast work uncovered, found by looking rather than
      by measuring.

      **Every flat roof was invisible from above.** The cap was built by
      `ShapeUtils.triangulateShape`, whose indices are already wound to face the
      sky once read back in scene axes; reversing them turned all of them over.
      Counted: **1 312 of 1 319** horizontal caps in the core belt faced down, so
      backface culling left the buildings open like boxes — from the air the city
      was see-through. Same test after the fix: 1 310 up, 9 down. (The residual
      handful are self-intersecting footprints where the winding is not
      well-defined; a whole-mesh normal test would not have caught the bug
      anyway, which is why it survived P3.2.)

      **The tunnel had no bore.** The sleeve stopped 8 m in and was capped, so a
      mouth read as a black rectangle painted on the hillside — a "trace of a
      hole", exactly as reported. `bakeTunnelBody` now sweeps the portal's own
      section along the buried stretch of the lap: floor, walls, vault, rings
      every 9 m, open at both ends, so a mouth opens into a bore with daylight at
      the far end. **838 triangles** for the whole 455 m. It is a swept section,
      not an excavation — the bore is only ever seen down its own axis — and P4.1
      still owns cutting the hill open for real.

      **Geometry follows the cover, not the tag.** Built along the whole tagged
      455 m, the bore stood *on* the surface for a quarter of its length —
      measured **549 of 2 652 tunnel vertices above ground, worst 6.7 m**, showing
      as a black strip over the hill. The tag is not wrong: Monaco's tunnel runs
      under the Fairmont for its first 85 m and under the waterfront for its last
      27, and a DTM measures the ground *beneath* a building rather than its roof,
      so the field reads no cover there at all. `coveredRuns` picks the stretch
      with real ground over the road, and both the bore and the mouths follow it:
      the vault is built where something is holding it up, and the portals sit
      where the hill starts. **51 vertices above ground, worst 2.9 m**, and those
      are the headwalls, which are meant to stand proud. The lap is still buried
      for the full tagged length — that is what the profile and the audit read —
      it simply has no vault where the data says there is no hill.

      **Quay walls stopped growing into cliffs.** The wall takes its height from
      the ground behind the line, which is right on a waterfront and absurd
      against a headland: along Le Rocher the ground behind the coastline is the
      clifftop, so the walls came out as a row of fangs standing out of the sea —
      **median 1.6 m, but a tail reaching 38.7 m**. Nobody poured that, and the
      terrain already renders the headland. Segments whose ground is over
      `MAX_TOP_M` = 8 m are now skipped: **93 of 512**, leaving 419.

      **Buildings stopped growing stilts.** Walls ran from the floor down to the
      lowest ground under the footprint, which on the lip of a cliff is the foot
      of the cliff — once the coast was cut back to the waterline those blocks
      stood in the bay on 40 m legs. `MAX_UNDERCUT_M` = 8 m stops the reach:
      past that the ground is not the building's plot, it is the drop beside it.
      Floating buildings stay at zero.

      **The ribbon is not drawn where it is buried.** Under a hill the road is
      inside the terrain, and the depth buffer only hides it while the camera is
      close; from far off its precision runs out and the ribbon shows through the
      hillside in patches. The manifest now carries `track.buried` — inclusive
      index spans over the centreline — and the runtime skips those segments of
      both the ribbon and its outline. Under a hill there is a bore to look at
      instead.

      Two corrections to that, from looking at it: the spans were written as
      **fractions of vertex index**, but the runtime samples its curve evenly by
      distance while the centreline's vertices are spaced by whoever drew it —
      Monaco's hairpins carry a vertex every few metres and its straights every
      twenty — so the gap landed a couple of hundred metres past the tunnel and
      ate live road. They are fractions of lap length now: `0.167–0.297`, which
      is 431 m of 3 337 — and then narrowed again to the stretch that actually
      has a hill over it, the same test the bore is built on, because hiding by
      the tag took the ribbon away while the car is still out in the open under
      the Fairmont and read as missing road *before* the tunnel. **264 m** —
      and then widened again to **365 m**, because that test needs 3.7 m of cover
      to fit a vault while the ground starts covering the road well before that:
      over the metre or two in between the ribbon was genuinely buried and showed
      through the hillside as red dashes. Two questions were riding on one
      number. Whether the ribbon is visible is *is there ground over it*, at
      0.3 m; whether a vault fits is the bore's own test, answered separately.
      Verified: **0 centreline vertices with ground over them are still drawn**.

      What was still showing from above was not the road at all but the portal:
      a mouth sits where the cover first reaches the bore's headroom, which is
      less than the arch plus its headwall needs, so the crown and the outer
      corners of the surround stood out through the slope — **63 portal and 42
      bore vertices above ground, worst 5.5 m**, reading as two bright slivers
      lying in the hill. The arch now scales to the lowest cover along its own
      sleeve, and every point of the headwall is clamped to the ground it sits
      over — the wall is 19 m across and the hill falls away sideways, so its
      corners stood clear however low the arch went. **Zero portal vertices
      above ground**; 15 of the bore remain, worst 1.1 m. And the ribbon is not the only thing drawn along the
      lap: its outline, apron, kerbs and edge lines were still there, showing
      through the hillside as thin red lines. All of them take the same spans.

      **Buildings sit on the ground under each wall vertex**, not on one base
      plane. A single plane either buries the uphill side or leaves the downhill
      side in the air; capping the drop at `MAX_UNDERCUT_M` = 8 m stopped the
      40 m stilts but still left slabs standing where the slope fell away faster
      than the cap. Per-vertex footing does neither, and the cap still applies:
      past 8 m the ground under a footprint on a clifftop is the drop beside it.

      **Quay walls are tied to the cut.** The terrain only follows a segment the
      raster corroborates; elsewhere it follows the smoothed distance. A wall
      built on an un-corroborated line therefore stood off the shore in open
      water — the wedges sticking out of the bays. A wall is now only built
      within `MAX_OFFSET_FROM_CUT_M` = 6 m of the edge the terrain was actually
      cut on: **210 more segments skipped**, 413 built.

- [x] **P4.0c** The land is held clear of the sea plane — `WATER_CLEARANCE_M`.

      The water is one quad at the datum, so ground the DTM reads at y = 0 is
      co-planar with it and the depth buffer picks a winner per pixel. That
      winner moves with the camera, so the bay at Larvotto changed shape as the
      view pulled back — the defect read as a coastline problem and was a depth
      problem. **7,625 m2** of near-horizontal terrain sat within 15 cm of the
      datum; the surface now starts 0.25 m above it and **none does**. The audit
      measures against the same clamp, so the clearance cannot be mistaken for
      drift: worst 0.37 m against a 0.6 m limit, unchanged.

- [x] **P4.0d** The pontoons are decks, not terrain — `scripts/env/piers.ts`.

      Port Hercule's pontoons are **4–5 m wide** and the core belt's cell is
      **4 m**, so the shape is narrower than two samples of the grid meant to
      hold it. No reconstruction of it can be right, and both attempts proved
      it: the raster's version came out as a comb, and cutting the terrain
      against the mapped pier rings produced rounded blobs the size of
      `INFLUENCE_M`. The raster itself agrees it cannot hold them — after the
      opening, only **12%** of the area inside the mapped rings is still land.

      So the deck is not sampled. The ring OSM surveyed *is* the outline, and it
      is extruded directly the way a building footprint is, with walls to the
      same foot the coast's skirt uses. **31 decks**; 3 piers mapped as a line
      keep the terrain's version, 4 are too small to be worth one, and 3 are
      wide moles the terrain already draws properly. Cost: +1,489 triangles and
      one draw call, all in the city belt.

- [x] **P4.0e** The belt boundary stops landing on the waterline.

      Larvotto's breakwaters came out as torn crescents and the harbour quays as
      a row of teeth, and neither was the cause anyone would guess. It was not
      the source: at the waterline itself the surveyed line covers **85%** of
      Larvotto and **100%** of Port Hercule — the earlier "16%" reading was
      measured over a whole window, most of which is open sea, and was
      meaningless. It was not the cell size either: drawing the coast at the
      core belt's 4 m changed nothing.

      Baking the whole city as one belt fixed it completely, which named the
      cause. Two belts cut the same waterline from their own nodes, so their cut
      polylines reach the shared block edge at different points and leave a
      sliver of open water between them — and the grid skirt only fires on a dry
      rim, so nothing closes it.

      So the set of blocks the waterline runs through is grown by one block in
      every direction and the whole band is drawn at the core cell. The belt
      boundary then lies either wholly at sea, where neither side draws
      anything, or wholly on dry ground, where the skirt hides it as it hides
      every other boundary. Cost **3.72 -> 3.95 MB**; the one-belt bake that
      proves the fix is 5.40 MB.

      The audit's skirt filter was wrong too, and this exposed it. Skirts share
      a mesh with the surface and were excluded by dropping anything more than
      2.5 m off the field — which holds only where the ground is flat. On the
      4:1 face below Le Rocher the ground under a skirt's foot is metres below
      the ground under its top, so the foot measured 2.47 m and passed for
      surface. A skirt is now recognised for what it is: a vertex standing
      directly beneath another vertex of the same mesh.

- [x] **P4.0f** The seams the coastal band exposed.

      Growing the coastal band put belt boundaries all through the city, and two
      faults that had been rare became visible everywhere.

      *The skirt asked a different question than the emitter.* A grid skirt was
      only built where `heightAt` had a reading at both ends, while the surface
      above it was built from `solidHeightAt`, which invents one from the
      nearest ring that does. Half of Monaco's belt boundaries touch a node the
      raster calls water, so half of them had surface with no skirt under it —
      an open crack. The skirt now reads the same source the surface did.

      *The boundary was a T-junction.* The coarse side draws one straight chord
      across 8 or 16 m while the fine side follows the ground every 4 m. The
      skirt stops that being a hole and leaves it a ledge. On the shared line
      the fine side now takes the chord: **10,403 nodes**, moved by **6.40 m at
      worst, 0.27 m on average, 776 over a metre**. Measuring shared nodes finds
      nothing — they always agreed — which is why the first measurement of this
      said the seam was fine.

      The audit counts those nodes in their own bucket, from the same block map
      the bake used (`buildBeltBlocks`, now shared) rather than from a second
      copy of the rule. Real surface: worst **0.50 m** over 9,589 vertices.

      *And the pier gate was on the wrong quantity.* Three rings were left to
      the terrain for being mostly solid ground; Port Hercule's north mole is
      66% land and **9 m across**, and the terrain's version of it was a torn
      comb. How much land the raster kept says nothing about whether the grid
      can hold the shape. The gate is now width — under three core cells and it
      gets a deck whatever the raster thinks. **34 decks**, up from 31.

- [x] **P4.0g** Breakwaters get the pontoon treatment.

      Same problem, different tag: Fontvieille's breakwaters are mapped as
      closed rings **6 and 9 m across**, and the grid made the same comb of them
      it made of the pontoons. **37 decks**, up from 34.

      Larvotto's breakwaters cannot be done this way and this is a limit of the
      source, not of the bake: OSM traces them as open `natural=coastline`, not
      as areas. Only **one** closed ring exists in that bay (way/224205566,
      17.5 m across), and the rest have no outline to extrude. Closing the gap
      to the aerial photograph there needs authored geometry — P4.2.

      The same holds for the marina. The box the west quay was compared against
      holds **7 pier ways in OSM** and the bake decks all 7; the aerial shows
      perhaps twice that, because the catwalks between the boats are not mapped.
      Nothing is being dropped — the data stops there.

- [x] **P4.0h** The ribbon stops coming through the buildings.

      The track's layers — apron, ribbon, edge lines, kerbs — were stacked by
      `polygonOffset` because their geometric separation is one or two
      centimetres, too little to survive depth precision at range. But polygon
      offset is a depth bias **scaled by the polygon's own slope**: the ribbon on
      a hillside seen at a grazing angle is pulled toward the camera by an amount
      that grows with distance, and at the Fairmont hairpin it came out through
      the building in front of it. Every "the track shows through" report has
      been this, once the camera-under-the-ground ones are set aside.

      The stack is ordered by height and draw order instead — apron at
      `RAISE - 0.02` drawn first, ribbon at `RAISE`, edge lines and kerbs at
      `RAISE + 0.02` drawn last. `depthTest` is `LessEqual`, so a later layer
      still wins where the depths quantise equal, and nothing is biased toward
      the camera, so a building in front is in front. **Seven** polygon-offset
      blocks removed.

- [x] **P4.0i** The raster's copy of a deck is cleared from under it.

      The LiDAR sees the pontoons and the boats moored along them, and its
      version sits a few metres off the mapped ring — so down the whole of Port
      Hercule the clean deck and a torn strip of terrain were drawn side by
      side, which is what the harbour still looked wrong for.

      The terrain now reads a node as water where a deck is near. Which halo,
      though, is not a distance: **80%** of the raster land within a deck's halo
      is the quay the pontoon is tied to, and the mapped coastline sits several
      metres off the raster's own quay edge in places, so a threshold generous
      enough to protect the quay leaves the debris and one tight enough to clear
      the debris bites notches out of the harbour wall — which is exactly what a
      10 m halo did. The test is relative instead: clear only where the **deck is
      the nearer of the two lines**. Which is closer does not care how far
      either of them is.

- [x] **P4.0j** A coastline the raster contradicts is still a coastline.

      Port Hercule's pier fingers came out as torn slabs offset from where they
      are mapped, and the cause was `agreesWithRaster` throwing away the very
      segments that describe them. **36%** of the harbour outline in that band
      was dropped, including the two 58 m segments that *are* the fingers.

      They were dropped for reading **reversed** — the raster finding ground on
      the wet side of the line and water on the dry side. But a coastline is
      oriented by definition, land on its left, so it already knows which side
      is which, and what the raster calls ground out there is the boats moored
      along the pontoon. Ten segments in the whole city read like this. What the
      confirmation is really for is a line the raster has nothing to say about
      on *either* side — the Larvotto case, mapped up to 160 m from where the
      LiDAR puts the water, sea on both sides of it. Silent is now the only
      failure; reversed is kept.

      Two other readings of the same evidence were tried and measured worse.
      Deleting the raster's land on the wet side of a contradicted segment
      merged the slabs into the quay and turned the quay's own edge into a
      sawtooth. Clearing a fixed halo around every deck bit notches out of the
      harbour wall.

      The corner hole at the pier root is separate: the signed distance is to
      the *nearest* segment, so where a pier meets its quay that segment's wet
      side sweeps back over the ground behind it. The line read **-1.8 m** there
      with **+2.4** and **+1.0** either side, while the raster had it 9.6 m
      inland. A shallow hole in ground the raster is confident about is now
      overruled — **54 nodes**, at a gate tight enough not to hand the shoreline
      back to the grid, which a looser one did.

      That gate closed the rim of the hole and not its core, and widening it
      brought the sawtooth back, so the hole is closed by **enclosure** instead,
      which needs no threshold on depth at all. A patch of water ringed by land
      is either a basin or an artefact, and every real basin here reaches the
      sea — so a small one that does not is an artefact. The shoreline is
      connected to the sea by construction and cannot be caught by this. **Ten
      cells** in the whole city, decided once on the core lattice so every belt
      fills the same ones.

- [x] **P4.1** The approaches are excavated, so the mouth is a hole in a face.

      D4 asked for a boolean cut through the hill. A height field cannot hold a
      cavity, so what it can be given instead is the part of the excavation that
      is actually visible: the **cutting** the road runs in before it reaches the
      rock. That is where the defect was. The tunnel is tagged for 455 m but the
      hill only covers 335 of them, and the terrain was the raw hill for the
      whole tag — so at each end a lip of ground rose over the road, the ribbon
      dived under it, and it cut across the arch in front of the mouth. From
      outside, the exit read as a pipe lying in a slope.

      **The burn-in now stops at the vault, not at the tag.** The corridor
      flattening already knows how to cut a shelf for a road; it was held back
      over the whole tagged tunnel, because burning a tunnel in would carve a
      canyon through the hill. Those are two different questions, and
      `TrackConstraint` now asks them separately: `buried` still says *do not
      trust the raster for the road's height here*, and a new `vaulted` says
      *leave the ground alone, something is holding it up*. Everything tagged but
      unvaulted is burned in, which is the cutting.

      Which stretch is vaulted cannot be known before the ground is, so the
      ground is built **twice**: a survey pass with the whole tag held back, to
      read how much hill there is over the road, and then the real pass holding
      back only what `vaultedRuns` found. No network, and the second pass is
      milliseconds.

      **The mouths move inward to where a full-height portal fits.** The arch
      used to be scaled down to whatever cover was at the mouth — measured 49% at
      Monaco, a squat opening — because a mouth sat where the cover first reached
      the *bore's* 3.7 m. It now walks in until the hill is `PORTAL_NEED_M` = 9 m
      deep, up to 30 m. Selecting the run at 9 m instead would have split it:
      Monaco thins to **6.6 m** of cover halfway through, which would have put
      two more mouths in the middle of the hill. **18 m cut open** in total, 9 m
      at each end, and both arches are full size.

      **The cutting stops square at the face.** A corridor is a distance to a
      polyline, so its end cap is round and reaches a full 13 m past the last
      burned sample — straight through the mouth, flattening the very hill the
      portal has to be a hole in. Measured: cover at both mouths read **0.00 m**
      and the arch collapsed again. Cells whose projection falls beyond the join
      are now left alone, so the flattening ends on the plane of the mouth and
      the rock stands where the vault begins.

      **The tunnel's geometry is sized against the hill, not against its own
      cutting.** The cut at a mouth exists *because* the portal does, so reading
      it back is circular — and it read as no cover at all. The pre-cut field is
      carried through to `bakePortals` and `bakeTunnelBody` for both the arch's
      scale and the headwall's clamp. Against the hill that shaped it: **0 of
      2 034 bore and sleeve vertices** and **0 portal vertices** stand above the
      ground, where the best previous result was 15 bore vertices at 1.1 m
      against a scaled-down arch. Against the finished terrain the headwall now
      stands 9 m proud — which is the point, it is a wall in an open cutting.

      **And the ribbon was hidden by the wrong ruler.** `buriedSpans` walked the
      *drawn* centreline, which carries a vertex every 30 to 70 m through
      Monaco's tunnel, and a span can only begin at a vertex — so **51 m** of
      ribbon was still drawn inside the hill at the entry, which is the red band
      that kept coming back. It walks the field's 3 m profile now. Hidden
      **647–973 m** against a vault of 641–976: **0 covered centreline samples
      are still drawn**, and the road stays visible right up to the face, which
      is what "there is road missing before the tunnel" was asking for.

      **The clip is a plane at the mouth, not a rule about segments.** Stopping
      only the last segment of the cutting was not enough — the one before it
      reaches just as far, because every segment carries its own round end cap.
      Measured: terrain nodes **6 m inside the vault** were still being pulled
      down to the road. The half-space at the mouth is checked once per cell and
      holds only within a corridor's reach of it, since a plane over the whole
      map would refuse to burn every other part of the lap beyond it.

      **And the mouth is a hole in a face, which needs the field to lose
      something.** With the cutting in place the terrain still crossed the
      opening: the cut floor and the untouched hill are neighbouring nodes 3 m
      apart with 8.6 m between them, and the surface drawn across that pair is a
      ramp — steeper than the arch and straight through it. A ray down the axis
      hit terrain **0.6 m before the mouth**. No wall in front helps; the ramp is
      *inside* the hole.

      So the ground over the arch is removed — `portalVoids`, D4's boolean cut
      reduced to the one shape the field has to lose — and the portal closes what
      that leaves: a face at each end with the arch cut out of it, a wall down
      each side, and a lid over the top. The same ray now runs **139 m** down the
      bore. Three sizing lessons, each found by looking: the face has to be wider
      than the void, because the void is decided on cell centres and the hole it
      leaves runs half a cell past its nominal edge; the face's height has to be
      read across its own width, not at its centre, or its corners come up short;
      and without a lid the excavation reads from above as a black rectangle cut
      into the slope — closed at the road's level and open at the sky's.

      Cost: **0 bytes**. Portals 75 → 148 triangles, and the terrain cell counts
      are otherwise unchanged — the cutting replaces hill that was already being
      drawn.

- [ ] **P4.2** Authored GLB props placed by coordinate: Casino, yachts, harbour cranes
      (D10's third tier).
- [ ] **P4.3** Trees and vegetation.
- [ ] **P4.4** Migrate the remaining 23 circuits, then **delete
      `environment-layer.tsx`** and the old runtime path. This is D17's termination
      condition — the plan is not finished while both paths exist.

**Distance limits are off** in `track-viewer.tsx` while the city is being looked
at: inspecting the ground means getting under the eaves and down to street level,
and every one of the old bounds forbade it. They come back with a pass of their
own.

The floor stays, at `PI/2 - 0.02`. Terrain is a surface, not a solid, and its
back faces are culled, so from below the whole city is see-through — the road
shows through the hillside, the water shows through the ground, and the harbour
walls read as dark patches floating in the bay. Every "it goes transparent when I
rotate" report so far has been the camera slipping under the surface it was
looking at.

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
