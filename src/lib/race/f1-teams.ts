/** The ten teams on the 2025 Formula 1 grid, as flat liveries. */

export interface Livery {
  /** Bodywork — the colour that actually identifies the car. */
  body: string;
  /** Wheel rims, and the only place a second team colour appears. */
  accent: string;
}

export type LiverySlot = keyof Livery;

/** Which materials a livery colour applies to, keyed by material name. */
export const LIVERY_SLOT_PATTERNS: Record<LiverySlot, RegExp> = {
  accent: /rim|wheel_hub/i,
  body: /paint|body|livery/i,
};

/** The livery slot a material belongs to, or null for fixed hardware. */
export function liverySlotFor(materialName: string): LiverySlot | null {
  if (LIVERY_SLOT_PATTERNS.accent.test(materialName)) return "accent";
  if (LIVERY_SLOT_PATTERNS.body.test(materialName)) return "body";
  return null;
}

export interface Team {
  /** Filename-safe id; also the model id in the admin library. */
  id: string;
  name: string;
  /** Three-letter code, for standings and timing-style labels. */
  code: string;
  livery: Livery;
  /**
   * The car number, in the team's own colour. It is the livery colour taken
   * to the lightness a small glyph needs on a dark timing row — Ferrari's
   * number is red, not the red the bodywork is painted, which at this size
   * on this background is a smudge. Every one of these clears 4.5:1 against
   * the row, and the numbers carry a dark keyline for the selected row,
   * which is lighter than the rest.
   */
  numberColour: string;
}

export const TEAMS_2025: Team[] = [
  {
    id: "ferrari",
    name: "Ferrari",
    code: "FER",
    // Rosso corsa: deeper and slightly toward crimson.
    livery: { body: "#c8102e", accent: "#f2d600" },
    numberColour: "#ff3345",
  },
  {
    id: "mclaren",
    name: "McLaren",
    code: "MCL",
    livery: { body: "#ff8000", accent: "#3d4046" },
    numberColour: "#ff8000",
  },
  {
    id: "red-bull",
    name: "Red Bull Racing",
    code: "RBR",
    livery: { body: "#1b2a63", accent: "#e8c23a" },
    numberColour: "#6b84ff",
  },
  {
    id: "mercedes",
    name: "Mercedes",
    code: "MER",
    // The real car is black with teal; rendered small on dark asphalt that reads as an absence.
    livery: { body: "#b8c2cc", accent: "#00d7b8" },
    numberColour: "#c3ced9",
  },
  {
    id: "aston-martin",
    name: "Aston Martin",
    code: "AST",
    livery: { body: "#00594f", accent: "#cedc00" },
    numberColour: "#12b8a0",
  },
  {
    id: "alpine",
    name: "Alpine",
    code: "ALP",
    livery: { body: "#0058c8", accent: "#ff6fa8" },
    numberColour: "#2f8dff",
  },
  {
    id: "williams",
    name: "Williams",
    code: "WIL",
    livery: { body: "#1868db", accent: "#e8eef6" },
    numberColour: "#57c8ff",
  },
  {
    id: "racing-bulls",
    name: "Racing Bulls",
    code: "RB",
    livery: { body: "#2b4bd8", accent: "#e8302a" },
    numberColour: "#b9c9ff",
  },
  {
    id: "kick-sauber",
    name: "Kick Sauber",
    code: "SAU",
    livery: { body: "#38e04a", accent: "#2a2d33" },
    numberColour: "#38e04a",
  },
  {
    id: "haas",
    name: "Haas",
    code: "HAA",
    livery: { body: "#e9ecf1", accent: "#c8102e" },
    numberColour: "#eef1f6",
  },
];

/** Cars per team — the grid is two per constructor. */
export const CARS_PER_TEAM = 2;

/** A full grid: twenty cars, in team order. */
export const GRID_SIZE = TEAMS_2025.length * CARS_PER_TEAM;

export interface GridEntry {
  /** Position in the grid, 0-based. */
  index: number;
  team: Team;
  /** 0 or 1 — which of the team's two cars. */
  seat: number;
}

/** The starting grid, as a flat list. */
export function buildGrid(size: number = GRID_SIZE): GridEntry[] {
  const entries: GridEntry[] = [];
  for (let index = 0; index < size; index++) {
    entries.push({
      index,
      team: TEAMS_2025[index % TEAMS_2025.length],
      seat: Math.floor(index / TEAMS_2025.length),
    });
  }
  return entries;
}

export function teamById(id: string): Team | undefined {
  return TEAMS_2025.find((team) => team.id === id);
}
