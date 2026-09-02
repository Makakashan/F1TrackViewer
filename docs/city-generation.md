# City generation — decisions and findings

Monaco (`mc-1929`) is the test bed: the steepest terrain, the tightest buildings, the
only tunnel. Anything that works there works everywhere. The reference look is Apple
Maps' 2025 Monaco Grand Prix city experience — stylised realism, not a photograph and
not a Minecraft block.

This document is the record of *why the pipeline is shaped the way it is*: what was
broken and how that was measured, the decisions taken (D1–D17), the data contracts
they imply, and what the source data turned out to be. Update it as decisions change;
do not let the code and this file disagree in silence.

Three companions carry the rest. What the scene has to look like, and the invariants
that decide it: [`scene-goals.md`](scene-goals.md). What is planned next:
[`roadmap.md`](roadmap.md); what was already built is in `history/`. Phase by phase:
[`history/city-generation-p0-p4.md`](history/city-generation-p0-p4.md).

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
| **D10** | Overrides may edit **data** (heights, add/remove buildings, terrain points), **masks** (no-build, water, tunnel, grandstand), **splines** (quay wall, barrier, breakwater) and **props** placed by coordinate — a parametric kind or a named `.glb` (P4.2). | Covers every named bug class without becoming a level editor. |
| **D11** | `env:audit` reports numbers and fails on regression. | Regressions are caught by a threshold, not by someone happening to look. |
| **D12** | ~~GDAL/PDAL CLI~~ **Superseded by P0.3.** Elevation comes from the IGN Géoplateforme WMS as `image/x-bil;bits=32` — a raw little-endian float32 raster in EPSG:4326, at whatever grid we ask for. TypeScript reads the response body straight into a `Float32Array`. No GDAL, no PDAL, no Python. | Nothing to reproject, clip or convert. The whole raster step is one `fetch` and a `DataView`. A provider interface keeps the door open for non-French circuits. |
| **D13** | The track's visual mesh (ribbon, kerbs, apron, markings) is baked into the GLB. The centreline curve stays live for the simulation, camera and start/finish calibration — both produced by one pass. | The heaviest runtime build in the scene is static; the curve that must stay live, stays live. |
| **D14** | Three files per circuit: `far.glb`, `city.glb`, `core.glb`. Loaded far → city → core. No 3D Tiles streaming. | Fast first frame; per-belt byte budgets. 3 km² does not repay a streaming runtime. |
| **D15** | Heights are metres above sea level as the DEM reports them. Water is a plane at `y = 0` in that datum. **The coastline is the DEM's nodata boundary for open sea, and the flat-constant rule of §5.6 for enclosed basins** — IGN carries no bathymetry, so the sea is nodata rather than negative depth (P0.1), while a harbour arrives stamped with one repeated value. OSM water polygons are used only for inland water and as an audit assertion — never to decide the coast. | One source for the boundary means it cannot disagree with itself. The implementation is the nodata mask, not a zero crossing, but the principle is unchanged. |
| **D16** | Props whose absence reads as a bug — barriers, fences, grandstands, tunnel portals — ship in the core belt, instanced, one draw call per type. Trees and yachts follow via D10 props. | Detail without spending the draw-call budget. |
| **D18** | A belt coarser than the field averages it, and the average stops at a **breakline** — a line OSM surveyed as a cliff, a retaining wall, a quay or a breakwater. Soft edge-preserving kernels were measured first and rejected: at equal kink, a bilateral against the local mean keeps exactly the fraction of the step a plain box keeps, because the DTM already smears a wall across the width of the filter window. | The one thing that separates a wall from a metre of ripple is knowing where the wall is, and that is surveyed data rather than a cleverer average. Off a line, the summed-area tables answer as before and the bake pays nothing. |
| **D19** | The bake reads its inputs in one place (`loadBakeInputs`) and bakes from them (`bakeFrom`), so a committed fixture goes through the same pipeline a circuit does. | Layer B of the test plan is the real bake over 200 × 200 nodes of Monaco in under a second, not a second implementation of it that could drift. |
| **D20** | Terrain normals are split where two faces disagree by more than 15°. Below that a hillside still shades as one surface; above it a cliff top, a quay and a terrace riser keep their edge. | A belt at 8 or 16 m with fully averaged normals reads as poured wax — the cliff face and the ground over it share a corner whose normal points at neither. Costs no triangles and a few per cent more vertices: Monaco went 5.90 to 6.16 MB. The angle was chosen by looking — 25° still left Le Rocher as drapery, 10° was not visibly better than 15°. |
| **D21** | The pit a portal cuts is walled along its own rim — every edge where a dropped cell meets a built one — rather than closed by a rectangle sized from the void's own numbers. The sleeve carries an outer skin as well as an inner one. | A cell is dropped by its centre, so the hole runs up to half a cell past the nominal width and follows the belt's lattice; the rectangle was two metres narrow and daylight showed either side of the arch. And a tube whose faces all point inward is invisible from outside: the camera looks through the near wall at the lit far one and the opening reads as a film over the cutting. An emissive bore was tried for the same complaint and taken out — on a near-black base it came out olive and made the film worse. |
| **D22** | The bbox rim goes to one flat floor at **−60 m** as a plinth, in its own darker material, instead of dropping a 3 m skirt. The wall's top is the far belt's own rim vertex where the rim is land and the datum where it is sea, so it closes the water quad's edge with the same move. | The landscape stopped being a sheet with a hill printed on it. Costs 1,426 triangles and one draw call in the far belt: 88,969 → 89,713 with the rim skirts it replaces, 1.52 MB of 2 MB. Deep enough to read as a block against 455 m of relief, shallow enough not to turn the model into a column, and nobody sees the floor — the camera stops at the horizon — so it shares the sides' material. |
| **D23** | The bake writes one palette — the light one — and the dark theme is applied over the loaded materials at runtime, per mesh kind, from the same table in `diorama-palette.ts`. The dark set is the light set at 32 % of its linear luminance with a slight cool tilt, not a hand-picked set of dark colours. | One bake serves both themes: no second GLB, no rebake to change a colour, and the meshes are already named for their kind so the lookup cannot guess wrong. Scaling the light set is what keeps the form: a hand-picked dark palette of the same mean measured flat — mean 42 with sd 19 against 54 with sd 31 — because terrain and buildings had drifted to nearly the same value. The light scene reads mean 108, sd 47. |
| **D24** | A mouth gets an approach cut: the void runs 16 m out in front of it at the road's level, floored by the portal's own slab, and no pit wall is drawn where the sleeve passes. The sleeve reaches 14 m in — past the excavation — carries its outer skin its whole length and is capped at the far end. The lid over the cutting follows the hill node by node instead of spanning it flat. | Every one of these was a thing the eye met instead of a tunnel. The ground outside stood ~2 m above the road and buried the arch's lower half; the pit's far rim was a lit terrain wall square across the road, seen through the opening; past the sleeve's end the culled back faces of the hill let the sky through, so a bright patch sat where the tunnel goes; and the flat lid read as a grey plate laid on the slope. Cost: portals 196 → 276 triangles, core 122,356 → 122,354. The arch itself was left alone — measured, both Monaco mouths already build at full scale (cover 9.9 m and 9.5 m against the 6.5 m crown), so the "squat arch" in the plan was not a Monaco problem. |
| **D37** | The kit is off, and the extrusions carry the detail instead: a shop front, storeys painted band by band, and two kinds of thing on a flat roof. | The models were somebody else's houses, fitted to Monaco's plots by stretching them; even inside the anisotropy cap the seams showed on the doors, and 173 modelled buildings against 4,572 extruded ones meant the city still read as boxes. Painting the walls storey by storey costs a quad per floor per wall and reads as floors from anywhere the wall is visible; the roof boxes come in two sizes now — a stair head and a vent stack — because one repeated cube on every roof is a pattern of its own. With the kit's budget back, the city belt runs 304,293 of 350,000 triangles and the core 176,333 of 450,000, both with more detail on every building than the kit put on a few. The pack sources stay in `bake.ts` as an empty list rather than being deleted: turning the models back on is that list. |
| **D36** | Every extruded building gets a shop-front band and, on a flat roof, a lift head or two (extended by D37 into storey bands and two kinds of clutter). A mesh carries a `tone` that the triangle adder writes into `albedo`, rather than a caller counting vertices. | The models fixed a few hundred buildings; the other four thousand were prisms. Two things say "building" at street distance and neither needs an asset: the line where the ground floor ends, and something standing on the roof. The band is paint on two extra rows of vertices, the clutter is boxes — at this size a lift head is a box in life too, and it is ten triangles rather than a thousand. Cost to the city belt: 32,394 triangles for both, paid for by dropping the kit's budget share from 0.5 to 0.42 (266 modelled buildings → 173). A band on all 4,572 beats a hundred more models on a few. Two bands rather than three: the parapet already draws the top edge. The tone is 0.65 because I11 floors vertex colour at 0.278 and the occlusion floor is 0.45 — a band cannot take more than a third of a wall. The `tone` field is the other half: a parallel array counted by the caller cannot survive `addFlatTriangle` dropping a degenerate one, and it did not — core was 5,789 vertices out of step, which painted the bands onto other people's walls. |
| **D35** | A model is stretched to the plot on all three axes — the surveyed rectangle and the measured height — and what decides whether it can be used is the anisotropy of that fit (capped at 1.2 by the track and 1.5 behind it), not its own proportion. Two more CC0 packs join the library. | Placed by its length and scaled whole, a model kept its author's proportion rather than the survey's: measured over the 173 modelled buildings, the height came out 10 % off the survey at the median, 21 % at p90 and 25 % at worst, and the model covered between 0.52 and 3.13 of the plot's width — 25 of them under 0.70, which is a gap in a terrace, and the wide ones spilling onto the street and the neighbour. Fitted, the footprint is the footprint and the height is the height; what is spent instead is squareness — and that is a door: at 1.7 a doorway is half again as wide as it was drawn, which on the front row is the first thing the eye finds. So the cap is per belt: 1.2 in the core, where the distortion is at the edge of noticing (measured 1.09 median, 1.18 worst over 66 buildings), 1.5 in the city belt where a door is a few pixels (1.22 median, 1.50 worst over 200). Coverage is what pays: on one cap for the whole city, 1.7 gives 266 modelled buildings, 1.4 gives 231, 1.3 gives 173, 1.2 gives 131 — split by belt it stays at 266, because the plots that need the stretch are mostly not the ones by the road. Normals are divided by the same scales, or a stretched wall lights as though it were still square. The cap replaces the old 25 % proportion tolerance, which is why fewer plots come back without a model (244 → 87) even though the test is stricter about the result. City Kit (Industrial) adds 20 whole buildings at ratios 0.39–1.34 — the low and wide range the library had nothing in — and Modular Buildings adds its 7 assembled samples; the rest of that pack is walls and doors, so the loader takes prefixes per pack. 266 buildings modelled, city belt 336,464 of 350,000. |
| **D34** | The commercial pack joins the suburban one, the plot ceilings and the district rule go, and the kit's budget is one number spent nearest-first. A model is refused where the road reaches into what it would cover. | The ask was to model every building where a model fits. What stopped that was a library of one suburban pack — hence a 400 m² and 12 m ceiling, and a district rule so that no toy house stood in a row of blocks. With Kenney's commercial pack loaded the library runs from a two-storey house to a skyscraper (1,087–5,171 triangles) and carries a cheap tier besides (62–378), which the city belt takes first: at a hundred metres a modelled cornice is a few pixels and the same budget buys ten times the buildings. The budget had to become one number because every model ships in the city belt's mesh whatever belt's distance it stands at — two allowances were spending one belt's triangles, and the belt went 41,590 over. The corridor rule is new and necessary: an extrusion is pushed off the road vertex by vertex, a model cannot be, and the model covers its own footprint rather than the plot's — fitted by length and scaled whole, it stands out past the rectangle wherever its proportion is wider. Without that test 327 vertices sat in the racing surface. 173 buildings modelled of 1,445 that fit the shape: 244 have no model at their proportion, 4 are on the track, 571 ran out of triangles. City belt 337,715 of 350,000. |
| **D33** | A kit building takes the diorama's paint — hue dropped, and each model's own average landing at 0.65 of the range so the tones keep their order without any model reading dark — and a plot under 8 m long is not one. The neighbour rule drops to 0.3 with it. | Kenney's houses are painted for their own scene, so in a white city they read as green and charcoal patches rather than as houses; what carries the shape is the order of the tones, not the hue, and the order survives the remap. The size floor is the other half: the shape test had a ceiling and no floor, so 31 of the 75 placed plots were under 8 m and the shortest was 3.6 m — a two-storey house shrunk to the size of a car. The two knobs turned out to be one rule: sheds counted as qualifying neighbours and voted each other in, so with the floor in place 0.6 of a neighbourhood is unreachable — measured, an 8 m floor leaves 7 houses at 0.6 and 12 at 0.4, which is the feature switched off, against 48 at 0.3 and 85 at 0.25 with no district test left worth the name. 48 houses, 58,657 triangles, shortest plot 8.3 m; city belt 256,036 → 222,510. Trees and boats keep their own colours, because a green tree and a white hull are already the colour the thing is. The lift is measured against a flat-white control — the same bake with every model vertex on the wall tone — because the occlusion pass multiplies over this paint, and a tower of balconies carries enough baked shadow that an average halfway up the range still came out a grey block among white ones. |
| **D32** | A kit house stands on the middle of the ground under its plot, and the fitted rectangle is walled from the ground up to that floor as its terrace. `env:audit` measures a model against the ground **or** the built surface under it, whichever is higher. | The model was standing on the plot's lowest corner, which on a hillside is the bottom of the slope: measured over the 75 modelled houses, the ground under a plot ranges 1.5 m at the median and 8.9 m at the worst, and **12 of 75 lost more than half their height into the hill**, the worst 88 % of it — one green roof and nothing else. Standing them on the median instead is what every extrusion here already does, and the terrace is what the downhill side needs; a house on a Monaco hillside has one anyway. The rectangle rather than the surveyed ring, because the rectangle is what the model covers — with the ring, a corner of the model hung 0.16 m over the terrain. The walls dig 0.3 m, like every other wall here. 69 of 75 plots are steep enough to earn a plinth; city belt 255,346 → 256,036 triangles, no new draw call. The audit change is the honest half of it: a house on a terrace is above the terrain by construction, and the check exists to find things standing on nothing, not things standing on what the bake built for them. |
| **D31** | Greenery is planting, not paint: the survey's own `natural=tree` nodes and `tree_row` lines are placed as kit models, and a park's fill is muted to a quarter of the way from the ground colour to green. Trees stand no closer than 11 m to the centreline. | The flat green area was still "a green patch on grey" from every angle that showed it, and the kit has a 42-triangle tree that is somebody else's model rather than the canopy-and-trunk that failed here before. OSM has 662 of Monaco's trees as nodes, so nothing is scattered: they stand where they are mapped. 636 survive the corridor rule — a street tree is mapped at the kerb, and `env:audit` counted 417 vertices of planting inside the racing surface before the clearance was widened past the corridor's own 8 m, because a canopy reaches past the point it is planted at. City belt 215,078 → 240,218 triangles, 3.49 → 3.96 MB, no new draw call: the trees merge into the models mesh the kit houses and the yachts already use. |
| **D30** | A lid — park, pitch, pool — is split until no edge is longer than 3 m, each new vertex taking the ground's own height, and lifted 0.35 m; `polygonOffset` on top of that. A pool is left whole: it is smaller than the step. | Two causes wearing one symptom. The depth bias answered the smaller one — at two kilometres with near at 2 m, 0.12 m of lift is the buffer's whole precision, and without the offset the terrain ate 11.1 % of the park area at the wide shot. The larger one no bias can touch: a lid drawn as one triangle over its polygon is a plane and the ground is not, so the two genuinely cross. Measured by dropping a ray through each lid triangle's middle: the terrain stood **above** the lid at 44 % of 1,064 points, worst by **12.19 m**. Splitting at 6 m left 10.6 % and 2.77 m; at 3 m with a 0.35 m lift, 0.2 % and 0.35 m. The last of it went when each vertex stopped reading the ground directly under it and started taking the highest reading within half a step — the upper envelope of what its triangles span, so the surface between two vertices cannot dip under the hill. Zero of 5,844 points. The lids then started fighting each other instead: a pitch is inside a park and a pool inside a pitch, and on one envelope they land on one height — 23 of 48 pitch points over a park were within 5 cm of it and the park stood up to 0.29 m over the field it contains. Each kind now has its own floor above the envelope — park 0, pitch 0.5 m, pool 0.8 m. A quarter of a metre was not enough of a step: the two lids read the same envelope at their own vertices, so between a park's vertices its surface still stood over a pitch vertex, by 0.097 m at the worst of 4,671, which is a wedge of park through the football field. Half a metre clears that with 0.15 m to spare — 0 of 284 pitch points have park above them — and costs nothing to look at, because what a pitch's rim stands over is the park rather than the ground. Cost: core 128,331 → 136,325 triangles, city 240,218 → 255,346, total 6.82 → 7.07 MB. |
| **D28** | Parks, gardens and fountains are drawn — as areas over the terrain, following it vertex by vertex and triangulated as the polygons they are. Trees stay deleted. | The park was the piece of Monte-Carlo somebody notices missing, and the two things that failed before were *trees* (a canopy and a trunk each, one six-sided shape a thousand times) and a *green tint on the terrain* (paint on the ground). An area with its own edge is neither. Flat lids and centroid fans were both wrong for it: a park on Monaco's slope would bury its uphill half, and a garden is concave often enough that a fan spills over its own edge. A fountain is water like a pool is and ships with them. |
| **D29** | The greenery cache stores the tag list it was fetched with, and a cache answering an older list is refetched. | `leisure=swimming_pool` and `leisure=pitch` were added to the query months after Monaco's cache was written, and a cache that exists is never asked again — so every bake since reported `0 pools` on the circuit whose corner is called Piscine. The guards against caching an empty or partial answer could not see this one: the answer was complete for the question it was asked. |
| **D27** | The same subtraction is applied to the *road*: a footprint the drawn centreline runs through is split by a band of `TRACK_CLEARANCE_M` either side of the local road direction. Only where the road is drawn — a building over a vault stays whole. | A small block astride the road has its corners well clear of the corridor, so there is neither a vertex nor an edge to push, and the lap ran straight through way/1470365896 by the harbour. Measured by walking the profile against every kept footprint: three stood over the road, two of them over the tunnel, where they belong. 4,702 → 4,703 buildings. |
| **D26** | A footprint standing over a portal's cutting has the cutting subtracted from it — three half-plane clips (left of it, right of it, and what lies beyond its far end between the two), pieces under 12 m² dropped, one building per piece. | Pushing vertices cannot help a block whose footprint *contains* the cutting, and Monaco's inland mouth had a 36 m one over it — measured straight down at the mouth. The arch was built inside a building, so from the road the tunnel was a wall. The front of the rectangle is left open because that is where the road comes in. One Monaco footprint splits, into three pieces: 4,700 → 4,702 buildings, core 124,083 → 124,307 triangles. |
| **D25** | The ribbon is hidden exactly where the vault covers it, and a footprint whose *edge* crosses the track corridor is densified along that edge before the vertices are pushed out, so the building closes around the road instead of over it. | The road used to stop wherever the DTM first found 30 cm of cover, which is metres before the portal the mouth was pushed inland to find: the ribbon went missing in the open with nothing to enter. And pushing vertices cannot clear an edge whose ends are both outside the corridor — three of Monaco's footprints are like that, one of them the block over the inland mouth, so the road ran into its wall. Notching them costs 1,729 triangles in the core belt and gives the road somewhere to go. A vertex landing dead on the centreline now takes its neighbour's side; left where it was, densification put wall vertices 8 m inside the corridor and `env:audit` failed on it. Measured on the way: roofs are *not* what covers the road at either end — over the 87 m under the Fairmont and the 26 m at the waterfront the footprints simply do not reach the road, so treating a roof as cover moved the mouths by four samples and was dropped. |
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
scripts/env/ground.ts        one filtered surface per belt, triangle-exact queries
scripts/env/breaklines.ts    surveyed lines the filter may not average across (D18)
scripts/env/fixture.ts       a committed slice of a circuit, cut from the caches (D19)
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

The phase-by-phase journal of P0–P4 — what was built, in the order it happened, and
why each step took the shape it did — lives in
[`history/city-generation-p0-p4.md`](history/city-generation-p0-p4.md). It is closed
for growth.

What is planned next lives in [`roadmap.md`](roadmap.md). What the result has to look
like, and the invariants that say so, live in [`scene-goals.md`](scene-goals.md).

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
