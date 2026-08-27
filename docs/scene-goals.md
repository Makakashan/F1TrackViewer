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
| **I1** | One surface answers "how high is the ground here". Terrain meshes, buildings, kit models and props all read `groundAt(x, z, belt)`; nothing samples the raw height field to place something on it. | `ground.test.ts` — a placement query and the meshed triangle agree to 1 mm | planned |
| **I2** | No building floats. Every wall's lowest vertex sits within 0.15 m above the terrain triangle beneath it, and no more than 1.5 m below it. | `env:audit` over the GLB | **broken today** — the current check compares a set's own min against its own max and can never fail |
| **I3** | No belt seam opens. Along a boundary between two belts the terrain is continuous: no gap the sky shows through, no overlap that z-fights. | `terrain.test.ts` on a synthetic slope crossing a seam | planned |
| **I4** | The track lies on the ground. The baked racing surface matches the height field within `max(0.05 m, 1.2 % of a cell)`. | `env:audit` | passing |
| **I5** | Water is never above land. No water-plane vertex sits higher than the shore vertex it meets. | `env:audit` | passing |
| **I6** | Belts stay inside their budget, in both bytes and triangles, with the kit's share counted. | `env:audit` against `BELT_BUDGET` | passing |
| **I7** | Smoothing keeps the relief. After the edge-preserving filter: kink RMS at the 8 m belt ≤ 2.6 m (3.76 m unfiltered), mean slope within 0.5° of the unfiltered 16.6°, and the step across any mapped quay or retaining wall within 0.3 m of the raw field. | `terrain-filter.test.ts` plus three numbers in `env:audit` | planned |
| **I8** | Land has ground under it. No hole in the terrain where the coastline scalar says land. | `env:audit` | passing |
| **I9** | Nothing floats on the water either. Hulls sit on the datum; no prop hangs below the waterline. | `env:audit` | passing |
| **I10** | Buried track spans are hidden. `cityManifest.track.buried` covers every span the tunnel bore swallows. | `env:audit` | passing |
| **I11** | Vertex colour stays in range. Baked `COLOR_0` never leaves `[0.278, 1]` — the AO floor times the steepest slope shade. Below that is a hole, not a shadow. | `env:audit` | passing |
| **I12** | A bake is reproducible. The same caches in produce the same GLB out, byte for byte. | `bake.test.ts` over the committed fixture | planned |

"Broken today" is not a slur on the check — it is the reason the audit moves to the
GLB before anything else is fixed. A judge that reads different evidence than the
viewer is worse than no judge, because it reports confidence.

---

## 3. How the checks are run

Three layers, cheapest first. All three have to be green before a bake is called done.

- **A — invariant tests on synthetic ground.** A plane, a 30° slope, a vertical cut, a
  terrace, a narrow ravine. No network, milliseconds, run on every change. These catch
  the whole class of joint bugs: a wall that stops short of the ground, a seam that
  opens, a skirt that hangs.
- **B — the fixture.** A committed slice of Monaco — roughly 200 × 200 field nodes and
  fifty footprints — run through the real pipeline in seconds. Catches regressions that
  only real data expresses.
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
