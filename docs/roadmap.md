# Roadmap

The one list of what is next. It replaced two: the "Open work" tail of
`project-map.md` and the unticked boxes in the P0–P4 plan, which had drifted apart.

Monaco (`mc-1929`) is the only circuit in focus until the ground work below lands.

Why this order: **the judge comes first.** Steps 2 and 3 change how every object
meets the ground, and without a check that reads the shipped GLB we would be
comparing screenshots again. Each step is its own commit and is verifiable on its
own.

**Where it stands (2026-08-31).** Steps 1–6 are in. `env:audit mc-1929` is green on
every check, and the ground now has one definition, one judge and three numbers
saying the filter neither aliases nor flattens. What is left of the original
complaint is a matter for the eye, which is step 9.

---

## Now — the ground work

### 1. Tidy `docs/` — **done**

Decisions, journal, goals and roadmap in four files instead of one 1,466-line
document. No code touched.

### 2. The audit reads the GLB — **done**

`scripts/audit-environment.ts` loads `core.glb`, `city.glb`, `far.glb` and checks the
geometry that ships, instead of `buildings.json` plus the height field.

The floating check (**I2**) became real: each piece's lowest vertex against the
terrain triangle beneath it. The version it replaced compared a footprint's own
minimum against its own maximum — `base > highest + 0.15` where `base = min(heights)`
and `highest = max(heights)` — which cannot be true, so it had reported zero on every
run while a building visibly floated. Reading the shipped mesh turned that zero into
269, which is what the step was for. The model-foot check had the same shape of fault:
it looked for a mesh named `model`, which no belt ships.

### 3. `scripts/env/ground.ts` — **done**

One surface per belt, built from the same nodes the mesh emits, plus a box-filtered
pyramid of the height field so the 8 m and 16 m belts *average* the field instead of
point-sampling it. `groundAt(x, z, belt)` answers by barycentric interpolation inside
the triangle — literally what the camera sees. The raw field moves behind this module.

Measured reason it is needed: the field's high-frequency content has an RMS of
0.93 m at a 3.9 m cell, and point sampling it at 8 m gives a kink RMS of 3.76 m
between neighbouring faces (7.70 m at 16 m). Box-averaging the same nodes drops that
to 2.55 m and 4.97 m while mean slope moves 16.6° → 16.3°. The noise goes, the relief
stays.

### 4. Placement moves onto the drawn ground — **done**

`prepareBuildings`, the kit pass, props, grandstands, cranes. `MAX_UNDERCUT_M`
(`bake.ts`) is deleted rather than tuned: it exists to paper over a disagreement
between two readings of the ground, and after step 3 there is only one reading.
Rebake Monaco; step 2's floating count has to come back zero (**I1**, **I2**). It
does: 0 floating of 1,259 pieces, and the whole audit is green.

Placement reads the *drawn* terrain — the triangles the mesher has just emitted —
rather than `ground.ts`'s node table, because the coast is cut inside a cell, a seam
node is conformed to the coarser belt's chord and a vertex is clamped to the surface
band, all after the nodes are read. Two derivations of one surface is how a building
ends up in the air; this leaves one.

Walls also gained vertices where the ground under an edge strays from the line
between its corners, which is what a footprint bridging a gully needs.

### 5. The filter stops at surveyed lines — **done**

Step 3's box filter is the right shape of fix and it has one blind spot: it cannot
tell a 6 m quay wall from a metre of ripple, so it softens both. Measured on the
city belt, it keeps 85% of the step across a surveyed cliff or retaining wall — a
10 m drop arrives a metre and a half short on each side.

The plan was an edge-preserving kernel. **It was measured first and it does not
work.** Bilateral weighted against the raw centre keeps the centre's own noise and
filters nothing (kink 2.36 m, the same as no filter at all). Weighted against the
local mean it lands on the box filter's own noise-against-edges curve: on the far
belt, `box r2` gives kink 2.89 m and keeps 85% of the step, `guided r3 t4` gives
2.86 m and keeps 85% — the same point, reached the long way. A least-squares plane
read at the centre of a symmetric window *is* the mean, and measures as it. The
reason is in the data: the IGN DTM smears a wall over two or three of its own
3.9 m cells, and the filter window is two or three cells wide, so there is no
height gap left for a range weight to find.

What works is knowing where the wall is. `scripts/env/breaklines.ts` indexes the
lines OSM surveyed — `natural=cliff` and `barrier=retaining_wall` from their own
query, quays and breakwaters out of the shore layer already cached — and
`windowMean` refuses to average across one. Each side of a wall is then averaged
against itself. On the shipped bake the step comes back to 118% of what the raw
field shows — past 100%, because the raster smeared the wall in the first place —
the mean slope holds at 16.76° against the field's own 16.88°, and the kink is
1.73 m against the field's 2.04 m. All three are `env:audit` checks now.

Cost is nothing away from a wall: the summed-area tables still answer in four
lookups, and only a window with a line running through it is walked node by node.

**I7** now has three numbers in `env:audit` rather than a plan, and its ceiling
was set from the point-sampled and box-filtered measurements before the breaklines
were built.

### 6. The belt seam gets a judge, then a fix — **done**

**I3** had been `planned` since it was written, and a seam that no check measures is
a seam nobody sees a number for. The check exists now and fails: **583 of 1,136
points the two belts share are more than 0.15 m apart, mean 0.41 m, worst 11.68 m.**
It shows on screen as a staircase along the boundary with the background through it.

Both numbers had to be measured twice. The first attempt compared vertex against
vertex and reported 2,432 points over 2 m — nearly all of them the feet of the
skirts a belt hems its edge with, which nobody can see. Measuring surface against
surface, with the skirts dropped from both, gives the real figure.

The cause is in `bake.ts`'s `surfaceHeightAt`. A belt boundary is a T-junction, and
the fine side is meant to give up its own readings and take the coarse side's chord.
It takes a chord — but between **its own** heights at the coarse lattice nodes, and
since step 3 those are filtered with a narrower window than the coarse belt's own.
Two chords between the same two places, drawn from different numbers. Step 5 widened
the gap further where a surveyed wall runs along a seam and only one belt breaks at
it: worst 7.22 m before, 11.68 m after.

The fix, in three parts, each of which the judge scored on its own:

1. The chord reads the coarse belt's nodes rather than the fine belt's own
   (`drawnHeightOn` in `bake.ts`): **583 → 210 apart**, worst 11.68 → 6.89 m.
2. A block **corner** takes the coarse belt's node outright. It used to keep its
   own height on the grounds that it is a node of both lattices — true, and both
   lattices give it a different height: **210 → 29**, worst 6.89 → 0.34 m.
3. A belt asks its neighbour what it *draws*, not what it reads, so a node where
   three belts meet resolves through the coarsest: **29 → 28**. Small, and it is
   the part that makes the rule true rather than true on Monaco.

A residue of 28 points remains, mean 0.06 m and worst 0.34 m, and it is parked at
the end of this file rather than chased here. The limit was **not** loosened to
cover it — the check keeps the same 0.15 m and keeps printing the count; it is
reported rather than fatal, so the number stays in front of whoever runs the audit
without failing every unrelated bake.

### 7. Tests A — invariants on synthetic ground — **next**

There is no test runner in the repository yet, so this step installs one. A plane, a
30° slope, a vertical cut, a terrace, a ravine; the invariants of
[`scene-goals.md`](scene-goals.md); no network; milliseconds.

Two of them are already owed. **I1**: a placement query and the triangle it names
have to agree to a millimetre — held today by construction, untested. **I2's piece
rule**: pieces that overlap in plan and meet in height are welded into one building,
which is loose enough to miss a slab hanging beside a tower at the tower's own
height. A synthetic scene is the only cheap way to pin either.

### 8. Test B — the Monaco fixture

A committed slice: ~200 × 200 field nodes (~160 KB) and about fifty footprints, run
through the real pipeline in seconds. Catches what only real data expresses.

### 9. The fixed shots

The eight cameras in [`scene-goals.md`](scene-goals.md) §4, snapped after a bake via
`env:preview`'s `?shot=` and looked at by a person. No pixel diff.

---

## Parked — Monaco, after the ground work

- **Kit houses have never been looked at.** 75 modelled on the current bake, 92,406
  triangles, inside budget; 1,976 footprints fit the shape and 369 had no model at
  their proportion. The numbers are plausible and nobody has looked at one. The
  ground under them is honest now, so a fitting complaint would be a fitting
  complaint.
- **The city belt nearly doubled** — 110,850 to 213,627 triangles — from the kit's
  houses and the vertices walls take to follow the ground. The budget is 350,000 and
  the belt is at 61% of it. Worth watching rather than acting on.
- **No pool.** The Stade Nautique and the pitches need one successful Overpass answer;
  all three endpoints have been down for days. `OVERPASS_OFFLINE=1` bakes from cache
  meanwhile.
- **The scene goes black when it is turned round.** Rotate to look at the city from
  the north — the side away from the key light — and the hill reads as an unlit
  silhouette with a red patch over Port Hercule. Seen in the app, not the preview,
  so it is lighting rather than geometry. The lights are all in
  `track-viewer.tsx:169–189`: `ambientLight` 0.42, a `hemisphereLight` whose ground
  colour is `#07080C` (all but black), a key directional at `[500, 800, 400]`, a blue
  fill at `[-400, 300, -500]` 0.5, and the `#E10600` at `[0, 260, -900]` 0.55 that
  paints the red patch. Baked AO and slope shading multiply on top, and their floor
  is 0.278. Which of those is doing it is unmeasured; the fix is one pass over the
  rig, judged from `scene-goals.md` §4's cameras with the scene turned.
- **The red rim light.** The `#E10600` directional above. Predates the bake work; a
  style call as much as a bug, and probably answered by the same pass. Decide whether
  it stays.
- **Landmarks** — the Casino, the Hôtel de Paris — built parametrically. No CC0 model
  of either exists.
- **Buoys** from `seamark:*`, once Overpass answers, for honest clutter on the water.
- **The last 0.34 m of the belt seam.** After step 6, 28 of the 1,136 points two
  belts share are still more than 0.15 m apart — mean 0.06 m, worst 0.34 m, all on a
  boundary node and 23 of them exactly on the grid. Invisible: the staircase that
  started this was metres. The cause is not identified, and quantisation is not it
  (0.045 m horizontally at the 64° slope these sit on buys 0.09 m). `env:audit`
  reports it on every run. Worth an hour when someone is next inside `bake.ts`'s
  boundary code, not a task of its own.
- **Hand overrides** (was P2.4, P2.5): the overrides file format and loader (D10), then
  Monaco's first pass over Le Rocher, Port Hercule and the tunnel run.

## Parked — beyond Monaco

- **P4.4 — migrate the remaining circuits**, then delete `environment-layer.tsx` and
  the old JSON runtime path. This is D17's termination condition: two paths that both
  rot is the thing the migration exists to end. Deprioritised while the focus is
  Monaco.
- **P1.2b — rewrite `src/lib/env/terrain-sampler.ts`** as a reader over the baked
  field; delete the `Math.max(0, …)` clamp and the `isWater` flattening.
- **P2.1 — roads carry `tunnel`, `bridge`, `layer`** from Overpass into `RoadLine` and
  the building schema.
- **Camera distance limits.** The polar-angle floor is set; the distance limits are
  deliberately still open, and want their own pass.
- **The info panel's elevation profile** still reads the old SRTM array.
