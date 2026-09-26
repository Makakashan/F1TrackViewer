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
- **`lib/track/track-reach-limit`** says how far anything may reach from the centreline
  on each side: inside a bend before its edge folds back, and toward another leg of the
  lap before it lands on that leg. The ribbon, apron, kerbs and barrier all stay inside
  it, and it eases in rather than stepping. `bun run race:kerbs` counts folds, barriers
  on another leg, and the steepest step of an edge.

## Hand corrections

`src/data/track-overrides/<circuitId>.json` holds corrections placed along the lap:
road width, barrier distance from the road edge, and kerb width, per side. A point holds
its values over a stretch and fades back to the automatic ones over 15 m
(`lib/track/track-overrides`). They ship in every build.

They are made with the track editor, a local tool: `/admin` → Track editor under
`bun run dev`, which opens race view with `edit=1`. Save writes the JSON and its
`index.ts` through `src/app/api/track-overrides/[id]/route.dev.ts`; `next.config`
only lists `dev.ts` as a page extension for the dev server, so no deployed build has an
endpoint that writes files.

The race ribbon's paving reaches at most ~1.6 m past the viewed edge on Monaco and its
one centreline smoothing moves decimetres; the bake burns 4 m of flat verge past its
own edge from the unsmoothed centreline, so the race paving still lands on flat ground
and the bake carries no overrides.

## Terrain

Where a city is baked, the ground is the bake's: the belts carry it as geometry and
`city-manifest.json` carries the track's own profile along it, which is what the
ribbon and the info panel both read. `lib/env/terrain-sampler` serves the older
path — the one `environment-layer` draws — and owns its rendered height field: the raw
elevation grid with water flattened, a trench carved along the track, and interpolation across the same
two triangles the terrain mesh builds per cell. The mesh reads its vertex heights back
from the sampler, and everything draped on the terrain — roads, buildings, the track
ribbon — samples through it, so nothing has to guess a clearance that keeps it above a
surface it cannot see.

The baked ground's light is one function of place, whichever belt draws it. Its
normal is the area-weighted normal of the drawn faces around a place, summed over every
belt so both sides of a seam agree, then averaged with its neighbours' three times
(`smoothLight`); faces steeper than about 72° (steps, skirts) and faces under the sea
plane do not count. Read off a filtered copy of the ground instead, the light disagreed
with the faces it fell on and a cliff came out a chequerboard. Its shade comes from one
lattice (`buildGroundShade`: sky, slope, blur in metres) that every belt reads by
position. Within a cell of a retaining wall the 15° crease stays (`TERRAIN_CREASE_DEG`),
which keeps a built step sharp; a cliff is the ground itself and shades as it does. A
plain cell splits across whichever diagonal joins its two closer corners
(`splitsOnMain`), so a ridge at forty-five degrees to the grid is drawn as a ridge and
not as a saw; `Ground.at` reads the same triangle. Water with land within two core cells on both sides is filled as land: narrower
than the grid can draw, it came out as a slot the height of the cliff around it.
`env:audit` holds each belt to 1% of gentle-ground edges — under 25° over 20 m — where
the light still breaks; on steeper ground a turn that sharp can be the relief.

Two belts meet at a hairline, and the skirt that hides the gap is lit as the ground it
hangs from; lit as a wall, it drew every seam as a line. The belts ship in separate
files, and `meshopt` quantises each mesh on its own box: two belts snapped one seam
vertex to lattices up to 0.23 m apart, and from above the sea showed through a skirt
seen edge-on. The terrain and the plinth are quantised on one shared box instead. A coast raised to the core puts
a ring of city between itself and the far belt, so the cell never jumps more than twice.

The ground does not end at the sea: past the shoreline it carries on as a seabed falling
away by its distance from the shore, so there is no edge to fall through. Cut at the
shoreline instead, the ground had an edge, and every skirt that hung from it missed a jog
somewhere — the sea showed through slits under the cliffs, and a capped cliff stood as a
row of shards over its own hem. A cell the shoreline crosses is drawn as its land side,
a step down at the line — from at most a quay's lip (3 m) to under the plane — and its
seabed side, at vertices both neighbours share, so the waterline is the shore's line
rather than the grid's. Without the step the sea met a slope across the cell wherever it
happened to, half a metre to two off every quay wall. The step is the quay's wall too:
the separate walls `shore.ts` stood along OSM's line came out as slabs a few metres off
the ground's own edge, and are gone.
Left to the grid, the crossing followed whichever node stood taller: a staircase along
every cliff, and a saw along every quay when a single slope was tried instead. Ground
under the sea plane is the seabed to `env:audit`, as the missing ground was before, and
nothing is built or planted on it: a park by the water put its trees ten metres down.
Seabed that lies wholly two metres under the plane is not drawn: the sea is opaque.

`Ground` holds every pair of neighbouring nodes to `MAX_SLOPE_DEG` (55°) after its
smoothing: the excess is shared between the two and spreads over a few cells, and only
the road holds. The DTM drops a cliff in one cell where it can, and a face that sheer
and a cell wide drew as a shard however it was lit; at 70° the city belt's 8 m cells
still stood 22 m apart and the brow over Fontvieille kept its teeth. A built wall is let
through — one taller than the limit allows in a cell is a cliff's brow, not a street's.
The limit moves one pair of nodes at a time along the axes and leaves a crumple of its
own on a face, so the ground is smoothed and limited again `SETTLE_ROUNDS` times after.
Before that, the ground is held under the lip plus the same slope off the shoreline
(`shoreCeiling`), or a cliff a metre from the water drew a sliver from its brow down to
it. The distance is measured to where the mesh cuts the line, between two nodes either
side of it (`distanceToShore`), not read off the land scalar: that jumps where the line
hands over to the raster, and under Le Rocher a node it put 11 m inland stood 2 m from
the lip with a 16 m wall over it. The town's street levels stay under the ceiling too.
The ground and its mesh read the shoreline from one function (`buildLandAt`), and a
node the line calls land but the raster sea, which borrows its neighbours' height, is
held under the same ceiling (`Ground.ceilingAt`). A scrap of land the sea rings, smaller
than a filled hole, is drawn as sea: it is the line and the raster disagreeing off a quay.

The road is burned into the field before anything is meshed: flat to its half width
and a verge of one terrain cell (`DEFAULT_VERGE_M`, 4 m), then eased back to the ground.
The verge stops at a surveyed line — a retaining wall beside the road keeps its step —
and where two legs of the lap run within reach of each other the lower road keeps the
verge between them, so the step is a wall past its kerb rather than a slope across it.
The ground keeps the burned road as it is (`roadLevel`): neither the belts' filter nor the
town's street levels (`streets.ts`, silent within 8 m of the centreline) move it. Under
the ribbon itself a node is held at the road's level even where the field was not burned
that wide; outside a tunnel only, or the hill over the bore would be cut down to it. A
cutting's bank left there came up through the tarmac by the tunnel's mouth. Where
a wall stands within a cell of the ribbon's edge the 4 m mesh still ramps over it; that
needs the wall drawn as a face, which the terrain does not do yet.

The core belt is a grid, but not where the ribbon runs through it. The ribbon's edges,
built by the same code the viewer draws with (`ribbon.ts`), are edges of the mesh: the
cells they cross are triangulated together with them as constraints (`cdt2d`), and a
grid node within 1.2 m of an edge is left out. `env:audit` holds the ground under the
ribbon.

## Buildings

A footprint extruded whole on Monaco's slopes is a blind plinth downhill and a burial
uphill, so a piece still spanning 4 m of ground is split along its fall line (up to
sixteen terraces), and each terrace stands on its own middle with its walls run down to
the ground under each vertex. A wall runs along a contour, so the same cut puts a
wall-crossing footprint's halves on their own sides of it. Heights are measured off the
MNH surface model where one exists — the Odeon bakes at 169 m against 170 real, the
Millefiori at 111 against 111, the Mirabeau at 81 against 81 — and the OSM tags are the
fallback. A footprint with no ground under it at all is dropped, unless its centre sits
on a pontoon deck, whose height is its ground. `env:audit` holds every piece off the
air and counts footprints crossing a retaining wall.

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
