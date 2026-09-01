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
