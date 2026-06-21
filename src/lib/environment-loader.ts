/**
 * Browser-side loader for pre-generated environment bundles.
 *
 * Files live at `${PUBLIC_BASE_PATH}/environments/${circuitId}/*.json` and
 * are produced by `scripts/generate-environment.ts`. The browser never calls
 * Overpass or Open-Meteo directly — the diorama is fully static.
 */

import type {
  BuildingsFile,
  EnvironmentBundle,
  EnvironmentManifest,
  LanduseFile,
  RoadsFile,
  SurfaceFile,
  TerrainFile,
  WaterFile,
} from "./environment-types";

const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * Circuits that ship a pre-generated diorama under public/environments/. Gating
 * on this avoids a 404 in the console for every circuit without a bundle.
 */
export const ENVIRONMENT_CIRCUIT_IDS = new Set(["mc-1929"]);

export function hasEnvironmentBundle(circuitId: string): boolean {
  return ENVIRONMENT_CIRCUIT_IDS.has(circuitId);
}

function environmentBaseUrl(circuitId: string): string {
  return `${PUBLIC_BASE_PATH}/environments/${encodeURIComponent(circuitId)}`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Try to load a complete environment bundle for a circuit.
 * Returns null if any of the manifest or buildings file is missing — those
 * are required for the diorama to render at all. Terrain/water/roads/landuse
 * fall back to empty if absent.
 */
export async function fetchEnvironmentBundle(
  circuitId: string,
): Promise<EnvironmentBundle | null> {
  if (!ENVIRONMENT_CIRCUIT_IDS.has(circuitId)) return null;
  const base = environmentBaseUrl(circuitId);

  const manifest = await fetchJson<EnvironmentManifest>(`${base}/manifest.json`);
  if (!manifest) return null;

  const [buildings, water, roads, landuse, terrain, surface] = await Promise.all([
    fetchJson<BuildingsFile>(`${base}/buildings.json`),
    fetchJson<WaterFile>(`${base}/water.json`),
    fetchJson<RoadsFile>(`${base}/roads.json`),
    fetchJson<LanduseFile>(`${base}/landuse.json`),
    fetchJson<TerrainFile>(`${base}/terrain.json`),
    fetchJson<SurfaceFile>(`${base}/surface.json`),
  ]);

  if (!buildings) return null;

  return {
    manifest,
    buildings,
    water: water ?? { schemaVersion: 1, circuitId, polygons: [] },
    roads: roads ?? { schemaVersion: 1, circuitId, roads: [] },
    landuse: landuse ?? { schemaVersion: 1, circuitId, polygons: [] },
    terrain: terrain ?? {
      schemaVersion: 1,
      circuitId,
      gridSize: 0,
      widthMeters: 0,
      heightMeters: 0,
      minElevation: 0,
      maxElevation: 0,
      heights: [],
    },
    surface,
  };
}

/**
 * Check whether a manifest exists for a circuit without downloading the whole
 * bundle. Used to gate the Environment toggle in the UI.
 */
export async function hasEnvironment(circuitId: string): Promise<boolean> {
  if (!ENVIRONMENT_CIRCUIT_IDS.has(circuitId)) return false;
  try {
    const res = await fetch(
      `${environmentBaseUrl(circuitId)}/manifest.json`,
      { method: "GET", cache: "no-cache" },
    );
    return res.ok;
  } catch {
    return false;
  }
}
