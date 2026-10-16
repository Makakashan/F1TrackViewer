/**
 * A global elevation provider (docs/city-generation.md §5.1, D12, P4.4).
 *
 * IGN covers France and Monaco, which is one circuit of thirty-one. The other
 * thirty need a source that covers the world, and the constraint that decides
 * which one is that this pipeline reads binary and nothing else: no GDAL, no
 * PNG decoder, no image library. Terrarium and the GeoTIFF pyramid both need
 * one. The same archive also ships **Skadi** — SRTM void-filled, one file per
 * degree, 3601 x 3601 big-endian int16, gzipped — which is a `gunzip` and a
 * `DataView`.
 *
 * The cost is honest and worth writing down: one arc-second is about **30 m**,
 * where IGN gives 3.9. The core belt's 4 m cell is therefore interpolation
 * outside France, and no amount of it invents a quay. What it does hold is the
 * shape of a landscape — Spa's hills, Interlagos's bowl, the flat of Bahrain —
 * which is what the terrain is for.
 *
 * There is no surface model, so nothing outside France gets measured building
 * heights; the bake already falls back to OSM tags for those.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

import type { ElevationProvider, RasterBBox } from "./raster";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CACHE_DIR = join(REPO_ROOT, "data", "cache", "skadi");
const BASE = "https://s3.amazonaws.com/elevation-tiles-prod/skadi";

/** Samples per side of a one-degree file: 3600 intervals, 3601 edges. */
const SIDE = 3601;
const STEP = 1 / (SIDE - 1);
/** SRTM's void marker. Everything else is metres above the EGM96 geoid. */
const VOID = -32768;

function tileName(latDeg: number, lonDeg: number): { dir: string; file: string } {
  const ns = latDeg < 0 ? "S" : "N";
  const ew = lonDeg < 0 ? "W" : "E";
  const dir = `${ns}${String(Math.abs(latDeg)).padStart(2, "0")}`;
  return { dir, file: `${dir}${ew}${String(Math.abs(lonDeg)).padStart(3, "0")}.hgt` };
}

const loaded = new Map<string, Int16Array | null>();

/**
 * One degree of ground, cached on disk as the raw `.hgt` it decompresses to.
 *
 * A missing tile is not an error: the archive has no file where there is only
 * ocean, and a circuit's bbox can easily reach into one. It is remembered as a
 * miss so a bake does not ask the network for it once per pixel.
 */
async function tile(latDeg: number, lonDeg: number): Promise<Int16Array | null> {
  const { dir, file } = tileName(latDeg, lonDeg);
  const cached = loaded.get(file);
  if (cached !== undefined) return cached;

  const path = join(CACHE_DIR, file);
  try {
    const raw = await readFile(path);
    const grid = new Int16Array(SIDE * SIDE);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < grid.length; i++) grid[i] = view.getInt16(i * 2, false);
    loaded.set(file, grid);
    return grid;
  } catch {
    // not cached yet
  }

  const res = await fetch(`${BASE}/${dir}/${file}.gz`);
  if (!res.ok) {
    loaded.set(file, null);
    return null;
  }
  const raw = gunzipSync(Buffer.from(await res.arrayBuffer()));
  if (raw.byteLength !== SIDE * SIDE * 2) {
    throw new Error(`skadi ${file}: expected ${SIDE * SIDE * 2} bytes, got ${raw.byteLength}`);
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, raw);

  const grid = new Int16Array(SIDE * SIDE);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < grid.length; i++) grid[i] = view.getInt16(i * 2, false);
  loaded.set(file, grid);
  return grid;
}

/** Bilinear, over whichever tiles the four corners land in. */
async function sample(lon: number, lat: number): Promise<number> {
  const latDeg = Math.floor(lat);
  const lonDeg = Math.floor(lon);
  const grid = await tile(latDeg, lonDeg);
  if (!grid) return Number.NaN;

  // Row 0 is the north edge, which is the top of the degree, not its floor.
  const row = (latDeg + 1 - lat) / STEP;
  const col = (lon - lonDeg) / STEP;
  const r0 = Math.min(SIDE - 2, Math.max(0, Math.floor(row)));
  const c0 = Math.min(SIDE - 2, Math.max(0, Math.floor(col)));
  const tr = row - r0;
  const tc = col - c0;

  const at = (r: number, c: number) => {
    const value = grid[r * SIDE + c];
    return value === VOID ? Number.NaN : value;
  };
  const h00 = at(r0, c0);
  const h01 = at(r0, c0 + 1);
  const h10 = at(r0 + 1, c0);
  const h11 = at(r0 + 1, c0 + 1);
  if (Number.isNaN(h00) || Number.isNaN(h01) || Number.isNaN(h10) || Number.isNaN(h11)) {
    // A void corner poisons the average, so the nearest real reading is taken.
    const corners: [number, number][] = [
      [h00, (1 - tc) ** 2 + (1 - tr) ** 2],
      [h01, tc ** 2 + (1 - tr) ** 2],
      [h10, (1 - tc) ** 2 + tr ** 2],
      [h11, tc ** 2 + tr ** 2],
    ];
    let best = Number.NaN;
    let bestWeight = -Infinity;
    for (const [value, weight] of corners) {
      if (Number.isNaN(value) || weight <= bestWeight) continue;
      best = value;
      bestWeight = weight;
    }
    return best;
  }
  const top = h00 + (h01 - h00) * tc;
  const bottom = h10 + (h11 - h10) * tc;
  return top + (bottom - top) * tr;
}

export const SKADI_PROVIDER: ElevationProvider = {
  id: "skadi-srtm",
  // One arc-second at the equator. Real everywhere SRTM flew, which is
  // 60 N to 56 S — every circuit on the calendar.
  nativeCellM: 30,
  maxPixels: 4000,
  // A static object store, so the only reason to wait is politeness.
  minRequestIntervalMs: 0,
  // Bare ground only. No surface model, so no measured building heights.
  layerFor: (kind) => (kind === "dtm" ? "srtm-1arcsec" : null),
  covers: (bbox) => bbox.minLat >= -56 && bbox.maxLat <= 60,
  grid: async (_layer, bbox, width, height) => {
    const out = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      // Pixel centres, north-up, matching what the WMS path returns.
      const lat = bbox.maxLat - ((row + 0.5) / height) * (bbox.maxLat - bbox.minLat);
      for (let col = 0; col < width; col++) {
        const lon = bbox.minLon + ((col + 0.5) / width) * (bbox.maxLon - bbox.minLon);
        out[row * width + col] = await sample(lon, lat);
      }
    }
    return out;
  },
};
