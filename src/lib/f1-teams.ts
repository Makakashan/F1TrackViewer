/**
 * The ten teams on the 2025 Formula 1 grid, as flat liveries.
 *
 * Single source of truth for both ends: the build scripts read it to bake
 * per-team .glb files, and the runtime reads it to tint instances of one shared
 * model. Shipping ten files that differ only in two colours would cost ten
 * times the download for nothing.
 *
 * These are approximations, not reproductions. The car model carries no sponsor
 * geometry — scripts/optimize-car-model.ts deletes the logo shells — so a livery
 * here is two colours: the bodywork and the rims. That is enough to tell twenty
 * cars apart at the distance the viewer renders them, which is the requirement.
 *
 * Colours are picked to read against dark asphalt rather than to match a paint
 * code. Several 2025 cars are predominantly black; those use the team's
 * signature colour as bodywork instead, because a black car on a dark track is
 * a silhouette.
 */

export interface Livery {
  /** Bodywork — the colour that actually identifies the car. */
  body: string;
  /** Wheel rims, and the only place a second team colour appears. */
  accent: string;
}

export type LiverySlot = keyof Livery;

/**
 * Which materials a livery colour applies to, keyed by material name.
 *
 * Defined here rather than in the build script because both ends need to
 * agree: the script bakes these colours into per-team files, and the runtime
 * overrides the same two slots on instances of one shared model. If the two
 * used different patterns, a car tinted at runtime would not match the same
 * car baked at build time.
 */
export const LIVERY_SLOT_PATTERNS: Record<LiverySlot, RegExp> = {
  accent: /rim|wheel_hub/i,
  body: /paint|body|livery/i,
};

/**
 * The livery slot a material belongs to, or null for fixed hardware.
 *
 * Accent is tested first: a wheel material named "rim_paint" is a rim, not
 * bodywork.
 */
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
}

export const TEAMS_2025: Team[] = [
  {
    id: "ferrari",
    name: "Ferrari",
    code: "FER",
    // Rosso corsa: deeper and slightly toward crimson, where the project's own
    // brand red sits noticeably orange. Yellow rims carry the rest of it.
    livery: { body: "#c8102e", accent: "#f2d600" },
  },
  {
    id: "mclaren",
    name: "McLaren",
    code: "MCL",
    livery: { body: "#ff8000", accent: "#3d4046" },
  },
  {
    id: "red-bull",
    name: "Red Bull Racing",
    code: "RBR",
    livery: { body: "#1b2a63", accent: "#e8c23a" },
  },
  {
    id: "mercedes",
    name: "Mercedes",
    code: "MER",
    // The real car is black with teal; rendered small on dark asphalt that
    // reads as an absence, so the silver takes the bodywork.
    livery: { body: "#b8c2cc", accent: "#00d7b8" },
  },
  {
    id: "aston-martin",
    name: "Aston Martin",
    code: "AST",
    livery: { body: "#00594f", accent: "#cedc00" },
  },
  {
    id: "alpine",
    name: "Alpine",
    code: "ALP",
    livery: { body: "#0058c8", accent: "#ff6fa8" },
  },
  {
    id: "williams",
    name: "Williams",
    code: "WIL",
    livery: { body: "#1868db", accent: "#e8eef6" },
  },
  {
    id: "racing-bulls",
    name: "Racing Bulls",
    code: "RB",
    livery: { body: "#2b4bd8", accent: "#e8302a" },
  },
  {
    id: "kick-sauber",
    name: "Kick Sauber",
    code: "SAU",
    livery: { body: "#38e04a", accent: "#2a2d33" },
  },
  {
    id: "haas",
    name: "Haas",
    code: "HAA",
    livery: { body: "#e9ecf1", accent: "#c8102e" },
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

/**
 * The starting grid, as a flat list. Teams alternate rather than pairing up so
 * that a partial grid — the first eight cars, say — still shows eight
 * different liveries instead of four teams twice.
 */
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
