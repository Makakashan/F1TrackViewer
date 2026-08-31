# F1 Track Studio — Architecture

3D viewer and race simulation for Formula 1 circuits. Next.js, React Three Fiber,
Tailwind.

## Modes

`/` routes on the URL and on the store. No `track` param opens the globe
(`components/globe/`). A `track` opens the viewer (`components/track/f1-track-app`).
`race=1` opens race mode (`components/race/race-app`). Entering or leaving race mode
is a state change that writes the URL, so the store wins after hydration and the URL
wins before it.

## Data flow

```
public/circuits-index.json → useCircuits()        → circuit list, globe markers
        bacinger GeoJSON   → useTrackData()       → centerline coordinates
  public/elevations/<id>   → useTrackData()       → per-vertex elevation
  public/track-markers/<id>→ useTrackData()       → sectors, start/finish, lap length
  public/track-widths/<id> → useTrackData()       → real per-point width
  public/environments/<id> → environment-loader   → terrain, buildings, water, roads
                                    ↓
                              TrackMesh (three/)
```

`TrackMesh` is where the scene is assembled: it builds the centerline curve, the
ribbon, kerbs, apron, painted markings, the start-light gantry, the fleet of cars and
the environment layer, and it drives the race camera.

## The circuit, geometrically

Everything downstream of the centerline reads one curvature profile
(`lib/track/track-curvature`), so nothing can disagree about where a corner is:

- **`lib/track/track-corners`** turns curvature into corner runs, with hysteresis —
  entering a corner takes a 170 m radius, leaving it takes 420 m, because a complex
  like Becketts dips under any single threshold and chops one corner into several.
- **`lib/track/track-kerbs`** lays striped blocks along the inner edge of each run.
- **`lib/track/track-apron`** paves the strip the kerb is bolted to: full width
  through a corner, a verge down a straight, and nothing where a building footprint
  or a hillside says there is no room.
- **`lib/track/racing-line`** offsets the line the cars drive, smoothed forward and
  backward so it eases out and back instead of snapping.
- **`lib/race/speed-profile`** turns radius into a speed limit, then brakes into every
  corner and accelerates out of it.

## Terrain

`lib/env/terrain-sampler` owns the rendered height field: the raw elevation grid with
water flattened, a trench carved along the track, and interpolation across the same
two triangles the terrain mesh builds per cell. The mesh reads its vertex heights back
from the sampler, and everything draped on the terrain — roads, buildings, the track
ribbon — samples through it, so nothing has to guess a clearance that keeps it above a
surface it cannot see.

## The race

`lib/race/race-sim` is pure and deterministic: a fixed `dt`, a seed per circuit, no
allocation per step. Cars follow the racing line at their own pace; a car that catches
another either finds room beside it or queues behind it. Each car keeps a ring of
(distance, time) samples so gaps are timed — how long ago the car ahead stood where
this car stands now — rather than estimated from distance over speed.

`hooks/use-race-simulation` owns the state and hands out two channels: a ref the scene
reads every frame, and a snapshot the HUD re-renders from five times a second. The
stepper runs inside the Canvas, where the frame clock is.

## Elevation smoothing

SRTM data spikes on tight street circuits. `lib/track/elevation`:

1. `normalizeElevationProfile()` — outlier removal plus a local median filter
2. `smoothByTrackDistance()` — weighted averaging along track distance
3. `limitTrackGrade()` — caps slope, four bidirectional passes

In terrain mode the curve's Y comes from the terrain sampler instead, smoothed over a
120 m window so the ribbon does not ripple with every DEM cell.

## Caching

1. Static JSON under `public/` — the normal path
2. localStorage, versioned (`f1tv:elevations:v2:`)
3. Open-Meteo / OpenTopoData at runtime, as a fallback only

## Globe textures

`GlobeLanding` reads Earth maps from `public/textures/earth/` — `earth-day.jpg`,
optionally `earth-clouds.png`, and `earth-night.jpg` for future night-side work.
Equirectangular projection; 2048 or 4096 px wide is the target. A 16k texture slows
the first paint and eats GPU memory for detail nobody sees at globe distance. Never
load them from an external URL at runtime: the assets are local, like everything else
under `public/`.
