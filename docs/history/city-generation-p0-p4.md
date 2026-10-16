# City generation — the P0–P4 journal

What was built between P0 and P4, in the order it happened, and why each step took
the shape it did. Lifted out of `../city-generation.md` when that file passed 1,400
lines and stopped being readable as either a plan or a reference.

This file is **closed for growth**. It records work already done. New work is
planned in [`../roadmap.md`](../roadmap.md); the decisions and findings the work
rests on stay in [`../city-generation.md`](../city-generation.md); what the result
has to look like is [`../scene-goals.md`](../scene-goals.md).

Items still carrying an unticked box below were carried forward to the roadmap —
they are left here so the phase reads whole.

---

## 6. Plan

### P0 — Prove the data exists — **DONE**

- [x] **P0.1** Coverage confirmed over the whole Monaco bbox at ~3.9 m native. Sea is
      nodata. Landmark spot checks match reality. See §5.2. D3 amended 2 m → 4 m.
- [x] **P0.2** DSM confirmed, plus MNH (height above ground) which is better. See §5.3.
      D8 amended to read MNH directly.
- [x] **P0.3** GDAL and PDAL are **not installed on this machine** — and are not
      needed. The WMS returns float32 BIL that TypeScript reads directly. D12
      superseded; §3.3's raster intermediate collapses to a fetch plus a header.
      Contamination trap found and recorded in §5.5.

### P1 — Thin slice: the joints, and nothing else

Deliberately ugly. Terrain, boxes, track, water — baked, loaded, audited. This phase
exists to prove the joints hold before any effort goes into how it looks.

- [x] **P1.1** `scripts/env/raster.ts`: a `fetchElevationRaster(bbox, layer, size)`
      over the IGN WMS (§5.1) returning a `Float32Array` plus a header, with the nodata
      handling from §5.5 (threshold at −20 m, erode the valid mask by one cell), cached
      on disk like the existing Overpass cache. Behind a provider interface, so a
      non-French circuit can supply a different source later. **Done.** Monaco
      returns 702 × 763 at exactly 3.90 m/px; after the nodata pass the minimum
      is −0.23 m instead of −498.6 m. Landmark samples verified against §5.2.
      `bun scripts/env/raster.ts --bbox=… --kind=dtm` prints the coverage map.
- [x] **P1.2** `scripts/env/heightfield.ts`: MSL datum, track constraint burn-in
      (§3.4), uniform native-cell storage. **Done.** Monaco builds 702 × 763 at 3.90 m,
      ground −0.23…452.52 m, water 39.6% of cells, track profile 1.12…42.96 m over
      1184 samples. Burn-in touches 1.1% of cells; 73 cells (0.014%) move more than
      8 m, all of them on the cut sections below Casino where a retaining wall stands
      in reality — those arrive with the props in P3.4. Verified against a hillshade
      render: harbour basin, Le Rocher and the amphitheatre all read correctly, and the
      §5.7 terracing is gone. Port Hercule, Fontvieille, Larvotto and the Cap d'Ail
      marina read as water rather than pavement, found by the §5.6 rule.
- [ ] **P1.2b** Rewrite `src/lib/env/terrain-sampler.ts` as a reader over the baked
      field; delete the `Math.max(0, …)` clamp and the `isWater` flattening. Deferred
      to P1.3, which is what first produces a baked field for the runtime to read.
- [x] **P1.3** Bake: terrain mesh + extruded building boxes + track visual + water
      plane at `y = 0`, split by belt, meshopt-compressed, three GLBs + manifest v2.
      **Done** (`scripts/env/bake.ts`, `belts.ts`, `mesh.ts`, `plane.ts`). Monaco bakes
      in 3.3 s to **0.92 MB** across the three belts — 5.87 MB before meshopt —
      156 654 triangles and **8 draw calls**, against budgets of 15 MB, 920 k and 120.
      785 buildings placed, 19 footprints pushed off the corridor, none left inside it.
      World bounds read back at 2736 x 2974 m with terrain to 452 m, so quantisation
      keeps the placement. Belt seams are hidden with a 3 m skirt rather than stitched;
      water is one quad at the datum, since the terrain edge already is the coastline.
      Terrain is emitted per triangle, not per cell: dropping a whole cell when one
      corner is water costs up to 16 m of coast in the far belt and reads as teeth of
      sea biting into the city.
      The manifest is `city-manifest.json` (v2), beside the belt files. Run it with
      `bun run env:bake mc-1929`, look at it with `bun run env:preview`.

      Two bugs the preview caught and the numbers did not: terrain and water were
      wound clockwise, so both were back-faces and invisible from above; and belt
      membership decided per cell left a hairline of unclaimed ground along each
      boundary, since an 8 m cell and the 16 m cell over it disagree about which
      side of the radius they are on. Ownership is now decided once on the coarsest
      grid and the finer grids divide into it exactly.

      Still runtime, not baked, contrary to D13: kerbs, apron and painted markings. The
      ribbon is baked; the rest follow once the loader proves the joint holds.
- [x] **P1.4** `city-loader.ts` and `city-layer.tsx`: fetch far → city → core, mount
      beside the existing layer, gated so a circuit without GLB keeps the old path
      (D17). **Done.** Monaco loads **354 KB** over the wire (54 + 185 + 115 KB
      gzipped) against 2.1 MB of diorama JSON before, which is no longer fetched at
      all when a city manifest exists.

      The datum is the joint: the manifest carries one height per centreline vertex,
      and the runtime builds its curve from those with no offset, so the ribbon lands
      on the ground the bake burned it into. `terrain-sampler` is bypassed entirely in
      city mode — the field already decided where the ground is.

      Two leftovers: the ribbon still sits `TRACK_SURFACE_RAISE` (1.1 m) above the
      curve, which P1.5 should measure and P1.2b should remove; and the info panel's
      elevation profile still reads the old SRTM array, so it disagrees with the scene
      it describes.
- [x] **P1.5** `scripts/audit-environment.ts` with the §4 checks; `bun run env:audit
      mc-1929`. **Done, and Monaco passes every fatal check.** Measured:

      ```
      total bytes                      0.84 MB                  limit 15 MB
      city draw calls                  7                        limit 75
      terrain follows the field        worst 0.47 m / 10 276     limit 0.6 m
      water sits on the datum          0 vertices off            limit 0
      track profile matches the field  worst 0.005 m             limit 0.05 m
      buildings floating               0                         limit 0
      baked walls in the corridor      0                         limit 0
      ground range under a footprint   709 of 785, worst 46.1 m  reported
      ```

      The geometry checks read the shipped GLB rather than the bake's own report,
      dequantising through each node's transform. Three thresholds are set by
      measurement, not by wish: 0.6 m for terrain (position quantisation moves a
      vertex by up to half a step), 0.5 m of corridor slack for the same reason, and
      the coastline cross-check reports "no reference data" instead of a fake pass —
      OSM has no polygon for the Mediterranean, and Monaco's water layer is villa
      swimming pools sitting hundreds of metres up a hillside.

      **The finding that matters: 709 of 785 footprints span more than 1.5 m of
      ground, the worst 46.1 m.** A flat-based prism from the lowest corner turns a
      terraced block on a hillside into a 46 m cliff of wall — those are the tall
      slabs in `images/bake-harbour.png`. This is P3's problem to solve, and it is
      now a number that moves rather than an impression.

**Exit criterion: met.** `bun run env:audit mc-1929` reports zero floating buildings,
zero baked walls in the track corridor, 0.005 m of track/field disagreement, and every
belt an order of magnitude inside its byte budget.

### P2 — The things Monaco cannot be without

- [ ] **P2.1** Overpass query gains `tunnel`, `bridge`, `layer`; `RoadLine` and the
      building schema carry them.
- [x] **P2.2** Tunnel portals (D4): an arched sleeve standing 1 m out of the hillside
      at each mouth, 8 m of dark vault behind it, capped at the far end, with a 2.5 m
      headwall around the opening. **400 triangles for eight mouths.** The sleeve's
      faces point inward, so its near side is culled and the camera sees the dark far
      side through the arch. The hill is untouched — a height field cannot hold a
      cavity — and P4.1 still owns the real excavation.

      The headwall gets its own mesh rather than riding the buildings' material: it
      stands over the road on purpose, and merged in it made `env:audit` report 360
      walls in the track corridor. One extra draw call, and the check stays honest.
- [x] **P2.3** Quay walls from OSM's `natural=coastline`, `man_made=quay` and
      `man_made=breakwater` (`scripts/env/shore.ts`). **511 wall segments built, 313
      skipped, 41 piers skipped.**

      The rule is agreement, and it is what keeps D15 intact: a segment is built only
      where the raster has water on one side of the line and ground on the other. An
      OSM line running across dry ground or out in open water is a line the DEM
      disagrees with, and a wall there would be a slab in a street or a fence in the
      sea. The first pass probed 5 m either side and skipped 82% of segments; the two
      surveys are simply drawn a few metres apart, so the probe now widens to 12 m —
      OSM gives the wall its direction, the raster gives it its position.

      Piers are skipped by kind: the line runs down the middle of the deck, so both
      sides are the same thing and the water test says nothing. Piscine is not modelled
      yet.
- [ ] **P2.4** Overrides file format and loader (D10) — data edits, masks, splines.
- [ ] **P2.5** Monaco's first hand-override pass: Le Rocher, Port Hercule, the tunnel
      run, and whatever `env:audit` still flags.

### P3 — The look

- [x] **P3.1** Building heights measured from IGN MNH (`scripts/env/building-heights.ts`).
      **794 of 800 measured, 6 left on OSM tags, median move 7.0 m, tallest 114.6 m.**

      MNH is sampled on its own grid *inside* each footprint — sampling the outline
      would read the street the building stands beside — and the height is the 75th
      percentile of those readings, so a block reads as its main mass rather than as
      its tallest aerial. A footprint smaller than a raster cell falls between the
      sample points, so it gets its centroid as its one reading.

      A 7 m median move is the difference between a grey block model and a skyline:
      compare `images/bake-harbour.png` with `images/heights.png`.
- [x] **P3.1b** The bake takes its buildings from Overpass directly, with tags, instead
      of the old pipeline's `buildings.json`. That file held **800 footprints**; the
      query returns **4 792**, so the old generator was dropping five buildings in six.
      Baked: 4 776 buildings, **1.87 MB** total and 226 k triangles, still an order of
      magnitude inside D5. It also removes a dependency on the path D17 will delete,
      and brings the tags — `roof:shape`, `building:levels`, `height` — that roofs need.

      One trap on the way: Overpass answers a refusal with **HTTP 200, an empty element
      list and a `remark`**. Taken at face value that cached an empty city, so the
      client now treats an empty-with-remark answer as a failure and moves to the next
      endpoint.

- [x] **P3.2** Roof archetypes (`scripts/env/roofs.ts`): flat with a parapet, gabled,
      hipped, pyramidal, skillion. Monaco comes out **1 614 flat, 655 gabled, 2 503
      hipped, 4 pyramidal**, at 2.43 MB and 264 k triangles.

      Only 72 of 4 792 buildings carry `roof:shape`, so the tag decides where it exists
      and size, height and elongation decide everywhere else. A pitch needs to know
      which way the building faces, which a ring of coordinates does not say, so the
      direction comes from the footprint's **minimum-area bounding rectangle** (convex
      hull, then rotating calipers). A footprint that fills less than 72% of its own
      rectangle — an L, a courtyard block — keeps a flat roof, because a ridge across a
      plan like that lands in mid-air.

      The measured height is the top of the roof, not the top of the walls: the roof
      takes its height off the eaves, so measuring and shaping do not fight.

      The audit found the one real consequence: a roof built on the bounding rectangle
      can overhang the pushed footprint, and three vertices leaned 1.37 m over the
      track corridor. Eaves over a road are what buildings do; walls in a road are not.
      The check now separates them by height above the ground rather than banning
      both.
- [x] **P3.3** Ambient occlusion baked into vertex colours (`scripts/env/ao.ts`).
      Monaco: **3.40 MB total, 10 draw calls**, and the bake still runs in under two
      seconds.

      What is computed is sky visibility — from each vertex, how much of the sky the
      surroundings block — sampled over 8 azimuths and 8 distances against a 4 m grid
      holding the terrain with everything standing on it stamped on top.

      Two things had to be fixed before it showed at all. The grid was first stamped
      per **vertex**, and a wall carries vertices only where its footprint turns, so a
      40 m block occluded two cells and left the street beside it in full sun; every
      triangle is now rasterised. And raw sky visibility is a gentle quantity — a
      street with towers either side still sees three quarters of the sky — so it read
      as no shading at all until the openness was put through a curve. Both are
      recorded in the module.

      Colour is still the palette: glTF multiplies vertex colour into the base colour,
      so this shades the palette rather than replacing it, and there are no textures.
- [x] **P3.4** Barriers down both sides of the circuit in the core belt — **12 324
      triangles**, one mesh, nothing built through the tunnel. They are a thin box
      rather than two faces back to back: coincident quads fight over depth and the
      face turned away from the sun wins half the time, which draws a black line down
      the circuit. They are also left out of the AO pass, since a thin object at street
      level comes back from it nearly black.

      **Not done: grandstands.** Monaco's are temporary and OSM does not carry them, so
      there is nothing to place them from. That wants either an override (D10) or the
      authored props of P4.2, and guessing at their positions would be inventing a
      racetrack rather than modelling one.

      Debris fences are skipped for the same reason a fence is hard without textures:
      a solid panel is wrong and a transparent one costs a sorted draw. It waits for
      the material work that P4 can carry.

### P4

- [x] **P4.0** The coast is cut against the surveyed line, not the grid —
      `scripts/env/coastline.ts`.

      The height field only knows land from water per raster node, so every water
      edge it could draw ran along a grid line: teeth 4 m across in the core belt
      and 16 m in the far one. Per-triangle emission (P1.4) removed the *holes* in
      the shoreline but not its grain, and no cell size removes a staircase — it
      only makes the steps smaller while paying for them over the whole surface.

      So the terrain is emitted by marching squares against a scalar that is the
      signed distance to the OSM shoreline, and it is the crossing of that scalar,
      not the cell boundary, that ends the land. A cut cell keeps its dry corners,
      gains a vertex wherever its rim crosses the line, and is fanned. The cut edge
      is shared by both cells that own it, so it cannot open a seam, and it carries
      its own skirt down past the datum — the grid-aligned skirt now only fires on
      a dry rim, which is the belt boundary and the edge of the bbox.

      **Which side is dry** is the part that cannot come from geometry. OSM orients
      `natural=coastline` with the land on its left, and across Monaco's 25
      coastline ways the raster agrees with that on **every segment it has an
      opinion about** (measured: 0 ways on one side, 25 on the other), so the tag is
      taken at its word. That matters beyond tidiness: the old majority vote threw
      away a 59-segment coastline because the raster could only separate the sides
      on 2 of them. A quay or a breakwater carries no such promise and is still
      oriented by probing the field along its length.

      Where the surveyed line is not near, the raster mask still decides, so an
      enclosed basin with no OSM line behind it keeps the old edge.

      **Result:** 28 of 94 ways cut the terrain (540 segments after the
      corroboration filter); the 66 that do not are 41 piers — a pier is drawn down the middle of its own deck, so it has no
      land side and cutting against it would slice the deck in half — and 2 quays
      whose sides the raster cannot separate, and 23 `natural=water` rings that turn
      out to be Monaco's fountains and swimming pools — OSM does not draw the sea
      as an area, so the `MIN_BASIN_M2` floor earns its keep by refusing to open a
      hole in a courtyard. Cost over the whole of P4.0: **3.58 → 3.65 MB**.

      One correction on the way in: a node the line calls land can be one the
      raster calls sea and has no height for, and feeding that `NaN` into a vertex
      threw triangles across the scene. Such a node now takes the nearest dry
      reading rather than the datum, which is also what keeps the quay a wall
      instead of a beach.

      `env:audit` had to learn the difference too: on the cut line the mesh and the
      field are *meant* to disagree, so vertices within one far-belt cell of either
      cut source are counted and reported separately (**1 377 at the cut coast,
      worst 2.41 m**) while the ground proper holds **worst 0.42 m** over 9 067
      vertices.

      **Three defects found by looking at it afterwards**, each with a different
      cause:

      *The headland hung in the air.* The coast's skirt dropped a fixed 3 m, so a
      cliff standing 30 m above the sea got a 3 m hem and open air below it — from
      the water the whole south shore read as a shelf on nothing. It now runs to a
      fixed depth **below the datum** instead, which is the same two triangles.

      *The marina read back as a comb.* Pontoons, moored hulls and a crane or two
      leave strips of dry cells one or two wide running out into the basin, and
      the shoreline grows tongues and sheds flakes from them. Smoothing the edge
      cannot help: the mask itself says the land is there. `openLand` erodes the
      land mask and dilates what survives, deleting anything narrower than 10 m
      and leaving a real quay — tens of metres across — exactly where it was. It
      runs before the speck filter, so flakes it cuts loose are then removed
      rather than left floating.

      The radius is measured, not guessed, and the first attempt got it wrong:
      at 5 m the erosion is three cells, which leaves nothing of a five-cell
      jetty but a chewed remnant — the quays came back gnawed. A marina pontoon
      is 3–4 m across and Monaco's quays are 10–20 m, so the cut belongs between
      them: one cell, deleting strips up to about 4 m wide and leaving anything
      wider untouched.

      **A block the water runs through is drawn at the city belt's cell**, however
      far it is from the circuit. The cut is only ever as fine as the grid it is
      sampled on, so a 16 m cell left the far-belt coast as 16 m steps no matter
      how smooth the line behind it. A coastline is looked at from anywhere,
      unlike the ground behind it. Cost: **+2 959 triangles in the city belt,
      −471 in the far**, 3.65 → 3.69 MB.

      *Islets speckled the harbour.* A LiDAR return off a moored boat or a pontoon
      leaves a few dry cells in the middle of a basin and the terrain dutifully
      built an island there. `despeckleLand` in `raster.ts` returns any enclosed
      land component under **150 m²** to water, before the box average can blur it
      into its neighbours. Monaco now has **zero** enclosed land components.

      *Larvotto still came out as 16 m steps.* 97% of the shore was cut by a line,
      but the remaining 93 nodes sat **26–160 m** (median 76) from any mapped way,
      and there the scalar fell back on the land/water flag — which is boolean, so
      its edge was the grid again. `shore-distance.ts` replaces that fallback with
      a **smoothed signed distance to the water**, built by a chamfer transform
      over the field and blurred twice, so the zero crossing lands between the
      nodes rather than on one. Every metre of coast is now cut against something
      continuous.

      *The cliff edge was a palisade.* A cut vertex inherited the height of the dry
      node behind it, which is right for a quay and wrong for a cliff: Le Rocher
      rises 53 m within 30 m of the sea, so its waterline inherited the clifftop
      and neighbouring edge vertices stood **30 m apart** (median jump 3.6 m). The
      edge is now capped at `SHORE_EDGE_MAX_M` = 3 m — the waterline belongs at the
      water, and the rise belongs to the ground behind it. A quay keeps 3 m of its
      own height, which is what its wall covers anyway.

      Above the waterline the cliff is still terraced, and that is the raster, not
      the mesh: a transect reads 53, 50, 43, 37, 27 m and then nodata, because a
      DTM cannot represent an overhang and steps down instead. Nothing in the bake
      can invent the face it did not measure.

      That fallback exposed the real conflict underneath. Around Larvotto the
      mapped line and the LiDAR disagree by up to 160 m — reclaimed land in one
      source and open sea in the other — so at the edge of the line's influence
      the scalar jumped across zero and the shore came out as a *band of loose
      triangles*, worse than the staircase. The fix is not to blend two sources
      that contradict each other but to drop the one that cannot be corroborated:
      a segment now only cuts if the raster finds water on its wet side and ground
      on its dry side within 15 m. **270 of 810 segments** fail that and the
      smoothed distance takes those stretches instead.

- [x] **P4.0b** Two defects the coast work uncovered, found by looking rather than
      by measuring.

      **Every flat roof was invisible from above.** The cap was built by
      `ShapeUtils.triangulateShape`, whose indices are already wound to face the
      sky once read back in scene axes; reversing them turned all of them over.
      Counted: **1 312 of 1 319** horizontal caps in the core belt faced down, so
      backface culling left the buildings open like boxes — from the air the city
      was see-through. Same test after the fix: 1 310 up, 9 down. (The residual
      handful are self-intersecting footprints where the winding is not
      well-defined; a whole-mesh normal test would not have caught the bug
      anyway, which is why it survived P3.2.)

      **The tunnel had no bore.** The sleeve stopped 8 m in and was capped, so a
      mouth read as a black rectangle painted on the hillside — a "trace of a
      hole", exactly as reported. `bakeTunnelBody` now sweeps the portal's own
      section along the buried stretch of the lap: floor, walls, vault, rings
      every 9 m, open at both ends, so a mouth opens into a bore with daylight at
      the far end. **838 triangles** for the whole 455 m. It is a swept section,
      not an excavation — the bore is only ever seen down its own axis — and P4.1
      still owns cutting the hill open for real.

      **Geometry follows the cover, not the tag.** Built along the whole tagged
      455 m, the bore stood *on* the surface for a quarter of its length —
      measured **549 of 2 652 tunnel vertices above ground, worst 6.7 m**, showing
      as a black strip over the hill. The tag is not wrong: Monaco's tunnel runs
      under the Fairmont for its first 85 m and under the waterfront for its last
      27, and a DTM measures the ground *beneath* a building rather than its roof,
      so the field reads no cover there at all. `coveredRuns` picks the stretch
      with real ground over the road, and both the bore and the mouths follow it:
      the vault is built where something is holding it up, and the portals sit
      where the hill starts. **51 vertices above ground, worst 2.9 m**, and those
      are the headwalls, which are meant to stand proud. The lap is still buried
      for the full tagged length — that is what the profile and the audit read —
      it simply has no vault where the data says there is no hill.

      **Quay walls stopped growing into cliffs.** The wall takes its height from
      the ground behind the line, which is right on a waterfront and absurd
      against a headland: along Le Rocher the ground behind the coastline is the
      clifftop, so the walls came out as a row of fangs standing out of the sea —
      **median 1.6 m, but a tail reaching 38.7 m**. Nobody poured that, and the
      terrain already renders the headland. Segments whose ground is over
      `MAX_TOP_M` = 8 m are now skipped: **93 of 512**, leaving 419.

      **Buildings stopped growing stilts.** Walls ran from the floor down to the
      lowest ground under the footprint, which on the lip of a cliff is the foot
      of the cliff — once the coast was cut back to the waterline those blocks
      stood in the bay on 40 m legs. `MAX_UNDERCUT_M` = 8 m stops the reach:
      past that the ground is not the building's plot, it is the drop beside it.
      Floating buildings stay at zero.

      **The ribbon is not drawn where it is buried.** Under a hill the road is
      inside the terrain, and the depth buffer only hides it while the camera is
      close; from far off its precision runs out and the ribbon shows through the
      hillside in patches. The manifest now carries `track.buried` — inclusive
      index spans over the centreline — and the runtime skips those segments of
      both the ribbon and its outline. Under a hill there is a bore to look at
      instead.

      Two corrections to that, from looking at it: the spans were written as
      **fractions of vertex index**, but the runtime samples its curve evenly by
      distance while the centreline's vertices are spaced by whoever drew it —
      Monaco's hairpins carry a vertex every few metres and its straights every
      twenty — so the gap landed a couple of hundred metres past the tunnel and
      ate live road. They are fractions of lap length now: `0.167–0.297`, which
      is 431 m of 3 337 — and then narrowed again to the stretch that actually
      has a hill over it, the same test the bore is built on, because hiding by
      the tag took the ribbon away while the car is still out in the open under
      the Fairmont and read as missing road *before* the tunnel. **264 m** —
      and then widened again to **365 m**, because that test needs 3.7 m of cover
      to fit a vault while the ground starts covering the road well before that:
      over the metre or two in between the ribbon was genuinely buried and showed
      through the hillside as red dashes. Two questions were riding on one
      number. Whether the ribbon is visible is *is there ground over it*, at
      0.3 m; whether a vault fits is the bore's own test, answered separately.
      Verified: **0 centreline vertices with ground over them are still drawn**.

      What was still showing from above was not the road at all but the portal:
      a mouth sits where the cover first reaches the bore's headroom, which is
      less than the arch plus its headwall needs, so the crown and the outer
      corners of the surround stood out through the slope — **63 portal and 42
      bore vertices above ground, worst 5.5 m**, reading as two bright slivers
      lying in the hill. The arch now scales to the lowest cover along its own
      sleeve, and every point of the headwall is clamped to the ground it sits
      over — the wall is 19 m across and the hill falls away sideways, so its
      corners stood clear however low the arch went. **Zero portal vertices
      above ground**; 15 of the bore remain, worst 1.1 m. And the ribbon is not the only thing drawn along the
      lap: its outline, apron, kerbs and edge lines were still there, showing
      through the hillside as thin red lines. All of them take the same spans.

      **Buildings sit on the ground under each wall vertex**, not on one base
      plane. A single plane either buries the uphill side or leaves the downhill
      side in the air; capping the drop at `MAX_UNDERCUT_M` = 8 m stopped the
      40 m stilts but still left slabs standing where the slope fell away faster
      than the cap. Per-vertex footing does neither, and the cap still applies:
      past 8 m the ground under a footprint on a clifftop is the drop beside it.

      **Quay walls are tied to the cut.** The terrain only follows a segment the
      raster corroborates; elsewhere it follows the smoothed distance. A wall
      built on an un-corroborated line therefore stood off the shore in open
      water — the wedges sticking out of the bays. A wall is now only built
      within `MAX_OFFSET_FROM_CUT_M` = 6 m of the edge the terrain was actually
      cut on: **210 more segments skipped**, 413 built.

- [x] **P4.0c** The land is held clear of the sea plane — `WATER_CLEARANCE_M`.

      The water is one quad at the datum, so ground the DTM reads at y = 0 is
      co-planar with it and the depth buffer picks a winner per pixel. That
      winner moves with the camera, so the bay at Larvotto changed shape as the
      view pulled back — the defect read as a coastline problem and was a depth
      problem. **7,625 m2** of near-horizontal terrain sat within 15 cm of the
      datum; the surface now starts 0.25 m above it and **none does**. The audit
      measures against the same clamp, so the clearance cannot be mistaken for
      drift: worst 0.37 m against a 0.6 m limit, unchanged.

- [x] **P4.0d** The pontoons are decks, not terrain — `scripts/env/piers.ts`.

      Port Hercule's pontoons are **4–5 m wide** and the core belt's cell is
      **4 m**, so the shape is narrower than two samples of the grid meant to
      hold it. No reconstruction of it can be right, and both attempts proved
      it: the raster's version came out as a comb, and cutting the terrain
      against the mapped pier rings produced rounded blobs the size of
      `INFLUENCE_M`. The raster itself agrees it cannot hold them — after the
      opening, only **12%** of the area inside the mapped rings is still land.

      So the deck is not sampled. The ring OSM surveyed *is* the outline, and it
      is extruded directly the way a building footprint is, with walls to the
      same foot the coast's skirt uses. **31 decks**; 3 piers mapped as a line
      keep the terrain's version, 4 are too small to be worth one, and 3 are
      wide moles the terrain already draws properly. Cost: +1,489 triangles and
      one draw call, all in the city belt.

- [x] **P4.0e** The belt boundary stops landing on the waterline.

      Larvotto's breakwaters came out as torn crescents and the harbour quays as
      a row of teeth, and neither was the cause anyone would guess. It was not
      the source: at the waterline itself the surveyed line covers **85%** of
      Larvotto and **100%** of Port Hercule — the earlier "16%" reading was
      measured over a whole window, most of which is open sea, and was
      meaningless. It was not the cell size either: drawing the coast at the
      core belt's 4 m changed nothing.

      Baking the whole city as one belt fixed it completely, which named the
      cause. Two belts cut the same waterline from their own nodes, so their cut
      polylines reach the shared block edge at different points and leave a
      sliver of open water between them — and the grid skirt only fires on a dry
      rim, so nothing closes it.

      So the set of blocks the waterline runs through is grown by one block in
      every direction and the whole band is drawn at the core cell. The belt
      boundary then lies either wholly at sea, where neither side draws
      anything, or wholly on dry ground, where the skirt hides it as it hides
      every other boundary. Cost **3.72 -> 3.95 MB**; the one-belt bake that
      proves the fix is 5.40 MB.

      The audit's skirt filter was wrong too, and this exposed it. Skirts share
      a mesh with the surface and were excluded by dropping anything more than
      2.5 m off the field — which holds only where the ground is flat. On the
      4:1 face below Le Rocher the ground under a skirt's foot is metres below
      the ground under its top, so the foot measured 2.47 m and passed for
      surface. A skirt is now recognised for what it is: a vertex standing
      directly beneath another vertex of the same mesh.

- [x] **P4.0f** The seams the coastal band exposed.

      Growing the coastal band put belt boundaries all through the city, and two
      faults that had been rare became visible everywhere.

      *The skirt asked a different question than the emitter.* A grid skirt was
      only built where `heightAt` had a reading at both ends, while the surface
      above it was built from `solidHeightAt`, which invents one from the
      nearest ring that does. Half of Monaco's belt boundaries touch a node the
      raster calls water, so half of them had surface with no skirt under it —
      an open crack. The skirt now reads the same source the surface did.

      *The boundary was a T-junction.* The coarse side draws one straight chord
      across 8 or 16 m while the fine side follows the ground every 4 m. The
      skirt stops that being a hole and leaves it a ledge. On the shared line
      the fine side now takes the chord: **10,403 nodes**, moved by **6.40 m at
      worst, 0.27 m on average, 776 over a metre**. Measuring shared nodes finds
      nothing — they always agreed — which is why the first measurement of this
      said the seam was fine.

      The audit counts those nodes in their own bucket, from the same block map
      the bake used (`buildBeltBlocks`, now shared) rather than from a second
      copy of the rule. Real surface: worst **0.50 m** over 9,589 vertices.

      *And the pier gate was on the wrong quantity.* Three rings were left to
      the terrain for being mostly solid ground; Port Hercule's north mole is
      66% land and **9 m across**, and the terrain's version of it was a torn
      comb. How much land the raster kept says nothing about whether the grid
      can hold the shape. The gate is now width — under three core cells and it
      gets a deck whatever the raster thinks. **34 decks**, up from 31.

- [x] **P4.0g** Breakwaters get the pontoon treatment.

      Same problem, different tag: Fontvieille's breakwaters are mapped as
      closed rings **6 and 9 m across**, and the grid made the same comb of them
      it made of the pontoons. **37 decks**, up from 34.

      Larvotto's breakwaters cannot be done this way and this is a limit of the
      source, not of the bake: OSM traces them as open `natural=coastline`, not
      as areas. Only **one** closed ring exists in that bay (way/224205566,
      17.5 m across), and the rest have no outline to extrude. Closing the gap
      to the aerial photograph there needs authored geometry — P4.2.

      The same holds for the marina. The box the west quay was compared against
      holds **7 pier ways in OSM** and the bake decks all 7; the aerial shows
      perhaps twice that, because the catwalks between the boats are not mapped.
      Nothing is being dropped — the data stops there.

- [x] **P4.0h** The ribbon stops coming through the buildings.

      The track's layers — apron, ribbon, edge lines, kerbs — were stacked by
      `polygonOffset` because their geometric separation is one or two
      centimetres, too little to survive depth precision at range. But polygon
      offset is a depth bias **scaled by the polygon's own slope**: the ribbon on
      a hillside seen at a grazing angle is pulled toward the camera by an amount
      that grows with distance, and at the Fairmont hairpin it came out through
      the building in front of it. Every "the track shows through" report has
      been this, once the camera-under-the-ground ones are set aside.

      The stack is ordered by height and draw order instead — apron at
      `RAISE - 0.02` drawn first, ribbon at `RAISE`, edge lines and kerbs at
      `RAISE + 0.02` drawn last. `depthTest` is `LessEqual`, so a later layer
      still wins where the depths quantise equal, and nothing is biased toward
      the camera, so a building in front is in front. **Seven** polygon-offset
      blocks removed.

- [x] **P4.0i** The raster's copy of a deck is cleared from under it.

      The LiDAR sees the pontoons and the boats moored along them, and its
      version sits a few metres off the mapped ring — so down the whole of Port
      Hercule the clean deck and a torn strip of terrain were drawn side by
      side, which is what the harbour still looked wrong for.

      The terrain now reads a node as water where a deck is near. Which halo,
      though, is not a distance: **80%** of the raster land within a deck's halo
      is the quay the pontoon is tied to, and the mapped coastline sits several
      metres off the raster's own quay edge in places, so a threshold generous
      enough to protect the quay leaves the debris and one tight enough to clear
      the debris bites notches out of the harbour wall — which is exactly what a
      10 m halo did. The test is relative instead: clear only where the **deck is
      the nearer of the two lines**. Which is closer does not care how far
      either of them is.

- [x] **P4.0j** A coastline the raster contradicts is still a coastline.

      Port Hercule's pier fingers came out as torn slabs offset from where they
      are mapped, and the cause was `agreesWithRaster` throwing away the very
      segments that describe them. **36%** of the harbour outline in that band
      was dropped, including the two 58 m segments that *are* the fingers.

      They were dropped for reading **reversed** — the raster finding ground on
      the wet side of the line and water on the dry side. But a coastline is
      oriented by definition, land on its left, so it already knows which side
      is which, and what the raster calls ground out there is the boats moored
      along the pontoon. Ten segments in the whole city read like this. What the
      confirmation is really for is a line the raster has nothing to say about
      on *either* side — the Larvotto case, mapped up to 160 m from where the
      LiDAR puts the water, sea on both sides of it. Silent is now the only
      failure; reversed is kept.

      Two other readings of the same evidence were tried and measured worse.
      Deleting the raster's land on the wet side of a contradicted segment
      merged the slabs into the quay and turned the quay's own edge into a
      sawtooth. Clearing a fixed halo around every deck bit notches out of the
      harbour wall.

      The corner hole at the pier root is separate: the signed distance is to
      the *nearest* segment, so where a pier meets its quay that segment's wet
      side sweeps back over the ground behind it. The line read **-1.8 m** there
      with **+2.4** and **+1.0** either side, while the raster had it 9.6 m
      inland. A shallow hole in ground the raster is confident about is now
      overruled — **54 nodes**, at a gate tight enough not to hand the shoreline
      back to the grid, which a looser one did.

      That gate closed the rim of the hole and not its core, and widening it
      brought the sawtooth back, so the hole is closed by **enclosure** instead,
      which needs no threshold on depth at all. A patch of water ringed by land
      is either a basin or an artefact, and every real basin here reaches the
      sea — so a small one that does not is an artefact. The shoreline is
      connected to the sea by construction and cannot be caught by this. **Ten
      cells** in the whole city, decided once on the core lattice so every belt
      fills the same ones.

- [x] **P4.1** The approaches are excavated, so the mouth is a hole in a face.

      D4 asked for a boolean cut through the hill. A height field cannot hold a
      cavity, so what it can be given instead is the part of the excavation that
      is actually visible: the **cutting** the road runs in before it reaches the
      rock. That is where the defect was. The tunnel is tagged for 455 m but the
      hill only covers 335 of them, and the terrain was the raw hill for the
      whole tag — so at each end a lip of ground rose over the road, the ribbon
      dived under it, and it cut across the arch in front of the mouth. From
      outside, the exit read as a pipe lying in a slope.

      **The burn-in now stops at the vault, not at the tag.** The corridor
      flattening already knows how to cut a shelf for a road; it was held back
      over the whole tagged tunnel, because burning a tunnel in would carve a
      canyon through the hill. Those are two different questions, and
      `TrackConstraint` now asks them separately: `buried` still says *do not
      trust the raster for the road's height here*, and a new `vaulted` says
      *leave the ground alone, something is holding it up*. Everything tagged but
      unvaulted is burned in, which is the cutting.

      Which stretch is vaulted cannot be known before the ground is, so the
      ground is built **twice**: a survey pass with the whole tag held back, to
      read how much hill there is over the road, and then the real pass holding
      back only what `vaultedRuns` found. No network, and the second pass is
      milliseconds.

      **The mouths move inward to where a full-height portal fits.** The arch
      used to be scaled down to whatever cover was at the mouth — measured 49% at
      Monaco, a squat opening — because a mouth sat where the cover first reached
      the *bore's* 3.7 m. It now walks in until the hill is `PORTAL_NEED_M` = 9 m
      deep, up to 30 m. Selecting the run at 9 m instead would have split it:
      Monaco thins to **6.6 m** of cover halfway through, which would have put
      two more mouths in the middle of the hill. **18 m cut open** in total, 9 m
      at each end, and both arches are full size.

      **The cutting stops square at the face.** A corridor is a distance to a
      polyline, so its end cap is round and reaches a full 13 m past the last
      burned sample — straight through the mouth, flattening the very hill the
      portal has to be a hole in. Measured: cover at both mouths read **0.00 m**
      and the arch collapsed again. Cells whose projection falls beyond the join
      are now left alone, so the flattening ends on the plane of the mouth and
      the rock stands where the vault begins.

      **The tunnel's geometry is sized against the hill, not against its own
      cutting.** The cut at a mouth exists *because* the portal does, so reading
      it back is circular — and it read as no cover at all. The pre-cut field is
      carried through to `bakePortals` and `bakeTunnelBody` for both the arch's
      scale and the headwall's clamp. Against the hill that shaped it: **0 of
      2 034 bore and sleeve vertices** and **0 portal vertices** stand above the
      ground, where the best previous result was 15 bore vertices at 1.1 m
      against a scaled-down arch. Against the finished terrain the headwall now
      stands 9 m proud — which is the point, it is a wall in an open cutting.

      **And the ribbon was hidden by the wrong ruler.** `buriedSpans` walked the
      *drawn* centreline, which carries a vertex every 30 to 70 m through
      Monaco's tunnel, and a span can only begin at a vertex — so **51 m** of
      ribbon was still drawn inside the hill at the entry, which is the red band
      that kept coming back. It walks the field's 3 m profile now. Hidden
      **647–973 m** against a vault of 641–976: **0 covered centreline samples
      are still drawn**, and the road stays visible right up to the face, which
      is what "there is road missing before the tunnel" was asking for.

      **The clip is a plane at the mouth, not a rule about segments.** Stopping
      only the last segment of the cutting was not enough — the one before it
      reaches just as far, because every segment carries its own round end cap.
      Measured: terrain nodes **6 m inside the vault** were still being pulled
      down to the road. The half-space at the mouth is checked once per cell and
      holds only within a corridor's reach of it, since a plane over the whole
      map would refuse to burn every other part of the lap beyond it.

      **And the mouth is a hole in a face, which needs the field to lose
      something.** With the cutting in place the terrain still crossed the
      opening: the cut floor and the untouched hill are neighbouring nodes 3 m
      apart with 8.6 m between them, and the surface drawn across that pair is a
      ramp — steeper than the arch and straight through it. A ray down the axis
      hit terrain **0.6 m before the mouth**. No wall in front helps; the ramp is
      *inside* the hole.

      So the ground over the arch is removed — `portalVoids`, D4's boolean cut
      reduced to the one shape the field has to lose — and the portal closes what
      that leaves: a face at each end with the arch cut out of it, a wall down
      each side, and a lid over the top. The same ray now runs **139 m** down the
      bore. Three sizing lessons, each found by looking: the face has to be wider
      than the void, because the void is decided on cell centres and the hole it
      leaves runs half a cell past its nominal edge; the face's height has to be
      read across its own width, not at its centre, or its corners come up short;
      and without a lid the excavation reads from above as a black rectangle cut
      into the slope — closed at the road's level and open at the sky's.

      Cost: **0 bytes**. Portals 75 → 148 triangles, and the terrain cell counts
      are otherwise unchanged — the cutting replaces hill that was already being
      drawn.

- [x] **P4.2** Props placed by coordinate — `scripts/env/props.ts`.

      Everything else in the bake is derived from a measurement. A prop is the
      opposite: it is there because somebody says it is, and the whole question
      is where. So there are two ways in and one way out. A placement either
      comes from `overrides.props`, where a human wrote the coordinate down, or
      it is derived from geometry the bake already trusts. Both end up as the
      same record and the same builder turns them into triangles.

      **The yachts are berthed, not typed in.** Port Hercule's pontoons are
      already extruded from the harbour survey (P4.0d), so the berths come from
      those decks: the deck's long axis from the covariance of its own ring —
      not its first and last point, which on a surveyed ring are wherever the
      mapper started drawing — and boats moored stern-to along both sides at
      beam plus three metres, the way the Mediterranean does it. Only `pier`
      decks; a breakwater is not something you tie up to. Lengths run 18–46 m
      from a hash of the berth, so the same berth gets the same boat every bake.
      **305 yachts**, +0.17 MB and +11 k triangles in the city belt, where the
      harbour they belong to already ships.

      **Where the field says water, and the field decides.** The first version
      tested the keel line only, and `env:audit` immediately found **14 hull
      vertices below the datum standing on rock** — boats whose shoulder was
      over the quay behind the pontoon. The test now runs across the beam as
      well: **305 placed, 0 aground**, and the audit keeps that honest with a
      check of its own, since a berth picked from the field and a hull drawn on
      the water are two things that can drift apart.

      **Parametric, not modelled.** A prop that reads correctly at a hundred
      metres is a silhouette, and a silhouette costs about seventy triangles;
      modelling it would cost an asset pipeline, a licence and a megabyte. The
      hull is lofted from five stations at a displacement yacht's own ratios, so
      a 40 m boat comes out 8.7 m in the beam rather than whatever a box would
      have given. Two corrections from looking at it: without **sheer** the hull
      is a wedge of paper and reads as a barge from the quay, and a deckhouse at
      the full beam reads as a container on a raft — set back to 0.26–0.56 of
      the length and 0.3 of the beam, it is a boat.

      **And a `.glb` may be named instead.** Anything with a name — the Casino,
      a particular sculpture — is a model somebody drew, and `placement.model`
      is the door for it: node transforms are baked down on the way in, so what
      arrives is triangles in the file's own units, and only the placement moves
      them. Verified against the repo's own car model, which merged as **230 945
      triangles** and sat on the ground at the coordinate given. That test also
      earned the `scale` field: glTF says metres and files disagree — the car is
      authored **6 cm** long.

      **Then the door was widened, because a kit is not one model.** Three CC0
      packs from Kenney — Watercraft, City (Commercial), City (Suburban), 127
      models between them — are fetched by `bun run assets:fetch` from
      `assets/assets.json` into `assets/models/`, which is not committed: the
      manifest records where each pack came from and under what licence, and the
      run rewrites `assets/CREDITS.md` from it, so a CC-BY pack costs a line
      rather than a memory.

      Two things had to change to make a kit usable. **Colour**: a kit paints
      itself from a texture atlas, and `readModel` was taking geometry only, so
      every model arrived as one flat prop grey. It now samples the atlas at each
      vertex's UV, converts sRGB to linear and keeps the result in `mesh.albedo`
      — kept apart from `colors` because the AO pass writes that array from
      scratch, and multiplied into it afterwards. Models ship in their own mesh
      with a **white** material, so the palette is entirely the model's own.
      **Size**: a kit is authored to its own grid — a Kenney house is 1.3 units
      wide — so `fitLengthM` scales a model by its own bounding box to the length
      the placement asks for, which is what a berth or a footprint actually
      knows.

      Cranes and grandstands are built the same way and wait on coordinates.
      Monaco's stands are temporary and their positions are not in OSM, and
      guessing at them would be inventing data, which is the one thing this
      pipeline does not do.

      **Three corrections to the berthing, all found by looking at the harbour
      from above.**

      *A boat ties to the side of its pontoon, not to the deck's average
      direction.* Berthing along the deck's principal axis is wrong for the
      shape it has to handle: a surveyed pier way is often a comb — several
      catwalks in one ring — or an L, or a quay head barely longer than it is
      wide, and one axis through the middle of that points nowhere. What it drew
      was a fan, boats radiating from a point and crossing each other. Every
      edge longer than 14 m now carries a row perpendicular to itself, so a
      straight edge gives a parallel row whatever the rest of the ring does.
      Outward is asked of the ring rather than taken from its winding, because a
      surveyed way is drawn in whichever direction the mapper walked.

      *A berth is as long as the water in front of it.* Port Hercule's pontoons
      stand about twenty metres apart and an unclamped 46 m hull crossed the gap
      into the row facing it. The water ahead of each berth is probed, and where
      the probe finds the far side the gap belongs to both rows and each takes
      half of it.

      *And hulls are checked against hulls, not sterns against sterns.* A
      distance test between mooring points cannot see the failure it is meant to
      catch: boats on facing pontoons have their sterns twenty metres apart and
      their bows in each other. Oriented rectangles, four separating axes.
      **305 → 164 boats**, and none of them moored through another.

      **A pool and a pitch are surveyed surfaces, not bare ground.** Monaco's
      pool quay renders as bare concrete, and the reason is worth recording
      because it looks like a bake bug and is not: within 130 m of Quai des
      États-Unis OSM holds **zero** building footprints, and along Quai Albert
      1er it holds two. The long halls in the aerial photograph are the Grand
      Prix's own hospitality structures, up for six weeks a year, and nobody
      surveys those. What *is* permanent there is the Stade Nautique, and it is
      mapped — as `leisure=swimming_pool`, which the building query never asked
      for. The single thing the buildings query did find on that quay is
      `way/952067351`, the pool's diving platform, tagged `building=yes`.

      So pools and pitches are fetched with the greenery — the same shape of
      answer, an area that is neither ground nor building — and drawn as a flat
      lid 12 cm above the terrain, fanned from the centroid and **wound by the
      ring's signed area**, since that is the bug that hid every flat roof in
      the city until P4.0b counted them.
- [x] **P4.3** Green ground, and the surfaces on it — `scripts/env/greenery.ts`.

      Greenery arrives from OSM in three resolutions and each is used for what
      it is good for. A surveyed `natural=tree` is a position, and Monaco has
      **662** of them along the streets the circuit runs down. A `tree_row` is a
      line to step along. A park or a wood is an area, and an area says *there
      are trees here*, not where, so trees are scattered over it on a jittered
      lattice — global rather than per-area, so two parks that touch do not
      plant two trees in the same metre.

      **Two things are done with that, at two ranges.** Near the circuit the
      greenery is trees, because a tree is what you see. Beyond 600 m it is a
      colour. The measurement made that decision: at core spacing the green
      areas hold **7 130** plantable points and **5 575** of them are past the
      far belt's boundary — drawing them would have cost a quarter of that
      belt's whole triangle budget to say something no one can resolve. So the
      areas tint the terrain everywhere and grow trees only inside 600 m.

      The tint rides on the vertex colours the AO pass already writes: no
      geometry, no draw call, no material. Sixty per cent of the way to the
      palette's park green, because full saturation reads as a golf course
      dropped into a pale diorama. **12 808 ground nodes** over **153 ha** and
      194 areas.

      **1 290 trees**: 369 surveyed, 7 from rows, 914 scattered, split between
      the core and city belts at the same 150 m the belts use. 79 were refused
      for standing in the road and 43 for standing in the sea. Twenty triangles
      each — a four-sided trunk under a six-sided canopy — which at a thousand
      trees is a fifth of what one belt spends on buildings. **4.12 → 5.04 MB**,
      still inside every per-belt budget.

      **Two corrections, both from the audit.** A trunk on a single base plane
      leaves its downhill corners in the air, exactly as a building does: **217
      of 5 036 corners off the ground, worst 1.91 m**. Each corner now meets its
      own ground and is buried on the uphill side rather than floated on the
      downhill one. Then the check itself was wrong twice over — it measured the
      distance both ways, when a buried foot is what a trunk on a slope has to
      be, and it read the ground at the exact baked position, when quantisation
      moves that sideways by half a metre and a 1:1 slope turns half a metre of
      sideways into half a metre of height. One-sided, and against the highest
      ground within a quantisation step: **0 in the air, worst 0.07 m**.

      **And Overpass would not answer the obvious query.** Asked for trees, rows,
      woods, landuse and parks together it returns **504**; asked as two queries
      it comes back in seconds. The areas are also asked one tag at a time,
      because a regex over `landuse` timed out where nine plain equality clauses
      do not. This mattered more than it sounds: the failing form was returning
      an empty result and the cache was keeping it, so the bake had no greenery
      and said nothing about it.

      **Then the trees came out, and the tint after them.** Looked at in the
      scene the trees read as one six-sided shape repeated a thousand times, and
      a hillside of them said *procedural* louder than it said *trees*. The tint
      that was carrying the same information at range turned out to have the
      same problem seen from the other side: it is paint on the terrain, and it
      says *park* by colouring ground that otherwise looks like every other
      piece of ground. Both are gone, and with them the audit's "trunks reach
      the ground" check and the whole area index. `natural=tree`, `tree_row`,
      woods and lawns are still fetched and now ignored — dropping them from the
      query would invalidate every green cache, which is not a trade worth
      making while Overpass is refusing to answer.

      What is left of this phase is the two things that are objects rather than
      colour: **pools and pitches**, drawn as flat surveyed lids.

      **What replaced the tint is slope.** An open hillside sees the whole sky,
      so the AO pass says nothing about it, and the terrain came out of the field
      one flat colour — the relief was there and unreadable. So the vertex's own
      normal picks a factor on the shade AO already wrote: flat ground keeps its
      colour, and by 55° it is down to 62% of it and warmed slightly, so a cliff
      reads as rock rather than as shadow. Smoothstepped between 12° and 55°, or
      the first degree past flat shows as a band. **85 346 ground nodes** on
      Monaco, no geometry, no draw call, no material.

      Monaco rebaked without any greenery answer at all, which is what the empty
      layer path is for: **4.10 MB**, 19 draw calls to 15, 18/18 audit ok. The
      pool comes back with Overpass.
- [ ] **P4.4** Migrate the remaining 30 circuits, then **delete
      `environment-layer.tsx`** and the old runtime path. This is D17's termination
      condition — the plan is not finished while both paths exist.

      **Started, and the sweep is what found the pipeline's real faults.**
      `bun run env:bake:all` bakes every circuit the app lists, keeps going past
      a failure and prints one table; `bun run env:audit --all` does the same for
      the checks. A run that stops at the first broken circuit tells you about
      one circuit.

      *There is a global elevation provider now* — `scripts/env/skadi.ts`. IGN
      covers France and Monaco, which is one circuit of thirty-one, and the
      constraint that picks the replacement is that this pipeline reads binary
      and nothing else: no GDAL, no PNG decoder, no image library. Terrarium and
      the GeoTIFF pyramid both need one. The same archive ships **Skadi** — SRTM
      void-filled, one file per degree, 3601 x 3601 big-endian int16, gzipped —
      which is a `gunzip` and a `DataView`. The cost is honest: one arc-second is
      about **30 m** where IGN gives 3.9, so the core belt's 4 m cell is
      interpolation outside France and no amount of it invents a quay. What it
      holds is the shape of a landscape, which is what terrain is for.

      *Coverage is claimed by a box and confirmed by the answer.* `covers` is a
      rectangle and a country is not: IGN's box has to hold France, so it also
      holds Belgium, Luxembourg, the Rhineland, Piedmont and Catalonia, where
      IGN has nothing. Spa came out of the first sweep with a raster of **875 280
      nodata and no valid pixel**, a city belt of **zero triangles**, and no
      error anywhere. A provider that answers with an empty raster now hands the
      circuit to the next one that covers it.

      *The corridor is never narrower than the grid it is burned into.* A 16 m
      corridor fell straight through a 30 m cell: the shipped profile stood
      **0.73 m** off ground the burn was supposed to have set, on a stretch with
      a 0.2% gradient — not a slope problem but a resolution one. **0.73 → 0.235
      m**. The audit's tolerance had the same fault and is now a fraction of the
      cell: 0.05 m against 3.9 m is 1.3% of a cell, 0.235 against 30 m is 0.8%.

      *And a meadow is green ground, not a forest.* Silverstone is ringed by
      **750 ha** of farmland tagged `landuse=grass`, and scattering into it
      planted **8 050** trees in fields. Only wood, scrub and park carry trees
      now: 8 050 → 2 203, and the core belt fell from 3.34 MB to 1.46.

      **The worst fault was silence, and it had nothing to do with elevation.**
      Overpass answers a refused or timed-out query with HTTP 200 and an empty
      body, and the cache wrote that down as an answer. Measured by reading the
      shipped GLBs rather than the logs: **22 of 24 circuits baked with zero
      buildings** — Melbourne, Baku, Bahrain, Shanghai, Suzuka, cities with no
      city — and **121 cache files of two bytes** across the repo. Nothing failed.
      Nothing warned.

      Three things came out of that. An empty result is now worth another
      endpoint before it is believed, and is never written to disk, so a later
      run corrects it. Retries back off over minutes rather than fifteen seconds,
      because Overpass hands out query slots per address and a sweep of
      thirty-one circuits spends part of its time locked out. And greenery — the
      one layer a circuit can be baked without — warns instead of failing, which
      is why `--missing-greenery` exists: the green cache is only written on a
      complete answer, so its absence is exactly the question "were the trees
      missed".

      One more, about query weight rather than rate: asked as a single query the
      greenery returns **504**, and split in two it still failed for every bbox
      larger than Monaco's. It is the scan, not the limit — `node["natural"="tree"]`
      over a whole bbox is expensive and a regex over `landuse` more so. Eleven
      plain equality clauses come back in seconds each.

      **Verified so far: `gb-1948` (18/18) and `mc-1929` (19/19).** The rest were
      deleted rather than shipped — a city with no buildings is worse than no
      city — and are waiting on Overpass to answer again.

**Distance limits are off** in `track-viewer.tsx` while the city is being looked
at: inspecting the ground means getting under the eaves and down to street level,
and every one of the old bounds forbade it. They come back with a pass of their
own.

The floor stays, at `PI/2 - 0.02`. Terrain is a surface, not a solid, and its
back faces are culled, so from below the whole city is see-through — the road
shows through the hillside, the water shows through the ground, and the harbour
walls read as dark patches floating in the bay. Every "it goes transparent when I
rotate" report so far has been the camera slipping under the surface it was
looking at.

---
