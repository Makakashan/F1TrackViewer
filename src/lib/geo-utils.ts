/**
 * Geographic helpers — convert WGS84 [lon, lat] to local metric-space [x, z]
 * coordinates suitable for Three.js scenes.
 *
 * Units in the resulting scene are METERS. This matches the `length` property
 * of each circuit, so a track 5 km long will be ~5000 units across in the scene.
 */

import * as THREE from "three";

export interface GeoBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerLon: number;
  centerLat: number;
}

/**
 * Compute the bounding box of a list of [lon, lat] coordinates.
 */
export function computeBounds(coords: [number, number][]): GeoBounds {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return {
    minLon,
    minLat,
    maxLon,
    maxLat,
    centerLon: (minLon + maxLon) / 2,
    centerLat: (minLat + maxLat) / 2,
  };
}

/**
 * Convert a [lon, lat] pair to local metric-space coordinates.
 * The track is centered on its bbox center, north points to -Z, east to +X.
 *
 * Returns a THREE.Vector3 with y = 0 (flat; elevation will come later from
 * TUMFTM data).
 *
 * @param lon           longitude (degrees)
 * @param lat           latitude (degrees)
 * @param centerLon     reference longitude to subtract
 * @param centerLat     reference latitude to subtract
 */
export function lonLatToXZ(
  lon: number,
  lat: number,
  centerLon: number,
  centerLat: number,
): THREE.Vector3 {
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const x = (lon - centerLon) * metersPerDegLon;
  const z = -(lat - centerLat) * metersPerDegLat;
  return new THREE.Vector3(x, 0, z);
}

/**
 * Build a closed CatmullRomCurve3 from a list of [lon, lat] coordinates.
 *
 * The bacinger dataset stores closed LineStrings (first point == last point).
 * We strip the duplicate tail so the curve can be marked `closed=true` instead
 * of passing the same point twice — this avoids a zero-length segment that
 * would otherwise distort the Catmull-Rom tangent.
 *
 * @param coords            raw [lon, lat] from GeoJSON
 * @param bounds            bbox computed by computeBounds()
 * @param elevations        optional per-point elevation in meters (same length
 *                          as `coords` minus the closing duplicate). If
 *                          omitted, the curve is built flat (y = 0).
 * @param elevationScale    vertical exaggeration factor — real elevation
 *                          differences are usually small relative to track
 *                          length, so 2–4× makes hills readable. Default 3.
 * @param elevationOffset   if provided, the curve is shifted vertically so
 *                          that its mean elevation sits at this Y value.
 *                          Defaults to 0 (mean elevation → y = 0).
 */
export function buildTrackCurve(
  coords: [number, number][],
  bounds: GeoBounds,
  elevations?: number[],
  elevationScale: number = 3,
  elevationOffset: number = 0,
): THREE.CatmullRomCurve3 {
  let pts = coords;
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      pts = pts.slice(0, -1);
    }
  }

  // Compute mean elevation so we can center the curve vertically — otherwise
  // tracks at 2000m altitude (Mexico) would sit absurdly high above the ground.
  let meanElevation = 0;
  if (elevations && elevations.length > 0) {
    let sum = 0;
    for (const e of elevations) sum += e;
    meanElevation = sum / elevations.length;
  }

  const points = pts.map(([lon, lat], i) => {
    const v = lonLatToXZ(lon, lat, bounds.centerLon, bounds.centerLat);
    if (elevations && elevations[i] != null) {
      v.y =
        (elevations[i] - meanElevation) * elevationScale + elevationOffset;
    }
    return v;
  });
  // IMPORTANT: centripetal parametrization (instead of uniform 'catmullrom')
  // prevents self-intersections and "loops" when consecutive control points
  // are very close together. This is the root cause of the "track jumps to
  // a random far-away point and breaks" bug we had on street circuits
  // (Monaco, Baku, Singapore, Jeddah) where GeoJSON samples cluster tightly
  // around hairpins.
  return new THREE.CatmullRomCurve3(points, true, "centripetal", 0.5);
}

/**
 * Fetch per-coordinate elevation (in meters above sea level) from the free
 * Open-Meteo Elevation API.
 *
 * - No auth, no rate limit for our use case (~100–500 points per circuit).
 * - Endpoint accepts up to 100 coordinates per request via comma-separated
 *   `latitude` / `longitude` query params.
 * - We chunk into 100-point batches and run them in parallel.
 *
 * Docs: https://open-meteo.com/en/docs#elevation-api
 *
 * @param coords  [lon, lat] array (same array you'd pass to buildTrackCurve).
 *                The closing duplicate point (if any) is sent as-is — the
 *                returned array has the SAME length as `coords`, ready to be
 *                indexed 1:1 inside buildTrackCurve.
 * @returns       array of elevations in meters; null if the API failed.
 */
export async function fetchElevations(
  coords: [number, number][],
): Promise<number[] | null> {
  if (!coords.length) return [];
  const CHUNK_SIZE = 100;
  const chunks: [number, number][][] = [];
  for (let i = 0; i < coords.length; i += CHUNK_SIZE) {
    chunks.push(coords.slice(i, i + CHUNK_SIZE));
  }

  try {
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const lats = chunk.map((c) => c[1]).join(",");
        const lons = chunk.map((c) => c[0]).join(",");
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
        const res = await fetch(url, { next: { revalidate: 86400 } });
        if (!res.ok) throw new Error(`elevation API ${res.status}`);
        const data = (await res.json()) as { elevation: number[] };
        return data.elevation;
      }),
    );
    return results.flat();
  } catch (e) {
    console.warn("Failed to fetch elevations:", e);
    return null;
  }
}

/**
 * Compute simple stats over an elevation array — min, max, total climb
 * (sum of all uphill deltas between consecutive samples). Used by the info
 * panel.
 */
export function elevationStats(elevations: number[]): {
  min: number;
  max: number;
  range: number;
  climb: number;
  descent: number;
  mean: number;
} {
  if (!elevations.length) {
    return { min: 0, max: 0, range: 0, climb: 0, descent: 0, mean: 0 };
  }
  let min = Infinity,
    max = -Infinity,
    sum = 0;
  for (const e of elevations) {
    if (e < min) min = e;
    if (e > max) max = e;
    sum += e;
  }
  let climb = 0,
    descent = 0;
  // Treat the array as a closed loop (last sample → first sample also counts)
  for (let i = 0; i < elevations.length; i++) {
    const a = elevations[i];
    const b = elevations[(i + 1) % elevations.length];
    const d = b - a;
    if (d > 0) climb += d;
    else descent -= d;
  }
  return {
    min,
    max,
    range: max - min,
    climb,
    descent,
    mean: sum / elevations.length,
  };
}

/**
 * Estimate a sensible scene radius (in meters) from the bbox — used to size
 * the ground plane, camera distance, and OrbitControls target.
 */
export function sceneRadiusFromBounds(bounds: GeoBounds): number {
  const widthMeters =
    (bounds.maxLon - bounds.minLon) *
    111_320 *
    Math.cos((bounds.centerLat * Math.PI) / 180);
  const heightMeters = (bounds.maxLat - bounds.minLat) * 111_320;
  return Math.max(widthMeters, heightMeters) / 2;
}
