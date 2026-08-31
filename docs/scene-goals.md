# Scene goals

What the baked city has to be, and how we know it is. `docs/city-generation.md` says
why the pipeline is shaped the way it is; this file says what counts as a good result
and which check decides it.

The rule behind the whole file: **a goal that no check can fail is a wish.** Every
statement here either names the check that fails when it stops being true, or is
marked as an eye judgement and given a fixed camera to be judged from.

---

## 1. The look

Stylised realism, the Apple Maps 2025 Monaco city experience as reference — not a
photograph, not blocks. Concretely, in the order a viewer notices them:

1. **The ground reads as relief.** Slope is visible without paint: a hillside, a
   terrace and a quay are told apart by shape and shading, not by colour coding.
2. **Everything stands on the ground.** No building floats, no building is sunk to
   its windows, no prop hovers. This is the one that has bitten most often and it is
   why §2 exists.
3. **Edges are surveyed, not gridded.** The shoreline follows the mapped line, not a
   staircase of cells. Belt boundaries are invisible.
4. **Detail follows the camera.** Near the track things are built; far from it they
   are silhouettes. The transition is not a line the eye can find.
5. **The frame rate is the budget.** Draw calls and triangles per belt stay inside
   `BELT_BUDGET` (`scripts/env/belts.ts`). Prettier at the cost of a longer frame is
   the wrong trade — AGENTS.md, and it applies here first.

---

## 2. Invariants

Numbered so code and tests can cite them. Each is a property of the **shipped GLB**,
not of an intermediate — the audit that read `buildings.json` while the browser read
`city.glb` is exactly how a floating building passed 18 checks.

| ID | Invariant | Judged by | Status |
|---|---|---|---|
| **I1** | One surface answers "how high is the ground here". The terrain meshes from `ground.ts`; buildings, kit models and props read the triangles the terrain just drew. Nothing samples the raw field to place something on it. | `env:audit` (I2 is its consequence); `ground.test.ts`, which asks the query and the drawn triangle the same question | **held** — placement reads the drawn surface as of the P4.6 bake, and a query lands on the mesher's triangle to the millimetre on synthetic ground |
| **I2** | No building floats. Every piece of the shipped building mesh — walls and the roof resting on them, welded into one — has a vertex within 0.15 m of the terrain triangle beneath it, and no piece is entirely below the ground. | `env:audit` over the GLB | **passing** — 0 floating of 1,259 pieces on Monaco, 0 with nothing above ground; deepest wall dig 36.5 m, reported |
| **I3** | No belt seam opens. Where two belts overlap in plan the terrain is continuous: no gap the sky shows through, no overlap that z-fights. | `env:audit` over the overlap band; `bake.test.ts` over the fixture, where nothing is over the limit; `ground.test.ts` for the grids the conform depends on (belts share an origin, coarse cells are whole multiples of fine ones) | **reported** — 28 of 1,136 shared points apart, mean 0.06 m, worst 0.34 m, down from 583 and 11.68 m. The limit stands at 0.15 m and the count is printed; the residue is parked, not covered |
| **I4** | The track lies on the ground. The baked racing surface matches the height field within `max(0.05 m, 1.2 % of a cell)`. | `env:audit` | passing |
| **I5** | Water is never above land. No water-plane vertex sits higher than the shore vertex it meets. | `env:audit` | passing |
| **I6** | Belts stay inside their budget, in both bytes and triangles, with the kit's share counted. | `env:audit` against `BELT_BUDGET` | passing |
| **I7** | Smoothing keeps the relief. On the 8 m belt: kink ≤ 2.0 m, mean slope within 0.5° of the field's own, and at least 95% of the raw step kept across a surveyed breakline. Kink is the RMS of `2h − h₋ − h₊` over both axes — how far a node sits off the line between its neighbours, which is what aliasing looks like in metres. | three numbers in `env:audit` and in `bake.test.ts` over the fixture; `ground.test.ts` on a cut, a terrace and a ravine | **passing** — kink 1.73 m against the field's own 2.04 m, slope 16.76° against 16.88°, 118% of the step kept over 447 edges of 770 breakline segments |
| **I8** | Land has ground under it. No hole in the terrain where the coastline scalar says land. | `env:audit` | passing |
| **I9** | Nothing floats on the water either. Hulls sit on the datum; no prop hangs below the waterline. | `env:audit` | passing |
| **I10** | Buried track spans are hidden. `cityManifest.track.buried` covers every span the tunnel bore swallows. | `env:audit` | passing |
| **I11** | Vertex colour stays in range. Baked `COLOR_0` never leaves `[0.278, 1]` — the AO floor times the steepest slope shade. Below that is a hole, not a shadow. | `env:audit` | passing |
| **I12** | A bake is reproducible. The same caches in produce the same GLB out, byte for byte. | `bake.test.ts` over the committed fixture | **passing** — the fixture bakes to the same bytes twice |

A failing invariant is the point of having one. I2 reported zero for as long as it
read the height field, while buildings visibly hung in the air; reading the shipped
mesh turned that zero into 269, and one surface turned 269 into none. The order
mattered: the check came first, so the fix had a judge that was not the person who
wrote it.

I7 is the other kind of lesson. It was written expecting an edge-preserving
kernel to be the fix, and the measurement said no such kernel helps: on a DTM
whose own cells already smear a wall over two or three of them, every soft
kernel — bilateral against the raw centre, bilateral against the local mean,
a least-squares plane — lands on one curve, and at equal kink they all keep the
same fraction of the step. What separated a wall from ripple was not a cleverer
average but knowing where the wall is, which OSM already surveyed. The
invariant survived; the plan for meeting it did not.

I2's piece rule is deliberately loose — pieces overlapping in plan and meeting in
height are treated as one building — so a slab hanging beside a tower, at the tower's
own height and inside its plan, is missed. `baked-scene.test.ts` states that miss as
an expectation, so the day the rule tightens the test says so out loud; §4's cameras
are what covers it meanwhile.

---

## 3. How the checks are run

Three layers, cheapest first. All three have to be green before a bake is called done.

- **A — invariant tests on synthetic ground.** `bun run test`: a plane, a 30° slope, a
  vertical cut, a terrace, a narrow ravine, written by hand in `scripts/env/synthetic.ts`
  and read through the same interpolation the bake uses. No network, 40 tests in under
  a tenth of a second. What they hold: the filter reproduces a ramp to the millimetre
  and flattens a surveyed wall by nothing; a placement query answers about the triangle
  the mesher drew rather than the bilinear patch nobody drew; a roof welds to its walls
  and a hanging one does not.
- **B — the fixture.** `scripts/env/fixtures/monaco-harbour`: 200 × 200 DTM nodes and
  the same window of MNH, 116 footprints, 32 shore ways and 9 breaklines, 428 KB
  committed, cut from the caches by `bun run env:fixture`. It goes through `bakeFrom`
  — the pipeline itself, not a copy — in under a second, and the GLB is read back with
  the audit's own reader and judged with the audit's own checks, so a number here and
  a number `env:audit` prints are one measurement. Two mutations show it bites: place
  buildings from the field instead of the drawn surface and I2 reports a floater;
  switch the breaklines off and I7's step check falls under 95%.
- **C — `env:audit` over the shipped GLB.** The full circuit, the real output, the
  numbers in §2.

## 4. The eye, from fixed positions

Some judgements stay visual, and those get a fixed camera so two bakes can be compared
honestly. `bun run env:preview` serves them; `?shot=<name>` writes a PNG to `images/`
(git-ignored).

| Shot | Camera | Watching for |
|---|---|---|
| `harbour` | over the water, looking north-west | quay line, berthed hulls, water meeting the wall |
| `hillside` | from the sea, high, over La Condamine | slope shading, terraces, the smear that started this |
| `ravine` | close, in Sainte-Dévote | buildings standing on steep ground |
| `tunnel-mouth` | at the portal | bore, portal, the buried span |
| `rocher` | from the harbour toward Le Rocher | cliff kept vertical by the filter |
| `seam-core-city` | across a belt boundary | I3 by eye |
| `seam-city-far` | across the outer boundary | the same, at 16 m |
| `overview` | the default wide shot | silhouette, budget, the whole thing at once |

No pixel diff. Every bake moves every vertex a little, so a strict comparison would
fail always and be switched off within a week; the shots are for a person to look at.
