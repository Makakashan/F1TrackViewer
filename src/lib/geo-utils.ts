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
 */
export function buildTrackCurve(
  coords: [number, number][],
  bounds: GeoBounds,
): THREE.CatmullRomCurve3 {
  let pts = coords;
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      pts = pts.slice(0, -1);
    }
  }
  const points = pts.map(([lon, lat]) =>
    lonLatToXZ(lon, lat, bounds.centerLon, bounds.centerLat),
  );
  return new THREE.CatmullRomCurve3(points, true, "catmullrom", 0.5);
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
