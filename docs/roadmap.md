# Roadmap

The one list of what is next. It replaced two: the "Open work" tail of
`project-map.md` and the unticked boxes in the P0–P4 plan, which had drifted apart.

Monaco (`mc-1929`) is the only circuit in focus until the ground work below lands.

Why this order: **the judge comes first.** Steps 2 and 3 change how every object
meets the ground, and without a check that reads the shipped GLB we would be
comparing screenshots again. Each step is its own commit and is verifiable on its
own.

**Where it stands (2026-08-31).** Steps 1–11 are in. `env:audit mc-1929` is green on
every check, the ground has one definition, one judge and three numbers saying the
filter neither aliases nor flattens, and `bun run test` holds those properties on
ground small enough to check by hand and over a committed slice of the real thing. What is left of the original complaint is a
matter for the eye, which is step 9.

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

### 7. Tests A — invariants on synthetic ground — **done**

`bun run test`: 40 tests over three files, 0.1 s, no network.

No runner was installed. The step was written expecting to add one, and Bun ships
`bun test` — same expect API, zero dependencies — so the work went into the ground
the tests stand on instead. `scripts/env/synthetic.ts` writes a field by hand and
hands it to `heightFieldFrom`, a factory split out of `buildHeightField` so a test
reads heights through the same interpolation the bake does. Nothing in a test
reimplements what it checks.

What they hold:

- **A plane and a 30° slope.** Every belt reads the plane exactly, and a box filter
  of a ramp is the ramp — nodes on it to the millimetre, gradient to six places.
  The filter flattens nothing by itself.
- **A vertical cut** (I7). Left alone, a 16 m window brings a 10 m wall in at under
  90% of its step; with the wall surveyed, at 100%. Both directions are asserted, so
  the breakline path cannot quietly stop working and leave a green suite.
- **A terrace and a ravine.** Every node keeps the level it stands on; a ravine
  narrower than the window is filled in without banks and kept to the centimetre
  with them, including the case `ground.ts` describes where a node is fenced on all
  four sides and its own raw sample is the only answer left.
- **Ripple** (I7 again). Deterministic noise on the slope: the filtered belt kinks
  less than half as much as the same relief point-sampled, and the mean gradient
  survives.
- **I1**, the debt this step was for. The belt is meshed the way the mesher meshes
  it, indexed with the shipped `buildSurfaceIndex`, and every query agrees with the
  triangle to the millimetre — with a third test proving the teeth, since a bilinear
  answer differs on any cell with a twist.
- **I2's piece rule.** A roof sharing no vertex with its walls welds to them; a roof
  hanging 3 m above them does not; and a slab inside a tower's plan at the tower's
  own height welds — the documented miss, now stated as an expectation rather than
  as a sentence in a doc.

Two mutations were run to check the suite is not decorative: making `at()` read the
wrong triangle fails I1, and disabling the breakline path fails five tests.

### 8. Test B — the Monaco fixture — **done**

`scripts/env/fixtures/monaco-harbour`, 428 KB committed: 200 × 200 DTM nodes over
Port Hercule and the same window of MNH, with the ways that fall inside it — 116
footprints, 46 structures, 32 shore ways, 9 breaklines, 130 green ways. Cut from the
caches by `bun run env:fixture`, read back by `loadFixture`, baked in 0.5 s.

It goes through the pipeline rather than past it. `bakeCircuit` was a fetch and a
pipeline in one function, so nothing could run over data that had not come off the
network; it is now `loadBakeInputs` — every read, in one place — and `bakeFrom`,
which takes them and bakes, with an out directory a caller may point at a temp dir.
Monaco rebakes byte for byte identical after the split, which is what says the
refactor changed nothing.

The judging is the audit's own: `checkStanding`, `checkSeams` and `checkRelief` are
exported and called from the test over the GLB the fixture just wrote, so a number
here and a number `env:audit` prints are one measurement rather than two opinions.
What the window holds: no floater of 38 pieces, deepest wall dig 22 m; 172 shared
seam points, worst 0.05 m, none over the 0.15 m limit; kink 1.46 m against the
field's 2.00 m, slope 10.30° against 10.51°, 110% of the step kept over 14 edges;
`COLOR_0` never below the 0.45 AO floor; and the same inputs write the same GLB
bytes twice, which is **I12** turned from planned into passing.

Two mutations, to show it bites: place buildings from the height field instead of
the drawn surface — the bug this whole document exists for — and I2 reports a
floater; switch the breakline path off and I7's step check falls under 95%.

The centreline stays whole in the fixture rather than being cropped: the corridor is
a closed loop, and half a loop would close itself across the window and lay a road
through it. Two things the window does not cover, and they are named in the test
file: the city/far boundary, because it sits inside 600 m of the centreline and the
far belt ships only water there, and the asset kit, which is left empty so a
checkout without `bun run assets:fetch` gets the same answer as one with it.

### 9. The fixed shots — **done**

`bun run env:shots` — the eight cameras of [`scene-goals.md`](scene-goals.md) §4 as
data in `scripts/env/shots.ts`, taken by headless Chromium over the preview page and
written to `images/<circuitId>-<shot>.png`. It borrows a preview server if one is
already up and starts its own if not. No pixel diff: every bake moves every vertex,
so the frames are for a person.

`?shot=` already wrote a PNG; what was missing was the eight cameras. Three of them
are placed from the geometry rather than by eye — the tunnel shot stands off the
bore's own end, and the ravine and both seam shots sit on the steepest ground their
boundary crosses, found by walking the drawn surface. The rest were framed by taking
the frame and looking at it, which took three rounds.

**What the eight show.** The complaint that started all of this is answered: the
hillside reads as terraces and streets rather than as a smear, Le Rocher's face
stands vertical out of the water, the quay line is a wall with hulls against it, the
portal is a mouth in a cutting. Neither belt boundary shows a tear at any angle
tried. Two things worth writing down came out of looking, and both are parked below
rather than fixed here: the sea is a slab with an edge, and the bore is unlit.

### 10. Terrain reads as rock — **done**

Looking at step 9's frames is what found this: Le Rocher came out as poured wax and
the buildings on it looked pressed into dough. Measured before it was believed — the
drawn surface follows the DTM within a metre across the rim, the buildings there dig
1.8 m at the median, and 79 OSM footprints are 15 pieces because terraces sharing a
wall weld into one. Nothing was misplaced. What was wrong was that every terrain
vertex carried one averaged normal, so a cliff edge shaded as a curve.

`GridMesh.finish(creaseDeg)` now splits a corner whose faces disagree by more than
15° (D20). The angle was settled by looking: at 25° the rock still read as drapery,
at 10° nothing visibly improved over 15° and the core belt cost another 0.07 MB. Nothing moves and no triangle is added — only how many normals a corner
may have. Monaco: 5.90 MB to 6.16 MB, triangle counts identical, every audit number
unchanged. `mesh.test.ts` holds the two halves of it: a flat sheet keeps one vertex
per node at any crease angle, and a 90° fold gets a flat side and a steep side that
each keep their own normal.

### 11. The tunnel mouth is a mouth — **done**

The other thing step 9's frames found. The mouth was a ragged hole with daylight
showing through the hill either side of the arch, and the bore behind it was pure
black.

Rendered one mesh at a time — `env:preview` takes `?only=terrain,portal` now — which
is what settled it: the terrain's hole was wider than everything built to close it.
A cell is dropped when its *centre* falls in the void, so the rim runs up to half a
cell past the nominal width and follows the belt's own lattice, while the closure was
a rectangle sized from the void's numbers. Two metres of open pit each side, and the
sky behind it.

The pit is now walled along its own rim: every edge where a dropped cell meets a
built one gets a vertical quad, from the ground the built side draws down to the
cutting's floor (D21). It cannot be short and there is nothing to keep in step with.
The old side walls, which stood at a guessed ±12 m and were mostly inside the hill,
came out — checked by rebaking without them and looking, not by reading. Cost: 48
triangles on the core belt, 1.12 MB unchanged to two decimals.

The mouth then read as a film rather than a hole, because every face of the sleeve
pointed inward: from outside the camera looked straight through the near wall at the
lit far one. `?sides=double` in the preview is what settled that — the arch came back
solid the moment culling was off. The tube now carries a second skin 0.8 m out, wound
the other way and joined by an annulus at the front, so what stands in the cutting is
a length of concrete with a dark hole in it. A dim emissive on the bore was tried
first for the same complaint and taken out: on a near-black base it came out olive
and made the film worse.

---

## Parked — Monaco, after the ground work

- **The sea has an edge.** The far belt's water is one quad over the bbox, so in a
  wide shot from the north-west the sky shows past a straight diagonal where it
  stops (`images/mc-1929-seam-city-far.png`). Nothing is wrong with the geometry —
  the bbox ends — but the eye reads a slab. A skirt, a fog band or simply a larger
  quad would answer it; which one is a look decision.

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
