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
 * Baked mesh colours per theme. The light set is in the GLB, the dark set is applied
 * by `city-layer.tsx`. `model` is white because kit houses carry vertex colour.
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
    barrier: "#C9CFD6",
    prop: DIORAMA_COLORS.building,
    model: "#FFFFFF",
    pool: DIORAMA_COLORS.waterTop,
    pitch: DIORAMA_COLORS.landuseGrass,
    // Barely green: a quarter of the way from ground to wood, enough to say "not pavement".
    park: "#CEDBD2",
    plinth: DIORAMA_COLORS.plinth,
    // The road going in, which is what says the hole leads somewhere.
    boreRoad: "#4A4F56",
    // A hull, a crane leg, a stand frame: what sits below the deck line.
    propDark: DIORAMA_COLORS.buildingSide,
  },
  dark: {
    // The light set at 32% luminance with a cool tilt, keeping its spread between kinds
    // so the form stays readable.
    terrain: "#8B8E95",
    pier: "#8B8E95",
    building: "#909399",
    water: "#0E3F55",
    tunnel: "#101317",
    portal: "#7D828A",
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
