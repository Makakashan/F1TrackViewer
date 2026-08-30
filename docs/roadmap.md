# Roadmap

The one list of what is next. It replaced two: the "Open work" tail of
`project-map.md` and the unticked boxes in the P0–P4 plan, which had drifted apart.

Monaco (`mc-1929`) is the only circuit in focus until the ground work below lands.

Why this order: **the judge comes first.** Steps 2 and 3 change how every object
meets the ground, and without a check that reads the shipped GLB we would be
comparing screenshots again. Each step is its own commit and is verifiable on its
own.

**Where it stands (2026-08-30).** Steps 1–4 are in. `env:audit mc-1929` is green on
every check: 0 floating of 1,259 pieces, terrain within 0.40 m of the surface it
meshes, 5.90 MB over three belts, all inside budget. What is left of the original
complaint is the look of the hillside, which is step 5.

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

### 5. The edge-preserving filter — **next**

Step 3 landed a box filter, which is the right shape of fix and the wrong kernel: it
cannot tell a 6 m quay wall from a metre of ripple, so it softens both. On the
hillside shots the ravine's edge now reads blurred rather than sooty. That is the
trade the box filter makes, and it is why this step exists.

Bilateral over the field — spatial radius ~2 cells, height threshold ~1.5 m — so a
mapped quay's 3–8 m step survives untouched and the ±1 m ripple does not. It replaces
the kernel inside `windowMean` (`scripts/env/ground.ts`); nothing outside that
function has to know.

Acceptance is **I7**'s three numbers, fixed before the change rather than after it:
kink RMS at the 8 m belt ≤ 2.6 m, mean slope within 0.5° of 16.6°, and the step across
any mapped quay or retaining wall within 0.3 m of the raw field. The third needs the
second layer — `natural=cliff`, `barrier=retaining_wall`, `man_made=quay` and the
coastline as lines the filter may not cross — which needs Overpass to answer.

### 6. Tests A — invariants on synthetic ground

There is no test runner in the repository yet, so this step installs one. A plane, a
30° slope, a vertical cut, a terrace, a ravine; the invariants of
[`scene-goals.md`](scene-goals.md); no network; milliseconds.

Two of them are already owed. **I1**: a placement query and the triangle it names
have to agree to a millimetre — held today by construction, untested. **I2's piece
rule**: pieces that overlap in plan and meet in height are welded into one building,
which is loose enough to miss a slab hanging beside a tower at the tower's own
height. A synthetic scene is the only cheap way to pin either.

### 7. Test B — the Monaco fixture

A committed slice: ~200 × 200 field nodes (~160 KB) and about fifty footprints, run
through the real pipeline in seconds. Catches what only real data expresses.

### 8. The fixed shots

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
- **The red rim light.** `track-viewer.tsx:186` throws a `#E10600` directional at 0.55
  from behind the scene, pinking whatever faces away from the camera. Predates the
  bake work; a style call, not a bug. Decide whether it stays.
- **Landmarks** — the Casino, the Hôtel de Paris — built parametrically. No CC0 model
  of either exists.
- **Buoys** from `seamark:*`, once Overpass answers, for honest clutter on the water.
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
