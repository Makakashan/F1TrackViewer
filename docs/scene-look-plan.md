# Track look — branch plan (`feat/track-look`)

Settled in a grilling session and the follow-ups after the references came in. This
file is the agreement: what the branch does, what it deliberately does not do, and in
what order. Written so the work can be picked up cold.

**Monaco (`mc-1929`) only. The helicopter camera is the target. The track comes first;
the city waits until the track looks right.**

---

## 1. What the references showed

F1 Manager 2024 screenshots from the user, in `docs/references/f1-manager/`
(git-ignored — another game's frames are not ours to publish). The game does not let
the helicopter pull further out, so there is no wide or harbour frame from it.

- **Helicopter frames — the target:** `Pasted image.png` and `(3)`, `(4)`, `(5)`, `(7)`,
  `(8)`, `(9)`, `(10)`. The camera sits roughly 40–80 m over the track and looks steeply
  down at a corner.
- **Low frames — not a goal:** `(2)` at the car, `(6)` in the tunnel.
- **The city at a distance** has no F1 Manager reference. The Google Maps harbour view
  sent at the start stands in for composition and water colour, not for style.

**What carries those frames is the track corridor, not the city.** By area, most of each
frame is:

1. **Asphalt with texture**, and darker rubber down the racing line.
2. **Barriers with advertising boards**, and **catch fences** above them. From above,
   these are what draw the circuit.
3. **Hard, warm sun shadows** — from trees, lamps, grandstands, cars.
4. **Painted markings** — yellow lines, crossings, hatched run-offs.
5. **The surface around the track** — red brick pavements, grass, kerbstones.
6. **Props** — trees, grandstands with crowds, cranes, marshals, trucks.
7. Buildings, only at the edge of the frame.

Ours today has a bare asphalt ribbon, kerbs and grey ground: no barriers outside the
baked core belt, no boards, no fences, no texture, no shadows. That is the gap.

## 2. What is already known, and must not be re-learned

- **D37 (`docs/city-generation.md`):** nine days of facades, balconies, wall palettes,
  pitched roofs and a modelled-building kit were reverted whole — the city read as
  coloured cardboard, then a punched card, then a heap of components. **Massing was
  rejected by eye too** — "a 2010 mobile game".
- **Why that failed**, which this plan is shaped against: no target frame, detail added
  as geometry and paint, every check going through a bake, no stopping point written
  down in advance.
- **F1 Manager cannot be copied 1:1** — Frontier, Unreal Engine 5, hand-built circuits;
  we are WebGL generated from OSM and lidar at ≤ 15 MB a circuit and ≥ 30 fps on mobile
  (D5). What transfers is the presentation: camera, light, and detail only where the
  camera looks.
- **The track dressing is already runtime.** Ribbon, kerbs (`lib/track/track-kerbs`),
  apron (`lib/track/track-apron`) and markings are built in `track-mesh.tsx` even with a
  baked city — D13 never moved them into the bake. So everything in this plan is HMR,
  not a rebake.
- **Barriers are the exception:** `bakeBarriers` in `scripts/env/bake.ts:2544` builds a
  plain untextured box, 1.05 m tall at half-width + 1.2 m, into the core belt only. With
  `environment=0` there are none.
- **There are no shadows in the scene.** `track-viewer.tsx` sets `shadows={false}`; the
  `castShadow` in `car-fleet.tsx:175` casts nothing.
- **The race camera** (`race-camera-rig.tsx`) follows about 40 m off the car at `fov 50`
  — a chase shot, not a helicopter.

## 3. Where the work is seen

**The track-only scene:** `http://localhost:4000/?track=mc-1929&race=1&elevation=0` with
**City** unticked in the look lab. `environment=0` does not do it: race mode draws a
baked city whatever that parameter says (`race-app.tsx` passes `cityManifest`
unconditionally), so the lab carries its own switch, and it applies to A and B alike.
`elevation=0` lays the track flat, which is what the lab's ground plane needs.

At the end of each step the same thing is opened once with the city
(`environment=1`), for one reason only: to catch a barrier through a building or a
fence through a tunnel mouth. The city's own look is not judged on this branch.

## 4. Locked decisions

| # | Decision |
|---|---|
| **L1** | The target is the F1 Manager helicopter frames. Point-blank views are not a goal. |
| **L2** | The track corridor comes first. The city — tone, the D36 band, water, sky — waits until the track looks right. |
| **L3** | Built and judged in the track-only scene; checked against the city once per step. |
| **L4** | The style of the city stays D37's — no facades, pitched roofs, roof furniture or massing, on this branch or after it. |
| **L5** | Shadows are real: CSM behind `quality`, one map on the performance path. Cars, barriers and fences cast onto the asphalt. |
| **L6** | Textures are generated at runtime on a canvas, the way `studio-stage.tsx` already does it — no image assets in `public/`, nothing to license, nothing to fetch. |
| **L7** | **Barriers move out of the bake into `track-mesh.tsx`**, so the track-only scene and the city draw one and the same barrier. `bakeBarriers` goes, one rebake. |
| **L8** | Everything new along the track is one mesh per kind, built along the centreline the way kerbs are — not one object per panel. Draw calls are counted and reported. |
| **L9** | Terrain is out of scope. |
| **L10** | The user judges, in the live app, with the reference beside it. The agent does not pick camera presets. |
| **L11** | `env:shots` and `scripts/env/shots.ts` are deleted; `env:preview` stays. |
| **L12** | Work in the light theme; the app's default theme does not change. |
| **L13** | **A spike comes first, and a failed spike stops the plan.** |

**Boards are blank:** plain colour blocks, no text and no mark — the user's call. Real
sponsor names are trademarks, and the blocks already say "hoarding" from a helicopter.

## 5. Non-goals

Facades, windows, roof shapes, massing, terrain, point-blank views, the city's look,
props (grandstands, crowds, cranes, marshals, trucks), circuits other than Monaco.
Props are the most expensive item in the reference and the most hand-made; they come
after the track, if at all.

## 6. Phase 1 — the spike (one day, runtime, track-only scene)

1. **Helicopter camera** in race mode — high, steep, a long lens, following the leader.
   The distance and FOV are tuned by the user, starting from frame `(5)`.
2. **Look lab** — a dev-only panel in the pattern of `src/components/admin/*-lab.tsx`:
   sun time, exposure, shadow softness and bias, camera height and FOV, and an **A/B
   switch** between the current scene and the new one on the same frame.
3. **Sun and CSM shadows.**
4. **Asphalt** — a generated tiling texture, and darker rubber along `racing-line`.
5. **Barriers with boards** — an extruded profile along both edges with a board band on
   its face; gaps where the circuit really opens.
6. **Catch fences** — an alpha-tested mesh ribbon on posts above the barrier.

**Decision gate, written now:** if the helicopter frame in the track-only scene is not
clearly closer to frames `(1)`, `(5)` and `(9)` than today's scene — by the user's eye,
with the A/B switch — the plan stops there. Changing direction or stopping is a result,
not a failure. At most a day is lost.

## 7. Phase 2 — only if the spike passes, one commit each

1. **`feat:`** the helicopter camera.
2. **`feat:`** sun and shadows — CSM under `quality`, one map otherwise, cast/receive per
   layer, invalidated with the frame under `frameloop="demand"`. Frame time before and
   after, on the same view.
3. **`feat:`** asphalt texture and rubber line.
4. **`feat:`** barriers with boards in `track-mesh.tsx`.
5. **`fix:`** `bakeBarriers` removed from the bake; Monaco rebaked; triangle and byte delta
   reported.
6. **`feat:`** catch fences.
7. **`feat:`** markings and the surface around the track (yellow lines, crossings,
   pavement and grass tones on the apron) — scoped against the references once 1–6 are
   in.
8. **`chore:`** delete `env:shots` — the script, `package.json`, `docs/project-map.md:50`,
   §4 of `docs/scene-goals.md`, the pointer in `scripts/env/baked-scene.ts:432`.
9. **`docs:`** D38 in `docs/city-generation.md` — why the look is reopened after D37, and
   why the answer is the track corridor, the camera and the light rather than the city.

The look lab stays out of production builds; whether it survives the branch is decided
at the end.

## 8. Parked — the city, after the track

In this order, each its own decision when its turn comes: the D36 shop-front band out of
the bake (`BAND_TONE.ground`, `scripts/env/bake.ts:1707`), a per-building tone spread
decided in the shader from a baked id hash, sky and aerial fog, water.

## 9. How a step is shown

Check port 4000 first (`ss -ltn | grep :4000` — a listener is the user's own server).
Hand over the track-only URL and say what to look at. One or two Playwright screenshots
for the agent's own sanity, never as the verdict. Close any page opened.

## 10. Done means

- `bun run typecheck`, `bun run lint`, `bun run test` clean.
- `bun run race:kerbs` — barriers and fences share the corridor with the kerbs and apron.
- `bun run env:audit mc-1929` after the barrier rebake.
- Draw calls and frame time before and after, on the same view.
- The branch stops and waits. Nothing is pushed or merged without the user's word.
