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

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const meanLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos(meanLat);
  const dx = (b[0] - a[0]) * metersPerDegLon;
  const dz = (b[1] - a[1]) * metersPerDegLat;
  return Math.hypot(dx, dz);
}

function localMedian(values: number[], index: number, radius: number): number {
  const n = values.length;
  const window: number[] = [];
  for (let offset = -radius; offset <= radius; offset++) {
    window.push(values[(index + offset + n) % n]);
  }
  return median(window);
}

function segmentDistances(
  count: number,
  coords?: [number, number][],
): number[] {
  return Array.from({ length: count }, (_, i) => {
    const next = (i + 1) % count;
    if (!coords?.[i] || !coords[next]) return 20;
    const d = distanceMeters(coords[i], coords[next]);
    return d > 0.01 ? d : 0.01;
  });
}

function smoothByTrackDistance(
  values: number[],
  segments: number[],
  radiusMeters: number,
  passes: number,
): number[] {
  const n = values.length;
  let cur = values.slice();

  for (let pass = 0; pass < passes; pass++) {
    const next = new Array<number>(n);

    for (let i = 0; i < n; i++) {
      let weightedSum = cur[i];
      let totalWeight = 1;

      let dist = 0;
      for (let step = 1; step < n; step++) {
        const segmentIndex = (i - step + n) % n;
        dist += segments[segmentIndex];
        if (dist > radiusMeters) break;
        const weight = 1 - dist / radiusMeters;
        weightedSum += cur[(i - step + n) % n] * weight;
        totalWeight += weight;
      }

      dist = 0;
      for (let step = 1; step < n; step++) {
        const segmentIndex = (i + step - 1) % n;
        dist += segments[segmentIndex];
        if (dist > radiusMeters) break;
        const weight = 1 - dist / radiusMeters;
        weightedSum += cur[(i + step) % n] * weight;
        totalWeight += weight;
      }

      next[i] = weightedSum / totalWeight;
    }

    cur = next;
  }

  return cur;
}

function limitTrackGrade(values: number[], segments: number[]): number[] {
  const n = values.length;
  let cur = values.slice();
  const maxGrade = 0.2;

  for (let pass = 0; pass < 4; pass++) {
    for (const direction of [1, -1]) {
      const indices =
        direction === 1
          ? Array.from({ length: n }, (_, i) => i)
          : Array.from({ length: n }, (_, i) => n - 1 - i);

      for (const i of indices) {
        const prev = (i - direction + n) % n;
        const segmentIndex = direction === 1 ? prev : i;
        const maxDelta = Math.max(0.5, segments[segmentIndex] * maxGrade);
        const delta = cur[i] - cur[prev];
        if (Math.abs(delta) > maxDelta) {
          cur[i] = cur[prev] + Math.sign(delta) * maxDelta;
        }
      }
    }
  }

  return cur;
}

/**
 * Open-Meteo's SRTM samples can jump between adjacent grid cells on very tight
 * street circuits. Monaco is the pathological case: points only a few meters
 * apart can alternate between sea-level values and 40m+ hillside values.
 *
 * Keep the broad elevation trend, but remove physically impossible local
 * steps. The grade cap is intentionally generous; real F1 track slopes stay
 * well below this, while bad Monaco samples produce near-vertical walls.
 */
export function normalizeElevationProfile(
  elevations: number[],
  coords?: [number, number][],
): number[] {
  if (elevations.length < 3) return elevations.slice();

  const finite = elevations.filter(Number.isFinite);
  const fallback = median(finite);
  let cur = elevations.map((value) =>
    Number.isFinite(value) ? value : fallback,
  );
  const n = cur.length;
  const segments = segmentDistances(n, coords);

  const globalMedian = median(cur);
  const mad = median(cur.map((value) => Math.abs(value - globalMedian)));
  const statisticalLimit = Math.max(6, Math.min(14, 2.5 * mad));

  for (let pass = 0; pass < 3; pass++) {
    const next = cur.slice();
    for (let i = 0; i < n; i++) {
      const local = localMedian(cur, i, 4);
      const gradeLimit =
        Math.max(1.25, segments[(i - 1 + n) % n] * 0.18) +
        Math.max(1.25, segments[i] * 0.18);
      const limit = Math.min(statisticalLimit, gradeLimit);

      if (Math.abs(cur[i] - local) > limit) {
        next[i] = local;
      }
    }
    cur = next;
  }

  cur = smoothByTrackDistance(cur, segments, 45, 1);
  cur = limitTrackGrade(cur, segments);

  return cur;
}

function withoutClosingDuplicate(coords: [number, number][]): [number, number][] {
  if (coords.length < 2) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return coords.slice(0, -1);
  }
  return coords;
}

function cumulativeDistances(coords: [number, number][]): number[] {
  const distances = new Array<number>(coords.length).fill(0);
  for (let i = 1; i < coords.length; i++) {
    distances[i] = distances[i - 1] + distanceMeters(coords[i - 1], coords[i]);
  }
  return distances;
}

function sampleElevationCoords(coords: [number, number][]): {
  coords: [number, number][];
  distances: number[];
  fullDistances: number[];
  hasClosingDuplicate: boolean;
} {
  const hasClosingDuplicate =
    coords.length > 1 &&
    coords[0][0] === coords[coords.length - 1][0] &&
    coords[0][1] === coords[coords.length - 1][1];
  const uniqueCoords = withoutClosingDuplicate(coords);
  const fullDistances = cumulativeDistances(uniqueCoords);
  const sampleCount = Math.min(uniqueCoords.length, 64);
  const indexes = Array.from({ length: sampleCount }, (_, i) => {
    if (sampleCount === 1) return 0;
    return Math.round((i / (sampleCount - 1)) * (uniqueCoords.length - 1));
  });
  const uniqueIndexes = [...new Set(indexes)].sort((a, b) => a - b);

  return {
    coords: uniqueIndexes.map((index) => uniqueCoords[index]),
    distances: uniqueIndexes.map((index) => fullDistances[index]),
    fullDistances,
    hasClosingDuplicate,
  };
}

function interpolateElevations(
  sampleDistances: number[],
  sampleElevations: number[],
  fullDistances: number[],
  hasClosingDuplicate: boolean,
): number[] {
  if (!sampleElevations.length) return [];
  if (sampleElevations.length === 1) {
    const values = fullDistances.map(() => sampleElevations[0]);
    return hasClosingDuplicate ? [...values, values[0]] : values;
  }

  const values = fullDistances.map((distance) => {
    let hi = sampleDistances.findIndex((sampleDistance) => sampleDistance >= distance);
    if (hi <= 0) return sampleElevations[0];
    if (hi === -1) return sampleElevations[sampleElevations.length - 1];

    const lo = hi - 1;
    const span = sampleDistances[hi] - sampleDistances[lo];
    if (span <= 0) return sampleElevations[lo];

    const t = (distance - sampleDistances[lo]) / span;
    return sampleElevations[lo] + (sampleElevations[hi] - sampleElevations[lo]) * t;
  });

  return hasClosingDuplicate ? [...values, values[0]] : values;
}

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
      `${PUBLIC_BASE_PATH}/elevations/${encodeURIComponent(circuitId)}.json`,
      { cache: "force-cache" },
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
 * - No auth, but the public endpoint can rate-limit aggressive use.
 * - Endpoint accepts up to 100 coordinates per request via comma-separated
 *   `latitude` / `longitude` query params. We request at most 64 sampled
 *   points per circuit and interpolate along track distance. This avoids
 *   hammering the API and filters SRTM grid noise on tight street circuits.
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
