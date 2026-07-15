/**
 * Track markers — sector split positions derived from FastF1 telemetry
 * or entered manually. Stored as static JSON under public/track-markers/.
 */

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export interface SectorDefinition {
  id: number;
  fromDistance: number;
  toDistance: number;
  color: string;
}

export interface TrackMarkers {
  circuitId: string;
  source: "fastf1-telemetry-derived" | "equal-thirds" | "manual" | "estimated";
  year?: number;
  event?: string;
  session?: string;
  driver?: string;
  lapNumber?: number;
  lapLengthMeters: number;
  startFinish: {
    s: number;
    verified: boolean;
  };
  directionSign: 1 | -1;
  verification?: {
    startFinish: boolean;
    direction: boolean;
    sectors: boolean;
  };
  sectors: SectorDefinition[];
  confidence?: "high" | "medium" | "low";
}

export type TrackViewMode = "normal" | "sectors";

/**
 * Sector colors used when painting the track in sector mode.
 */
export const SECTOR_COLORS = {
  sector1: "#00A3FF", // blue
  sector2: "#B66DFF", // violet
  sector3: "#00D084", // mint
} as const;

/**
 * Marker colors for split lines and other overlays.
 */
export const MARKER_COLORS = {
  sectorSplit: "#FFFFFF",
  startFinish: "#FFFFFF",
  directionArrow: "#FFD400",
} as const;

/**
 * Fetch track markers (sector definitions) for a given circuit.
 * Returns null if markers are not available for this circuit.
 */
export async function fetchTrackMarkers(
  circuitId: string,
): Promise<TrackMarkers | null> {
  try {
    const res = await fetch(
      `${PUBLIC_BASE_PATH}/track-markers/${encodeURIComponent(circuitId)}.json`,
      { cache: "no-cache" },
    );
    if (!res.ok) return null;
    return (await res.json()) as TrackMarkers;
  } catch {
    return null;
  }
}

/**
 * Convert a real-world distance (meters from start/finish) along the track
 * to a normalized curve parameter s ∈ [0, 1).
 *
 * The start/finish line is at startFinishS on the curve. directionSign
 * determines which direction distances increase:
 *   +1 → increasing s (clockwise in typical mapping)
 *   -1 → decreasing s (counter-clockwise)
 */
export function distanceToCurveS(
  distance: number,
  lapLengthMeters: number,
  startFinishS: number,
  directionSign: 1 | -1,
): number {
  const fraction = distance / lapLengthMeters; // 0..1
  if (directionSign === 1) {
    return wrap01(startFinishS + fraction);
  } else {
    return wrap01(startFinishS - fraction);
  }
}

/**
 * Wrap a value into [0, 1).
 */
function wrap01(value: number): number {
  return ((value % 1) + 1) % 1;
}

/**
 * Compute the "arc length" fraction of a sector in curve-space.
 * Returns the fraction of the full curve that this sector spans.
 */
export function sectorArcFraction(
  fromS: number,
  toS: number,
  directionSign: 1 | -1,
): number {
  if (directionSign === 1) {
    return wrap01(toS - fromS);
  } else {
    return wrap01(fromS - toS);
  }
}
