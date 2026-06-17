import {
  normalizeElevationProfile,
  sampleElevationCoords,
  interpolateElevations,
} from "./elevation";

const ELEVATION_CACHE_VERSION = 2;
const ELEVATION_CACHE_PREFIX = `f1tv:elevations:v${ELEVATION_CACHE_VERSION}:`;
const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function elevationCacheKey(coords: [number, number][]): string {
  let hash = 5381;
  for (const [lon, lat] of coords) {
    const part = `${lon.toFixed(6)},${lat.toFixed(6)};`;
    for (let i = 0; i < part.length; i++) {
      hash = ((hash << 5) + hash + part.charCodeAt(i)) | 0;
    }
  }
  return `${ELEVATION_CACHE_PREFIX}${coords.length}:${(hash >>> 0).toString(36)}`;
}

function readElevationCache(coords: [number, number][]): number[] | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(elevationCacheKey(coords));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { elevations?: unknown };
    if (!Array.isArray(parsed.elevations)) return null;

    const elevations = parsed.elevations;
    if (
      elevations.length !== coords.length ||
      elevations.some((value) => !Number.isFinite(value))
    ) {
      return null;
    }

    return elevations as number[];
  } catch {
    return null;
  }
}

function writeElevationCache(
  coords: [number, number][],
  elevations: number[],
): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      elevationCacheKey(coords),
      JSON.stringify({ elevations }),
    );
  } catch {
    // Best-effort cache. Browsers can reject localStorage in private mode or
    // when storage quota is full; the viewer still works without persistence.
  }
}

async function fetchStaticElevationProfile(
  circuitId: string,
  coords: [number, number][],
): Promise<number[] | null> {
  try {
    const res = await fetch(
      `${PUBLIC_BASE_PATH}/elevations/${encodeURIComponent(circuitId)}.json?v=${ELEVATION_CACHE_VERSION}`,
      { cache: "no-cache" },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      elevations?: unknown;
      version?: number;
    };
    if (
      data.version !== ELEVATION_CACHE_VERSION ||
      !Array.isArray(data.elevations) ||
      data.elevations.length !== coords.length ||
      data.elevations.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    ) {
      return null;
    }

    const elevations = data.elevations as number[];
    writeElevationCache(coords, elevations);
    return elevations;
  } catch {
    return null;
  }
}

/** Fetch elevation from Open-Meteo API (max 64 samples, interpolated). Falls back to static JSON, then localStorage cache. */
export async function fetchElevations(
  coords: [number, number][],
  circuitId?: string,
): Promise<number[] | null> {
  if (!coords.length) return [];
  if (circuitId) {
    const staticElevations = await fetchStaticElevationProfile(circuitId, coords);
    if (staticElevations) return staticElevations;
  }

  const cached = readElevationCache(coords);
  if (cached) return cached;

  const sampled = sampleElevationCoords(coords);

  try {
    const lats = sampled.coords.map((c) => c[1]).join(",");
    const lons = sampled.coords.map((c) => c[0]).join(",");
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    const res = await fetch(url, { next: { revalidate: 86400 } });
    if (!res.ok) throw new Error(`elevation API ${res.status}`);

    const data = (await res.json()) as {
      elevation?: number[];
      reason?: string;
      error?: boolean;
    };
    if (
      data.error ||
      !Array.isArray(data.elevation) ||
      data.elevation.length !== sampled.coords.length
    ) {
      throw new Error(data.reason ?? "invalid elevation API response");
    }

    const normalizedSamples = normalizeElevationProfile(
      data.elevation,
      sampled.coords,
    );
    const elevations = interpolateElevations(
      sampled.distances,
      normalizedSamples,
      sampled.fullDistances,
      sampled.hasClosingDuplicate,
    );
    writeElevationCache(coords, elevations);
    return elevations;
  } catch (e) {
    console.warn("Failed to fetch elevations:", e);
    return null;
  }
}

export async function fetchElevationsFromOpenTopoData(
  coords: [number, number][],
): Promise<number[] | null> {
  if (!coords.length) return [];
  const sampled = sampleElevationCoords(coords);

  try {
    const locations = sampled.coords.map((c) => `${c[1]},${c[0]}`).join("|");
    const url = `https://api.opentopodata.org/v1/mapzen?locations=${encodeURIComponent(locations)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OpenTopoData API ${res.status}`);

    const data = (await res.json()) as {
      status?: string;
      error?: string;
      results?: Array<{ elevation?: number | null }>;
    };
    if (
      data.status !== "OK" ||
      !Array.isArray(data.results) ||
      data.results.length !== sampled.coords.length
    ) {
      throw new Error(data.error ?? "invalid OpenTopoData API response");
    }

    const sampleElevations = data.results.map((result) => result.elevation);
    if (sampleElevations.some((value) => !Number.isFinite(value))) {
      throw new Error("OpenTopoData returned missing elevations");
    }

    const normalizedSamples = normalizeElevationProfile(
      sampleElevations as number[],
      sampled.coords,
    );
    const elevations = interpolateElevations(
      sampled.distances,
      normalizedSamples,
      sampled.fullDistances,
      sampled.hasClosingDuplicate,
    );
    writeElevationCache(coords, elevations);
    return elevations;
  } catch (e) {
    console.warn("Failed to fetch OpenTopoData elevations:", e);
    return null;
  }
}
