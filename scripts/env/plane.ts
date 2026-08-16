/**
 * The scene's metric plane.
 *
 * Baked geometry has to land where the runtime expects it, so this mirrors
 * `src/lib/geo-utils.ts` exactly: the origin is the centre of the circuit's own
 * bounding box — not the padded environment bbox — X runs east, Z runs south,
 * and Y is the height field's metres above sea level.
 */

const METERS_PER_DEG_LAT = 111_320;

export interface ScenePlane {
  centerLon: number;
  centerLat: number;
  metersPerDegLon: number;
  x(lon: number): number;
  z(lat: number): number;
  lon(x: number): number;
  lat(z: number): number;
}

export function scenePlaneFor(coords: [number, number][]): ScenePlane {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180);

  return {
    centerLon,
    centerLat,
    metersPerDegLon,
    x: (lon) => (lon - centerLon) * metersPerDegLon,
    z: (lat) => -(lat - centerLat) * METERS_PER_DEG_LAT,
    lon: (x) => centerLon + x / metersPerDegLon,
    lat: (z) => centerLat - z / METERS_PER_DEG_LAT,
  };
}
