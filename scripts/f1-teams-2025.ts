/**
 * The ten teams on the 2025 Formula 1 grid, as flat liveries.
 *
 * These are approximations, not reproductions. The car model carries no
 * sponsor geometry — scripts/optimize-car-model.ts deletes the logo shells —
 * so a livery here is two colours: the bodywork, and the rims. That is enough
 * to tell ten cars apart at the distance the viewer renders them, which is the
 * whole requirement.
 *
 * Colours are picked to read correctly against dark asphalt rather than to
 * match a paint code. Several 2025 cars are predominantly black (Mercedes,
 * Kick Sauber, and Racing Bulls over much of their surface); those use the
 * team's signature accent as bodywork instead, because a black car on a dark
 * track is a silhouette.
 */

import type { Livery } from "./optimize-car-model";

export interface Team {
  /** Filename-safe id; also the model id in the library. */
  id: string;
  name: string;
  livery: Livery;
}

export const TEAMS_2025: Team[] = [
  {
    id: "ferrari",
    name: "Ferrari",
    // Rosso corsa: deeper and slightly toward crimson, where the project's own
    // brand red sits noticeably orange. Yellow rims carry the rest of it.
    livery: { body: "#c8102e", accent: "#f2d600" },
  },
  {
    id: "mclaren",
    name: "McLaren",
    livery: { body: "#ff8000", accent: "#3d4046" },
  },
  {
    id: "red-bull",
    name: "Red Bull Racing",
    livery: { body: "#1b2a63", accent: "#e8c23a" },
  },
  {
    id: "mercedes",
    name: "Mercedes",
    // The real car is black with teal; rendered small on dark asphalt that
    // reads as an absence, so the silver takes the bodywork.
    livery: { body: "#b8c2cc", accent: "#00d7b8" },
  },
  {
    id: "aston-martin",
    name: "Aston Martin",
    livery: { body: "#00594f", accent: "#cedc00" },
  },
  {
    id: "alpine",
    name: "Alpine",
    livery: { body: "#0058c8", accent: "#ff6fa8" },
  },
  {
    id: "williams",
    name: "Williams",
    livery: { body: "#1868db", accent: "#e8eef6" },
  },
  {
    id: "racing-bulls",
    name: "Racing Bulls",
    livery: { body: "#2b4bd8", accent: "#e8302a" },
  },
  {
    id: "kick-sauber",
    name: "Kick Sauber",
    livery: { body: "#38e04a", accent: "#2a2d33" },
  },
  {
    id: "haas",
    name: "Haas",
    livery: { body: "#e9ecf1", accent: "#c8102e" },
  },
];
