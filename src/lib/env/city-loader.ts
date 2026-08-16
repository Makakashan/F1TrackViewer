/** Browser-side loader for the baked city (docs/city-generation.md D14). */

export type CityBelt = "far" | "city" | "core";

/** Far first, so the scene is never empty while the detail arrives. */
export const CITY_BELT_ORDER: CityBelt[] = ["far", "city", "core"];

export interface CityBeltInfo {
  file: string;
  bytes: number;
  triangles: number;
  drawCalls: number;
  radiusM: number | null;
  cellM: number;
}

export interface CityManifest {
  schemaVersion: 2;
  circuitId: string;
  style: "city";
  /** Heights are metres above sea level, so the scene's Y is the real Y. */
  datum: "msl";
  origin: { lon: number; lat: number };
  bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  belts: Record<CityBelt, CityBeltInfo>;
  counts: { buildings: number; triangles: number; drawCalls: number };
  track: {
    /** One height per centreline vertex, closing duplicate dropped. */
    elevations: number[];
    halfWidthM: number;
  };
  attribution: string;
  generatedAt: string;
}

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function cityBaseUrl(circuitId: string): string {
  return `${PUBLIC_BASE_PATH}/environments/${encodeURIComponent(circuitId)}`;
}

export function cityBeltUrl(circuitId: string, belt: CityBelt): string {
  return `${cityBaseUrl(circuitId)}/${belt}.glb`;
}

/**
 * The manifest is the gate: a circuit with one is baked and takes the new path,
 * a circuit without one keeps the runtime diorama (D17).
 */
export async function fetchCityManifest(circuitId: string): Promise<CityManifest | null> {
  try {
    const res = await fetch(`${cityBaseUrl(circuitId)}/city-manifest.json`, {
      cache: "no-cache",
    });
    if (!res.ok) return null;
    const manifest = (await res.json()) as CityManifest;
    if (manifest?.schemaVersion !== 2) return null;
    return manifest;
  } catch {
    return null;
  }
}
