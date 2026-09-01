# Roadmap

The one list of what is next, in the order it is worth doing. Monaco (`mc-1929`) is
the circuit in focus; every other circuit is at the bottom on purpose.

What came before is not here. The P0–P4 phases are in
[`history/city-generation-p0-p4.md`](history/city-generation-p0-p4.md), and the twelve
steps of the ground work — the audit over the shipped GLB, the one ground surface,
the breaklines, the belt seam, the two layers of tests, the fixed cameras — are in
[`history/ground-work.md`](history/ground-work.md). Their decisions live in
[`city-generation.md`](city-generation.md) (D1–D21) and what the result has to hold
lives in [`scene-goals.md`](scene-goals.md).

The order below is by what a person sees, then by what the scene rests on. Anything
whose fix is invisible waits behind something that is not.

---

## 1. What the eye catches now

### 1.1 The diorama ignores the theme

The app has a dark theme and the baked city does not know about it: the terrain and
the houses arrive off the GLB in one palette and read as a white model dropped into a
black room. `THEME_COLORS` in `environment-layer.tsx:93` still holds a `light` and a
`dark` set — but that is the old procedural path. `city-layer.tsx` takes no theme at
all; the colours come from `MESH_COLOR` in `bake.ts:184`, written into each
material's base-colour factor at bake time.

The cheap fix needs no rebake: the meshes are named by kind (`terrain`, `building`,
`water`, `portal`, `model`, …), so the loader can multiply a per-kind factor over the
baked colour once per belt. Two palettes in one place, the theme picks one. The
awkward case is `model`, which is white on purpose because a merged kit house carries
its colour per vertex — tinting that one is a multiply over vertex colour, so check
it by eye rather than assuming.

First because it is one file, no rebake, and it is what makes the scene look wrong the
moment the app opens in the dark.

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

### 1.4 The light rig

Left for last, on purpose: the rig is what settles once the things it lights are
finished, and the measurement below says nothing in it is urgent.

**What was measured** (2026-09-01, in the app over `window.__f1three`, 24 cameras —
azimuth every 45°, elevation 5/15/35°, 3500 m out, mean/sd/clipping read back
with `readPixels`):

- The reported black side does not reproduce. Mean luminance runs 85–140 of 255,
  dark pixels stay under 1 %, nothing clips. The shaded quadrant (azimuth 225) is not
  black, it is flat: mean 85 and sd 27 against 140 and sd 45 on the lit side.
- The key directional carries the picture — 45 of ~110 mean. Ambient is worth 17,
  the hemisphere 10. **The blue fill and the red rim are worth 2 each**: they do not
  light anything.
- A sweep of five rigs (fill 1.0 and 1.2, ambient down to 0.36, a lifted hemisphere
  ground colour, key down to 1.2) measured as a tie — light/dark spread 1.58–1.64
  against the current 1.64, dark-side sd 27 → 29. Turning the fill knob moves the
  frame by 3 units of 255. There is no win in the numbers as the rig stands.
- The red rim does not light, it dyes. It shifts mean r−g by 8–20 and puts up to
  6.7 % of the frame into visible red at low elevation. From the north the whole city
  goes pink; with it off the scene is a clean cool grey. That is a style call.

**The open question**, which is why this is not just "delete two lights": everything
outside the diorama is black, so nothing in the picture explains where the light comes
from. A sun that is nowhere, over a model in an unlit room. Decide what the scene is
lit *by* — a sky the camera can see, an environment map, or an honest studio look with
the plinth as the table — and the intensities follow from that answer instead of
being tuned against nothing.

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
want their own pass. The model has a body now — sides and a floor at −60 m — so the
question is no longer what breaks when the camera drops, only how far out it may go
before the block stops filling the frame.

---

## 3. Small, when someone is already in that file

- **The last 0.34 m of the belt seam.** 28 of the 1,136 shared points are more than
  0.15 m apart — mean 0.06 m, worst 0.34 m, all on a boundary node and 23 of them
  exactly on the grid. Invisible; the staircase that started it was metres.
  Quantisation is not the cause (0.045 m at the 64° slope these sit on buys 0.09 m).
  `env:audit` reports it every run. Worth an hour when someone is next inside
  `bake.ts`'s boundary code.
- **The 12 m lip past the plinth.** Each belt's grid ends on its own cell size, so
  the core belt reaches up to 12 m further out than the far belt does — 120 cells of
  it on Monaco, where the track runs close to the bbox edge. They keep the 3 m skirt
  they always had and now hang past the block's wall. Predates the plinth and reads
  as a fringe on the `plinth` shot's right-hand rim; the fix is to clip every belt to
  the coarsest extent, which is a change to the grid rather than to the wall.
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
