/** Color palette for the F1 TV style low-poly diorama. */
export const DIORAMA_COLORS = {
  base: "#D8DCE2",
  grid: "#AEB5C0",
  terrain: "#ECEEF1",
  terrainVerticalScale: 0.6,
  building: "#F4F6F8",
  buildingSide: "#D5DAE1",
  water: "#1F6D91",
  waterTop: "#28A6D9",
  road: "#808893",
  landusePark: "#3C9B3B",
  landuseWood: "#247033",
  landuseGrass: "#55B34A",
  landuseResidential: "#E6E8EB",
  landuseCommercial: "#D9DDE2",
  landuseIndustrial: "#C9CED6",
  landuseOther: "#DDE1E6",
  // The cut face of the block the diorama is carved from: darker than the ground
  // on top, or the sides read as more paper.
  plinth: "#8E949C",
  track: "#D90416",
} as const;

/** Returns the diorama landuse color for a given landuse kind. */
export function landuseColor(kind: string): string {
  switch (kind) {
    case "park":
      return DIORAMA_COLORS.landusePark;
    case "wood":
      return DIORAMA_COLORS.landuseWood;
    case "grass":
      return DIORAMA_COLORS.landuseGrass;
    case "residential":
      return DIORAMA_COLORS.landuseResidential;
    case "commercial":
      return DIORAMA_COLORS.landuseCommercial;
    case "industrial":
      return DIORAMA_COLORS.landuseIndustrial;
    default:
      return DIORAMA_COLORS.landuseOther;
  }
}

/** The mesh kinds the bake writes, one material each. */
export type BakedMeshKind =
  | "terrain"
  | "building"
  | "water"
  | "tunnel"
  | "portal"
  | "shore"
  | "pier"
  | "barrier"
  | "prop"
  | "propDark"
  | "model"
  | "pool"
  | "pitch"
  | "plinth"
  | "boreRoad"
  | "park";

/**
 * What each baked mesh is painted, per theme.
 *
 * The bake writes the light set into the GLB's base-colour factors, so a light
 * scene needs no work at load; the dark set is applied over the loaded
 * materials by `city-layer.tsx`. Both live here so the two cannot drift, and so
 * the answer to "why is the city white in the dark theme" is one file.
 *
 * `model` is white in the light set on purpose — a merged kit house carries its
 * colour per vertex, and the material multiplies over it. Its dark value is a
 * tint over that vertex colour rather than a colour of its own.
 */
export const BAKED_MESH_COLORS: Record<"light" | "dark", Record<BakedMeshKind, string>> = {
  light: {
    terrain: DIORAMA_COLORS.terrain,
    // A deck is ground you can walk on, not a wall, so it reads as terrain.
    pier: DIORAMA_COLORS.terrain,
    building: DIORAMA_COLORS.building,
    water: DIORAMA_COLORS.water,
    // Not black: a black bore reads as a hole painted on the hill, because
    // nothing in it changes with depth. Dark enough to stay a tunnel.
    tunnel: "#23272D",
    portal: DIORAMA_COLORS.buildingSide,
    shore: DIORAMA_COLORS.buildingSide,
    barrier: "#C9CFD6",
    prop: DIORAMA_COLORS.building,
    model: "#FFFFFF",
    pool: DIORAMA_COLORS.waterTop,
    pitch: DIORAMA_COLORS.landuseGrass,
    // Barely green: the planting is the trees standing on it, and a park read
    // as a green shape on grey was the same paint the ground tint was. A
    // quarter of the way from the ground to the wood's green is enough to say
    // "this is not pavement" and little enough not to be a patch.
    park: "#CEDBD2",
    plinth: DIORAMA_COLORS.plinth,
    // The road going in, which is what says the hole leads somewhere.
    boreRoad: "#4A4F56",
    // A hull, a crane leg, a stand frame: what sits below the deck line.
    propDark: DIORAMA_COLORS.buildingSide,
  },
  dark: {
    // The light set at 32 % of its linear luminance, with a slight cool tilt on
    // the greys. Measured, not eyeballed: keeping the light palette's own spread
    // between kinds is what keeps the form readable. A hand-picked dark set of
    // the same mean came out flat — over the default view, mean 42 with sd 19
    // against 54 with sd 31 here — because terrain and buildings had drifted to
    // nearly the same value. The light set reads 108 with sd 47.
    terrain: "#8B8E95",
    pier: "#8B8E95",
    building: "#909399",
    water: "#0E3F55",
    tunnel: "#101317",
    portal: "#7D828A",
    shore: "#7D828A",
    barrier: "#757B83",
    prop: "#909399",
    // A tint over the kit house's own vertex colour, not a colour of its own.
    model: "#96999D",
    pool: "#146282",
    pitch: "#306A29",
    plinth: "#51565E",
    boreRoad: "#282C32",
    park: "#8FA398",
    propDark: "#7D828A",
  },
};
