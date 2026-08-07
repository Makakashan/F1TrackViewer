/** Geographic helpers — WGS84 [lon, lat] → metric [x, z] for Three.js. Units: meters. */

import * as THREE from "three";

/** Elevation is rendered at real scale (1:1). No vertical exaggeration. */
export const REAL_ELEVATION_SCALE = 1;

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

/** The inverse of `lonLatToXZ`, for asking the map about a point in the scene. */
export function xzToLonLat(
  x: number,
  z: number,
  centerLon: number,
  centerLat: number,
): [number, number] {
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  return [centerLon + x / metersPerDegLon, centerLat - z / metersPerDegLat];
}

/**
 * Distance in meters between two [lon, lat] points.
 */
export function distanceMeters(a: [number, number], b: [number, number]): number {
  const meanLat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos(meanLat);
  const dx = (b[0] - a[0]) * metersPerDegLon;
  const dz = (b[1] - a[1]) * metersPerDegLat;
  return Math.hypot(dx, dz);
}

/**
 * Insert evenly-spaced intermediate points into long segments so no gap
 * exceeds `maxSegmentMeters`. Real circuit GeoJSON can have straights spanning
 * several hundred meters between two points — a Catmull-Rom curve only
 * samples terrain height at the original vertices, so a smooth interpolation
 * across a long, sparse segment can miss a hill in between and dip the track
 * below the terrain mesh. Densifying first gives the curve enough elevation
 * samples to track the real profile.
 */
export function densifyCoords(
  coords: [number, number][],
  maxSegmentMeters: number,
): [number, number][] {
  if (coords.length < 2 || maxSegmentMeters <= 0) return coords;
  const result: [number, number][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    result.push(a);
    const steps = Math.floor(distanceMeters(a, b) / maxSegmentMeters);
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  result.push(coords[coords.length - 1]);
  return result;
}

/**
 * Rebuild a curve's arc-length table at roughly one division per meter.
 *
 * `getPointAt` / `getTangentAt` map distance to curve parameter through a
 * lookup table with linear interpolation between entries, and three.js
 * defaults to 200 entries no matter how long the curve is — 16 m per entry on
 * a Monaco-sized lap. Anything that steps along the curve by real distance
 * then lands unevenly: asking for 4.16 m steps returns spacings between
 * 0.59 m and 9.91 m, which is why evenly sized markings came out ragged.
 * The table has to be finer than the steps taken through it: at one division
 * per meter, meter-long kerb blocks still came out between 0.49 m and 1.52 m.
 * Four divisions per meter holds them inside a few percent, and building the
 * table costs one cheap curve evaluation per division, once per circuit.
 */
export function refineArcLengths(curve: THREE.CatmullRomCurve3): void {
  const divisions = THREE.MathUtils.clamp(
    Math.round(curve.getLength() * 4),
    200,
    60_000,
  );
  if (divisions <= curve.arcLengthDivisions) return;
  curve.arcLengthDivisions = divisions;
  curve.updateArcLengths();
}

/**
 * Drop the repeated final point of a closed ring. A CatmullRomCurve3 built
 * with `closed: true` adds the wrap segment itself, and callers that compute a
 * per-vertex profile need their arrays index-aligned with the same points.
 */
export function stripClosingDuplicate(
  coords: [number, number][],
): [number, number][] {
  if (coords.length < 2) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return coords.slice(0, -1);
  }
  return coords;
}

/** Build a closed CatmullRomCurve3 from [lon, lat] coords. Strips closing duplicate, uses centripetal parametrization. */
export function buildTrackCurve(
  coords: [number, number][],
  bounds: GeoBounds,
  elevations?: number[],
  elevationScale: number = REAL_ELEVATION_SCALE,
  elevationOffset: number = 0,
): THREE.CatmullRomCurve3 {
  const pts = stripClosingDuplicate(coords);

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

  const curve = new THREE.CatmullRomCurve3(points, true, "centripetal", 0.5);
  refineArcLengths(curve);
  return curve;
}

export function buildTrackCurveWithY(
  coords: [number, number][],
  bounds: GeoBounds,
  getY: (lon: number, lat: number, index: number) => number,
): THREE.CatmullRomCurve3 {
  const pts = stripClosingDuplicate(coords);

  const points = pts.map(([lon, lat], i) => {
    const v = lonLatToXZ(lon, lat, bounds.centerLon, bounds.centerLat);
    v.y = getY(lon, lat, i);
    return v;
  });

  const curve = new THREE.CatmullRomCurve3(points, true, "centripetal", 0.5);
  refineArcLengths(curve);
  return curve;
}

/**
 * Estimate a sensible scene radius (in meters) from the bbox.
 */
export function sceneRadiusFromBounds(bounds: GeoBounds): number {
  const widthMeters =
    (bounds.maxLon - bounds.minLon) *
    111_320 *
    Math.cos((bounds.centerLat * Math.PI) / 180);
  const heightMeters = (bounds.maxLat - bounds.minLat) * 111_320;
  return Math.max(widthMeters, heightMeters) / 2;
}
