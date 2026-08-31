# Project map

Orientation file. Where things live, what owns what, and which file to open for a
given symptom.

Its companions, one question each: [`architecture.md`](architecture.md) — how the app
runs. [`scene-goals.md`](scene-goals.md) — what the baked scene has to be, and the
invariants that decide it. [`roadmap.md`](roadmap.md) — what is next.
[`city-generation.md`](city-generation.md) — why the pipeline is shaped this way
(D1–D17). [`history/city-generation-p0-p4.md`](history/city-generation-p0-p4.md) —
what was already built.

## Two halves

The repo splits cleanly in two, and they meet only through files in `public/`.

```
scripts/       bake time — Bun scripts, network access, minutes per run
   ↓ writes
public/        the contract — JSON + GLB, committed, the only thing shipped
   ↓ reads
src/           run time — Next.js + R3F, no third-party fetch, milliseconds
```

Nothing under `src/` computes terrain, buildings, or coastlines. If the scene is
wrong, the fix is almost always a bake script plus a rebake, not a component.

## Bake pipeline (`scripts/env/`)

`bun run env:bake <circuitId>` — `bake.ts` (2.0k lines) is the orchestrator; the
rest are single-purpose modules it calls.

| File | Owns |
|---|---|
| `bake.ts` | Orchestration. `loadBakeInputs` does the reading, `bakeFrom` the baking (D19). Marching-squares terrain, belts, shore skirts, buildings, roads, tunnel bore, GLB writing (`@gltf-transform` + meshopt). |
| `circuit.ts` | Loads centreline coords + bbox for a circuit id. |
| `plane.ts` | `scenePlaneFor()` — lon/lat ⇄ scene x/z. Every coordinate crosses here. |
| `raster.ts` | IGN WMS float32 BIL fetch, nodata masking, flat-water marking, `openLand`, `despeckleLand`, downsample. |
| `heightfield.ts` | The height field — single source of truth. MSL datum, NaN = water. |
| `coastline.ts` | Surveyed shoreline as a **signed distance field** from OSM ways. Land-on-left, raster corroboration. |
| `shore-distance.ts` | Smooth chamfer-distance fallback where no surveyed line reaches. |
| `shore.ts` | Quay/seawall geometry. |
| `piers.ts` | Piers, breakwaters, groynes. |
| `tunnels.ts` | Tunnel mask; bore + portals + buried-span fractions come out of `bake.ts`. |
| `overpass.ts` | All OSM queries (buildings, coastline, structures, breaklines). |
| `building-heights.ts` | MNH raster → per-building height. |
| `roofs.ts` | Roof kind planning + geometry. Winding matters — flat caps face **up**. |
| `belts.ts` | Detail belts: core 4 m ≤150 m, city 8 m ≤600 m, far 16 m. |
| `ground.ts` | The one surface. Per-belt filtered nodes and triangle-exact height queries; everything that stands on the ground reads this, never the raw field. |
| `breaklines.ts` | Surveyed cliffs, retaining walls, quays and breakwaters — the lines `ground.ts` may not average across (D18). |
| `shots.ts` | The eight fixed cameras of `scene-goals.md` §4 and the headless runner that takes them. `bun run env:shots`. |
| `fixture.ts` | Cuts a window of a circuit's inputs out of the caches and reads it back as `BakeInputs`. `bun run env:fixture`; the slice is committed under `fixtures/`. |
| `synthetic.ts` | Ground written by hand — a plane, a slope, a cut — built through the same `heightFieldFrom` the bake uses. Test material only. |
| `ground.test.ts`, `breaklines.test.ts`, `baked-scene.test.ts` | Layer A of `scene-goals.md` §3: the invariants on that synthetic ground. `bun run test`. |
| `bake.test.ts` | Layer B: the Monaco fixture through the real bake, judged with the audit's own checks. |
| `baked-scene.ts` | Reads shipped GLBs back: belt meshes, a terrain index, and the welding that turns flat-shaded triangles into buildings again. |
| `mesh.ts` | Shared mesh/vertex helpers. |
| `ao.ts` | Baked ambient occlusion into COLOR_0. |
| `greenery.ts` | Green areas: ground tint from parks/woods/lawns, plus pool and pitch surfaces. No trees — they were built here once and removed. |
| `props.ts` | Berthed yachts, cranes, grandstands; parametric or from a `.glb`. |
| `skadi.ts` | SRTM Skadi global elevation, used where IGN has no coverage. |
| `bake-all.ts` | `env:bake:all` — sweeps every circuit, keeps going past failures. |
| `overrides.ts` | Per-circuit manual corrections. |
| `preview.ts` | Local bake preview server on **:4010** (separate from the app on :4000). |

Audit: `bun run env:audit` → `scripts/audit-environment.ts` (D11 checks, green on
Monaco). It reads the shipped GLB, not the intermediates — see
[`scene-goals.md`](scene-goals.md) for what each check judges. Run it after every
bake; it is the thing that has caught most regressions.

Other bake-time scripts (not environment): `generate-circuits.ts`,
`generate-elevations.ts`, `generate-track-widths.ts`, `generate-car-manifest.ts`,
`generate-team-cars.ts`, `optimize-car-model.ts`. `generate-environment.ts` is the
**old** pipeline, still present until P4.4 retires it.

## The contract (`public/`)

- `circuits-index.json`, `circuits/` — circuit list, read locally (never GitHub at
  runtime; a 429 once emptied the list).
- `elevations/<id>`, `track-markers/<id>`, `track-widths/<id>` — per-circuit track data.
- `environments/<id>/` — the bake. For `mc-1929`: `core.glb`, `city.glb`, `far.glb`
  (the three belts, ~3.7 MB total, 12 draw calls), `city-manifest.json`,
  plus legacy-path JSON (`terrain`, `buildings`, `roads`, `water`, `landuse`, `surface`).
- `cars/`, `textures/`, `intro/`, `track-turns/`.

## Runtime (`src/`)

```
app/page.tsx → home-router → globe/ | track/f1-track-app | race/race-app
```

**Scene assembly** — `components/three/`:
- `track-mesh.tsx` (965) — the scene. Curve, ribbon, kerbs, apron, markings, gantry,
  fleet, environment, camera. Reads `cityManifest.track.buried` to hide tunnel spans.
- `city-layer.tsx` — mounts the baked GLB belts, far first. Builds nothing.
- `environment-layer.tsx` (1024) — the **old** JSON runtime path. Dies at P4.4.
- `race-camera-rig.tsx`, `car-fleet.tsx`, `start-grid-cars.tsx`, `studio-stage.tsx`.

**Track geometry** — `src/lib/track/`: `track-geometry.ts` (ribbon), `track-kerbs.ts`,
`track-apron.ts`, `track-markers.ts`, `track-curvature.ts` (the one curvature profile
every corner-shaped thing reads), `track-corners.ts`, `racing-line.ts`,
`start-finish.ts`, `track-width.ts`, `elevation.ts` / `elevation-api.ts`.

Every ribbon builder takes `hiddenAt?: (s: number) => boolean`, where `s` is a
**fraction of lap length** — not vertex index. That distinction cost a bug.

**Environment runtime** — `src/lib/env/`: `city-loader.ts` (belt manifest + URLs),
`environment-loader.ts` (legacy bundle), `terrain-sampler.ts` (still the old sampler —
P1.2b is to rewrite it over the baked field), `diorama-palette.ts`,
`environment-types.ts`.

**Hooks** — `use-circuits`, `use-track-data`, `use-circuit-scene`,
`use-race-simulation`, `use-start-lights`, `use-start-finish-calibration`.

**Race** — `src/lib/race/`: `race-sim.ts`, `speed-profile.ts`, `start-grid.ts`,
`race-session.ts`, driver/team data. UI in `components/race/`.

## Commands

```
bun run dev            # app on :4000
bun run env:preview    # bake preview on :4010
bun run env:bake mc-1929
bun run env:audit
bun run typecheck && bun run lint
```

## Gotchas that keep biting

- `frameloop="demand"` — any change outside render must call `invalidate()`.
- Terrain back faces are culled. "It goes transparent when I rotate" has always been
  the camera slipping under the surface. `maxPolarAngle` floor stays at `PI/2 - 0.02`.
  Camera **distance** limits are deliberately off pending their own pass.
- Measure before fixing. Count vertices in the shipped GLB against the height field;
  several confident diagnoses here were wrong until measured.
- Commits in this repo carry **no** `Co-Authored-By` / `Claude-Session` trailers.

## What is next

In [`roadmap.md`](roadmap.md) — one list, so a task cannot be open in one file and
done in another. The invariants a change has to keep are in
[`scene-goals.md`](scene-goals.md).
