/**
 * Color palette for the MVP3 low-poly diorama.
 *
 * Reference look: white architectural model of the city on a pale
 * map-board base, with water kept dark and the F1 track painted on top.
 */
export const DIORAMA_COLORS = {
  base: "#E8EBF1",
  grid: "#C4CBD8",
  terrain: "#E8E8E8",
  terrainVerticalScale: 0.6,
  building: "#E8EAEE",
  buildingSide: "#C8CCD4",
  water: "#1F2937",
  waterTop: "#2A3441",
  road: "#4B5563",
  landusePark: "#D8E4D0",
  landuseWood: "#C9D6BF",
  landuseGrass: "#E5EBDC",
  landuseResidential: "#EAEAEA",
  landuseCommercial: "#E0E0E0",
  landuseIndustrial: "#D2D2D2",
  landuseOther: "#DEDEDE",
  track: "#D7262E",
} as const;

/**
 * Returns the diorama landuse color for a given landuse kind.
 */
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
