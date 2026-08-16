/**
 * Circuit centreline and bbox for the city generator.
 *
 * The old `generate-environment.ts` carries its own copy of this; it is on the
 * way out (docs/city-generation.md D17) and is left alone rather than made to
 * depend on the new path.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RasterBBox } from "./raster";

const RAW_BASE = "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CACHE_DIR = join(REPO_ROOT, "data", "raw", "circuits");

/** Matches the padding the existing environments were generated with. */
export const DEFAULT_PADDING_M = 1_000;

const METERS_PER_DEG_LAT = 111_320;

interface CircuitGeoJSON {
  features: {
    geometry: { type: string; coordinates: [number, number][] };
  }[];
}

/** Centreline in lon/lat, as the circuit is drawn: a closed loop. */
export async function loadCircuitCoords(circuitId: string): Promise<[number, number][]> {
  const cachePath = join(CACHE_DIR, `${circuitId}.geojson`);
  let text: string;
  try {
    text = await readFile(cachePath, "utf8");
  } catch {
    const res = await fetch(`${RAW_BASE}/circuits/${circuitId}.geojson`);
    if (!res.ok) throw new Error(`circuit ${circuitId}: HTTP ${res.status}`);
    text = await res.text();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, text);
  }

  const geo = JSON.parse(text) as CircuitGeoJSON;
  const line = geo.features?.find((f) => f.geometry?.type === "LineString");
  if (!line) throw new Error(`circuit ${circuitId}: no LineString in the GeoJSON`);
  return line.geometry.coordinates;
}

export function circuitBBox(
  coords: [number, number][],
  paddingM = DEFAULT_PADDING_M,
): RasterBBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  const centerLat = (minLat + maxLat) / 2;
  const dLat = paddingM / METERS_PER_DEG_LAT;
  const dLon = paddingM / (METERS_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180));
  return {
    minLon: minLon - dLon,
    minLat: minLat - dLat,
    maxLon: maxLon + dLon,
    maxLat: maxLat + dLat,
  };
}
