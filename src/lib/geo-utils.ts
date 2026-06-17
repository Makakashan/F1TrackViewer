/** Geographic helpers — WGS84 [lon, lat] → metric [x, z] for Three.js. Units: meters. */

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

/** Build a closed CatmullRomCurve3 from [lon, lat] coords. Strips closing duplicate, uses centripetal parametrization. */
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

  return new THREE.CatmullRomCurve3(points, true, "centripetal", 0.5);
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
