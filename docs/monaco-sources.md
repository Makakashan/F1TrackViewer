# Monaco: sources checked for the bake

What the terrain and heights stand on, what was verified against reality, and
what is still approximation. All open licences below allow baking; the photo
sources are look-only.

## Elevation

- IGN RGE ALTI 1 m (https://www.data.gouv.fr/datasets/rge-alti-r) — Licence
  Ouverte 2.0. Covers metropolitan France only: Beausoleil, Cap-d'Ail and the
  Tête de Chien slopes are in, Monaco proper is not. Updates stopped 2024
  pending LiDAR HD. Not adopted: nothing open covers the Principality itself.
- IGN LiDAR HD MNT 0.5 m (https://www.data.gouv.fr/datasets/mnt-lidar-hd) —
  Licence Ouverte 2.0, national programme due 2026. Same border problem: French
  communes yes, Monaco no. Candidate for the French slopes when a tile reaches
  the border; measure against the 3.9 m field first.
- Monaco DPUM / urbamonaco.gouv.mc — the Principality's own cadastre and a 3D
  "jumeau numérique" fed by mandatory project models (CCTP 3D since 2010).
  Consultable, not open: pro login only. No downloadable DTM found.
- Copernicus DEM GLO-30 — global fallback, 30 m: coarser than the 3.9 m field
  in use. Not adopted.

Still approximation: the field over Monaco is the 3.9 m DTM in use. It predates
the Mareterra reclamation (delivered 2024, Renzo Piano): 15 buildings of Le
Renzo I/II stand on what the raster calls sea and are dropped. Fixing that
takes either a Monaco source above or hand `terrainPoints` in
`public/environments/mc-1929/overrides.json`.

## Building heights

MNH (surface minus terrain, 75th percentile in the footprint) verified against
published heights:

- Tour Odéon 170 m / 49 floors (https://www.odeon.mc/en/la-tour-odeon.html,
  https://en.wikipedia.org/wiki/Tour_Odeon) — bakes at ~169 m.
- Le Millefiori 111 m / 37 floors, 1 rue des Genêts
  (https://fr.wikipedia.org/wiki/Tour_Le_Millefiori,
  https://mapcarta.com/W94399978) — bakes at 111 m.
- Le Mirabeau 81 m / 26 floors, 2 av. des Citronniers
  (https://en.wikipedia.org/wiki/Le_Mirabeau, https://mapcarta.com/W94399524)
  — bakes at 81 m.
- L'Annonciade 111 m, Parc Saint Roman 108 m, Périgord I/II 93 m, Roccabella
  and Simona 90 m (https://www.skyscrapercenter.com/city/monaco,
  https://www.miells.com/living-in-monaco/news/tallest-buildings-in-monaco/).

MNH reads above local ground, so on slopes it sits below the architectural
figure (measured from the lowest entrance); the three checks above show the
gap is a metre, not a storey. OSM tags remain the fallback (672 buildings).

## Walls, coast, street truth

- OSM `barrier=retaining_wall`, `natural=cliff`, `man_made=quay`,
  `natural=coastline`, `natural=beach` (ODbL) — the lines the mesh is cut
  against. Larvotto's surveyed line and the raster sit up to 45 m apart where
  the beach moved; the bake follows the line and the raster keeps the beach,
  which is the remaining slit.
- Google Photorealistic 3D Tiles / Apple / Bing 3D: reference only, never
  baked (their terms forbid extraction). Used to look at Beau Rivage stacking,
  the Fairmont slab over the west portal, and the Basse Corniche walls.
