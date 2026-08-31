# Roadmap

The one list of what is next, in the order it is worth doing. Monaco (`mc-1929`) is
the circuit in focus; every other circuit is at the bottom on purpose.

What came before is not here. The P0–P4 phases are in
[`history/city-generation-p0-p4.md`](history/city-generation-p0-p4.md), and the eleven
steps of the ground work — the audit over the shipped GLB, the one ground surface,
the breaklines, the belt seam, the two layers of tests, the fixed cameras — are in
[`history/ground-work.md`](history/ground-work.md). Their decisions live in
[`city-generation.md`](city-generation.md) (D1–D21) and what the result has to hold
lives in [`scene-goals.md`](scene-goals.md).

The order below is by what a person sees, then by what the scene rests on. Anything
whose fix is invisible waits behind something that is not.

---

## 1. What the eye catches now

### 1.1 The light rig

The scene goes black when it is turned round. Look at the city from the north — the
side away from the key light — and the hill reads as an unlit silhouette with a red
patch over Port Hercule. Seen in the app, not the preview, so it is lighting rather
than geometry.

Everything is in `track-viewer.tsx:169–189`: `ambientLight` 0.42, a `hemisphereLight`
whose ground colour is `#07080C` (all but black), a key directional at
`[500, 800, 400]`, a blue fill at `[-400, 300, -500]` 0.5, and the `#E10600` at
`[0, 260, -900]` 0.55 that paints the red patch. Baked AO and slope shading multiply
on top and their floor is 0.278. Which of them is doing it is unmeasured.

One pass over the rig, judged from [`scene-goals.md`](scene-goals.md) §4's cameras
with the scene turned, and `?shading=ao` in the preview to separate what is baked
from what is lit. The red rim light is decided in the same pass: it predates the
bake work and is a style call as much as a bug.

This is first because it is the only thing left that spoils the scene in the app
rather than in a screenshot of it.

### 1.2 The tunnel mouth, properly

Step 11 closed the pit and gave the sleeve an outside, so it is a mouth rather than a
hole with a film over it. It is still a bare concrete ring standing in bare ground.
In the order it shows: no headwall or wing walls, so the ring meets the earth with
nothing between them; the arch is scaled down by the cover above it
(`bakePortals`'s `available / crown`), so on a thin hill it comes out squat; the bore
behind it is black and empty — no road surface, no lining, and the emissive tried in
step 11 made it worse rather than better; and from above the lid over the cutting
reads as a grey plate lying on the slope.

One pass over `bakePortals` and `bakeTunnelBody` in `bake.ts`, judged from the
`tunnel-mouth` shot and from the same camera at the western portal, which the eight
do not cover.

### 1.3 Kit houses, looked at

75 modelled on the current bake, 92,406 triangles, inside budget; 1,976 footprints fit
the shape and 369 had no model at their proportion. The numbers are plausible and
nobody has looked at one. The ground under them is honest now, so a fitting complaint
would be a fitting complaint.

Cheap and worth doing here: it is a camera and an hour, and it decides whether the
modelled-asset direction needs more models or better fitting.

### 1.4 The sea's edge

The far belt's water is one quad over the bbox, so in a wide shot from the north-west
the sky shows past a straight diagonal where it stops
(`images/mc-1929-seam-city-far.png`). Nothing is wrong with the geometry — the bbox
ends — but the eye reads a slab. A skirt, a fog band or simply a larger quad would
answer it; which one is a look decision.

---

## 2. What the scene rests on

### 2.1 P1.2b — the terrain sampler reads the baked field

`src/lib/env/terrain-sampler.ts` still carries its own idea of the ground: a
`Math.max(0, …)` clamp and a flattening where `isWater`. The bake has one surface and
the runtime should read it rather than re-derive it — the same mistake, one layer up,
that steps 3 and 4 spent themselves on.

### 2.2 The info panel's elevation profile

Still reads the old SRTM array. Small, visible in the UI, and on the same thread as
2.1.

### 2.3 Hand overrides for Monaco

The overrides file format and loader exist (D10). What has not happened is Monaco's
own first pass over Le Rocher, Port Hercule and the tunnel run — the corrections that
only a person looking at the city can decide.

### 2.4 Camera distance limits

The polar-angle floor is set; the distance limits are deliberately still open and
want their own pass.

---

## 3. Small, when someone is already in that file

- **The last 0.34 m of the belt seam.** 28 of the 1,136 shared points are more than
  0.15 m apart — mean 0.06 m, worst 0.34 m, all on a boundary node and 23 of them
  exactly on the grid. Invisible; the staircase that started it was metres.
  Quantisation is not the cause (0.045 m at the 64° slope these sit on buys 0.09 m).
  `env:audit` reports it every run. Worth an hour when someone is next inside
  `bake.ts`'s boundary code.
- **P2.1 — roads carry `tunnel`, `bridge`, `layer`** from Overpass into `RoadLine`
  and the building schema.
- **The city belt's triangle count.** 110,850 to 213,627 after the kit and the
  ground-following walls; the budget is 350,000. Worth watching rather than acting on.

---

## 4. Waiting on something outside the repository

- **No pool.** The Stade Nautique and the pitches need one successful Overpass
  answer; the endpoints have been down for days. `OVERPASS_OFFLINE=1` bakes from
  cache meanwhile. The breakline query has also never been verified live — its cache
  was primed by hand.
- **Buoys** from `seamark:*`, once Overpass answers, for honest clutter on the water.
- **Landmarks** — the Casino, the Hôtel de Paris. No CC0 model of either exists, so
  they are parametric or they are nothing.

---

## 5. Low priority — the other circuits

**P4.4 — migrate the remaining circuits**, then delete `environment-layer.tsx` and
the old JSON runtime path. This is D17's termination condition: two paths that both
rot is the thing the migration exists to end.

It carries one known bug with it. Seen from above, some houses in the app show no
roof — you look into the shell — and from an angle only one wall reads. Measured over
the shipped Monaco GLB: 0 pieces of 1,213 in the building meshes and 0 of 67 kit
models lack an up-facing face, so the geometry that ships has its roofs. The suspect
is the old path, which extrudes a footprint without capping it. One step to confirm:
which circuit the screenshot was taken on. If it is not `mc-1929`, this is the bug
and P4.4 is its fix.
