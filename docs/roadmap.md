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

### 1.1 Kit houses, looked at

Looked at and acted on, 2026-09-02. The direction holds — the silhouettes fit the
plots — and all three findings are closed: the houses stood on their plot's lowest
corner and 12 of 75 were buried past half their height (D32, they now stand on the
middle of the ground with a terrace under them); the kit painted itself green and
charcoal in a white city, and a plot could be 3.6 m long (D33, the paint is remapped
into the palette and the shape test has an 8 m floor).

Then the ask changed: model every building where a model fits (D34), and then fit it
properly (D35). Models are stretched to the surveyed rectangle and the measured
height, chosen by how little they have to bend; the industrial pack and Modular
Buildings' assembled samples joined the library. **266 buildings are modelled**, the
city belt is at 336,464 triangles of its 350,000, and the fit is exact by construction
where it used to be 10 % off the surveyed height at the median.

What holds coverage down, in order: **468 plots ran out of triangles**, 87 have no
model within the stretch cap, 0 stand where the road reaches in. The first has room to
move — every model ships in the city belt's mesh, while the core belt sits at 134,950
of its own 450,000. Splitting the models mesh per belt would put the near ones on the
core belt's budget and roughly triple what the city can afford.

Still open, and the next thing a person would notice: **the same silhouette twice in a
street.** 39 distinct models over 266 buildings, the most used one 41 times. The pick
is already least-stretched-first with the hash breaking ties inside the top third; what
it does not know is what its neighbours took.

### 1.2 The light rig

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

**Checked 2026-09-02, and it is smaller than it reads.** `terrain-sampler.ts` does
still clamp with `Math.max(0, …)` and flatten where `isWater`, but nothing on the
baked path asks it anything: `track-mesh.tsx` returns `null` for the sampler as soon
as a city manifest is loaded — "the baked field already decided the ground" — and the
only other caller is `environment-layer.tsx`, the old path P4.4 deletes. Rewriting the
sampler to read the baked field is work on a file that is scheduled to lose its last
reader. Do it as part of P4.4, or not at all.

### 2.2 The info panel's elevation profile

**Done 2026-09-02.** Where a city is baked the panel reads `track.elevations` off the
manifest — the ground the bake drew, which is what the scene stands on — and says so
under the sparkline. Monaco went from 0/55 m with 100 m of climb to 1/43 m with 46 m,
because the API's reading is noise the bake has already filtered.

### 2.3 Hand overrides for Monaco

The overrides file format and loader exist (D10). What has not happened is Monaco's
own first pass over Le Rocher, Port Hercule and the tunnel run — the corrections that
only a person looking at the city can decide.

### 2.4 Camera distance limits

The polar-angle floor is set, the model has a body, and the camera is now held 2 m
above the ground by `camera-ground-clamp.tsx`, so neither going under the model nor
flying into it is reachable. What is left is the distance: how far out before the
block stops filling the frame, and how close before the near plane eats the street.

One cost to look at in the same pass: the clamp reads the highest corner of every
triangle whose footprint touches a cell, so at the foot of a vertical cliff it holds
the camera at the clifftop — 29 m of headroom under Le Rocher, measured. Erring
upwards is the right default, but a cliff foot is a place someone will want to stand.

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
- **The portal has no wing walls.** The mouth is a cut face with the arch taken out
  of it, and where that face meets the slope there is nothing between them. The
  cutting's own sides are terrain, so they are as lumpy as the belt that draws them.
  Real work here means excavating the approach properly, which is P4.1.
- **The 28 props with no ground under them.** Trees mapped over water or past the belt
  the ground stops at. They are skipped, which is right, but nobody has looked at where
  they are — a tree on a quay that the coast cut away is a different bug from a tree
  outside the bbox.
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

### 4.4 The ground's own colour

A terrain that is grey or white is a model of a landscape, not a landscape. Once the
city is standing in modelled assets rather than extruded boxes, the ground wants a
range — light green to dark — rather than the one stone tone it has now. It waits for
the assets on purpose: the colour that reads under boxes is not the colour that reads
under models, and doing it twice is doing it wrong.

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
