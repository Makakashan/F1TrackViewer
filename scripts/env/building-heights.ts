/**
 * Building heights from IGN's MNH (height above ground), since OSM's
 * `building:levels` is missing or wrong across much of Monaco.
 */

import type { BuildingFeature } from "../../src/lib/env/environment-types";
import { pointInPolygon } from "./overrides";
import { sampleRaster, type Raster } from "./raster";

/** Below this a reading is ground, not a roof: a courtyard, a car park. */
const MIN_MEASURED_M = 2.5;
/** Nothing in a circuit bbox is taller. Above it the raster caught a crane. */
const MAX_MEASURED_M = 200;
/** Fewer readings than this and the footprint is too small to trust a shape. */
const MIN_SAMPLES = 3;
/** The roof, not the aerial: upper-middle of the readings, not the max. */
const ROOF_PERCENTILE = 0.75;

export interface HeightMeasurement {
  measured: number;
  fallback: number;
  /** Metres the measurement moved the building. */
  deltaM: number;
}

export interface HeightStats {
  measured: number;
  fellBack: number;
  medianDeltaM: number;
  tallest: number;
}

/** Sample MNH inside each footprint; the outline would read the street. */
export function measureBuildingHeights(
  buildings: BuildingFeature[],
  mnh: Raster | null,
  stats: { value: HeightStats },
): Map<string, HeightMeasurement> {
  const heights = new Map<string, HeightMeasurement>();
  // Outside France there is no surface model, so every height is the OSM tag.
  if (!mnh) {
    stats.value = { measured: 0, fellBack: buildings.length, medianDeltaM: 0, tallest: 0 };
    return heights;
  }
  const { bbox, width, height } = mnh.header;
  const lonStep = (bbox.maxLon - bbox.minLon) / (width - 1);
  const latStep = (bbox.maxLat - bbox.minLat) / (height - 1);
  const deltas: number[] = [];
  let measured = 0;
  let fellBack = 0;
  let tallest = 0;

  for (const building of buildings) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const [lon, lat] of building.footprint) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }

    const samples: number[] = [];
    for (let lat = minLat; lat <= maxLat; lat += latStep) {
      for (let lon = minLon; lon <= maxLon; lon += lonStep) {
        if (!pointInPolygon(lon, lat, building.footprint)) continue;
        const value = sampleRaster(mnh, lon, lat);
        if (Number.isNaN(value) || value < MIN_MEASURED_M || value > MAX_MEASURED_M) continue;
        samples.push(value);
      }
    }

    // A footprint smaller than a raster cell falls between the sample points;
    // its centroid is the one reading it can have.
    if (samples.length < MIN_SAMPLES) {
      const centroidLon = (minLon + maxLon) / 2;
      const centroidLat = (minLat + maxLat) / 2;
      const centre = sampleRaster(mnh, centroidLon, centroidLat);
      if (!Number.isNaN(centre) && centre >= MIN_MEASURED_M && centre <= MAX_MEASURED_M) {
        samples.push(centre);
      }
    }

    if (samples.length < 1) {
      fellBack++;
      continue;
    }

    samples.sort((a, b) => a - b);
    const value = samples[Math.min(samples.length - 1, Math.floor(samples.length * ROOF_PERCENTILE))];
    heights.set(building.id, {
      measured: value,
      fallback: building.height,
      deltaM: value - building.height,
    });
    deltas.push(Math.abs(value - building.height));
    measured++;
    if (value > tallest) tallest = value;
  }

  deltas.sort((a, b) => a - b);
  stats.value = {
    measured,
    fellBack,
    medianDeltaM: deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0,
    tallest,
  };
  return heights;
}
