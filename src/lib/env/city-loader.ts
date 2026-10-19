/** Browser-side loader for the baked city. */

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
    /** Fractions of lap length where the road runs under the ground. */
    buried?: [number, number][];
  };
  attribution: string;
  generatedAt: string;
}

function cityBaseUrl(circuitId: string): string {
  return `/environments/${encodeURIComponent(circuitId)}`;
}

export function cityBeltUrl(circuitId: string, belt: CityBelt): string {
  return `${cityBaseUrl(circuitId)}/${belt}.glb`;
}

/** A circuit with a manifest takes the baked path; without one, the runtime diorama. */
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
