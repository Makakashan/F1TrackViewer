/**
 * Elevation rasters for the city generator: fetch, clean, cache.
 *
 * See docs/city-generation.md §5. The provider returns a raw little-endian
 * float32 grid, so there is nothing to decode — the response body *is* the
 * raster. Nodata arrives as -99999 and, because the service resamples, as
 * anything between that and real ground along a nodata edge; §5.5 covers why
 * both have to go.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── types ─────────────────────────────────────────────────────────────────

export interface RasterBBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** `dtm` is bare ground, `dsm` includes what stands on it, `mnh` is the difference. */
export type RasterKind = "dtm" | "dsm" | "mnh";

export interface RasterHeader {
  schemaVersion: 1;
  kind: RasterKind;
  provider: string;
  layer: string;
  width: number;
  height: number;
  bbox: RasterBBox;
  /** Ground distance one pixel covers, for sanity-checking against the native cell. */
  pixelSizeM: { x: number; y: number };
  nativeCellM: number;
  validCount: number;
  nodataCount: number;
  minValue: number;
  maxValue: number;
  fetchedAt: string;
}

/** Row-major, north-up. Nodata is `NaN` — every reader has to handle it anyway. */
export interface Raster {
  header: RasterHeader;
  data: Float32Array;
}

export interface ElevationProvider {
  id: string;
  /** Finest real cell the service holds. Asking for more returns interpolation. */
  nativeCellM: number;
  /** Largest raster the service will render in one request. */
  maxPixels: number;
  minRequestIntervalMs: number;
  layerFor(kind: RasterKind): string | null;
  covers(bbox: RasterBBox): boolean;
  url(layer: string, bbox: RasterBBox, width: number, height: number): string;
}

// ─── geometry ──────────────────────────────────────────────────────────────

const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLon(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export function bboxSizeMeters(bbox: RasterBBox): { width: number; height: number } {
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  return {
    width: (bbox.maxLon - bbox.minLon) * metersPerDegLon(centerLat),
    height: (bbox.maxLat - bbox.minLat) * METERS_PER_DEG_LAT,
  };
}

/**
 * Pixel count that lands one pixel on one source cell. Anything finer is the
 * service interpolating; anything coarser throws away data we already paid for.
 */
export function nativeGridSize(
  bbox: RasterBBox,
  cellM: number,
  maxPixels: number,
): { width: number; height: number } {
  const size = bboxSizeMeters(bbox);
  return {
    width: Math.min(maxPixels, Math.max(2, Math.ceil(size.width / cellM))),
    height: Math.min(maxPixels, Math.max(2, Math.ceil(size.height / cellM))),
  };
}

// ─── IGN Géoplateforme ─────────────────────────────────────────────────────

const IGN_LAYERS: Record<RasterKind, string> = {
  dtm: "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES",
  dsm: "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS",
  mnh: "IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G",
};

export const IGN_PROVIDER: ElevationProvider = {
  id: "ign-geoplateforme",
  // Measured, not documented: a 250 m bbox at 0.98 m/px repeats each value for
  // four pixels. docs/city-generation.md §5.2.
  nativeCellM: 3.9,
  maxPixels: 5010,
  minRequestIntervalMs: 1_100, // x-ratelimit-limit-second: 1
  layerFor: (kind) => IGN_LAYERS[kind] ?? null,
  // France and Monaco. The overseas départements are covered too, but no
  // circuit sits in one, so the cheap box is the honest box.
  covers: (bbox) =>
    bbox.minLon >= -5.3 &&
    bbox.maxLon <= 9.7 &&
    bbox.minLat >= 41.2 &&
    bbox.maxLat <= 51.2,
  url: (layer, bbox, width, height) => {
    // WMS 1.3.0 with EPSG:4326 takes BBOX in lat,lon order. Swapping it returns
    // a plausible-looking raster of the wrong place, so it is worth the comment.
    const params = new URLSearchParams({
      SERVICE: "WMS",
      VERSION: "1.3.0",
      REQUEST: "GetMap",
      LAYERS: layer,
      STYLES: "",
      CRS: "EPSG:4326",
      BBOX: `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`,
      WIDTH: String(width),
      HEIGHT: String(height),
      FORMAT: "image/x-bil;bits=32",
    });
    return `https://data.geopf.fr/wms-r/wms?${params}`;
  },
};

const PROVIDERS: ElevationProvider[] = [IGN_PROVIDER];

export function providerFor(bbox: RasterBBox): ElevationProvider | null {
  return PROVIDERS.find((p) => p.covers(bbox)) ?? null;
}

// ─── nodata ────────────────────────────────────────────────────────────────

/**
 * Nothing in a circuit bbox is real below this. The service blends its -99999
 * sentinel into neighbouring pixels, so the shoreline arrives carrying values
 * of -974 m sitting next to 2 m of quay.
 */
const NODATA_FLOOR_M = -20;

/**
 * Drop the sentinel and its blend, then erode the valid mask by one cell: a
 * pixel touching nodata was averaged with it, whatever it now claims. Costs a
 * 4 m strip of coast, which is one cell — below anything the scene resolves.
 */
function cleanNodata(values: Float32Array, width: number, height: number): void {
  for (let i = 0; i < values.length; i++) {
    if (!(values[i] > NODATA_FLOOR_M)) values[i] = Number.NaN; // NaN-safe form
  }

  const wasValid = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) wasValid[i] = Number.isNaN(values[i]) ? 0 : 1;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      if (wasValid[i] === 0) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= height || c < 0 || c >= width) continue;
          if (wasValid[r * width + c] === 0) {
            values[i] = Number.NaN;
            dr = 2;
            break;
          }
        }
      }
    }
  }
}

function summarise(values: Float32Array): {
  validCount: number;
  nodataCount: number;
  minValue: number;
  maxValue: number;
} {
  let validCount = 0;
  let minValue = Infinity;
  let maxValue = -Infinity;
  for (const v of values) {
    if (Number.isNaN(v)) continue;
    validCount++;
    if (v < minValue) minValue = v;
    if (v > maxValue) maxValue = v;
  }
  return {
    validCount,
    nodataCount: values.length - validCount,
    minValue: validCount ? minValue : 0,
    maxValue: validCount ? maxValue : 0,
  };
}

// ─── cache ─────────────────────────────────────────────────────────────────

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CACHE_DIR = join(REPO_ROOT, "data", "cache", "elevation-raster");

function cacheKey(
  provider: ElevationProvider,
  kind: RasterKind,
  bbox: RasterBBox,
  width: number,
  height: number,
): string {
  const b = [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat]
    .map((v) => v.toFixed(6))
    .join("_");
  return `${provider.id}-${kind}-${b}-${width}x${height}`;
}

async function readCachedRaster(key: string): Promise<Raster | null> {
  try {
    const header = JSON.parse(
      await readFile(join(CACHE_DIR, `${key}.json`), "utf8"),
    ) as RasterHeader;
    const bytes = await readFile(join(CACHE_DIR, `${key}.f32`));
    if (bytes.byteLength !== header.width * header.height * 4) return null;
    // Copy: the Buffer's offset into its pool is not guaranteed 4-byte aligned.
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { header, data: new Float32Array(copy) };
  } catch {
    return null;
  }
}

async function writeCachedRaster(key: string, raster: Raster): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify(raster.header, null, 2));
  await writeFile(join(CACHE_DIR, `${key}.f32`), Buffer.from(raster.data.buffer));
}

// ─── fetch ─────────────────────────────────────────────────────────────────

let lastRequestAt = 0;

async function throttle(intervalMs: number): Promise<void> {
  const wait = lastRequestAt + intervalMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

export interface FetchRasterOptions {
  kind: RasterKind;
  bbox: RasterBBox;
  /** Defaults to one pixel per native cell. */
  width?: number;
  height?: number;
  refresh?: boolean;
  provider?: ElevationProvider;
}

export async function fetchElevationRaster(options: FetchRasterOptions): Promise<Raster> {
  const { kind, bbox, refresh = false } = options;
  const provider = options.provider ?? providerFor(bbox);
  if (!provider) {
    throw new Error(
      `no elevation provider covers ${JSON.stringify(bbox)} — see docs/city-generation.md §5.1`,
    );
  }
  const layer = provider.layerFor(kind);
  if (!layer) throw new Error(`${provider.id} has no layer for ${kind}`);

  const native = nativeGridSize(bbox, provider.nativeCellM, provider.maxPixels);
  const width = options.width ?? native.width;
  const height = options.height ?? native.height;
  if (width > provider.maxPixels || height > provider.maxPixels) {
    throw new Error(`${provider.id} renders at most ${provider.maxPixels} px per side`);
  }

  const key = cacheKey(provider, kind, bbox, width, height);
  if (!refresh) {
    const cached = await readCachedRaster(key);
    if (cached) return cached;
  }

  await throttle(provider.minRequestIntervalMs);
  const url = provider.url(layer, bbox, width, height);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${provider.id} ${kind}: HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("x-bil")) {
    // WMS reports failure as an XML body under HTTP 200, so the type is the check.
    throw new Error(`${provider.id} ${kind}: expected float32 BIL, got ${contentType}`);
  }

  const body = await res.arrayBuffer();
  if (body.byteLength !== width * height * 4) {
    throw new Error(
      `${provider.id} ${kind}: expected ${width * height * 4} bytes, got ${body.byteLength}`,
    );
  }

  // The payload is little-endian float32 and every platform this runs on is
  // little-endian, so the buffer is the array.
  const data = new Float32Array(body);
  cleanNodata(data, width, height);

  const size = bboxSizeMeters(bbox);
  const raster: Raster = {
    header: {
      schemaVersion: 1,
      kind,
      provider: provider.id,
      layer,
      width,
      height,
      bbox,
      pixelSizeM: { x: size.width / width, y: size.height / height },
      nativeCellM: provider.nativeCellM,
      fetchedAt: new Date().toISOString().slice(0, 10),
      ...summarise(data),
    },
    data,
  };

  await writeCachedRaster(key, raster);
  return raster;
}

// ─── sampling ──────────────────────────────────────────────────────────────

/** Nearest-neighbour, because interpolating across a nodata edge re-creates §5.5. */
export function sampleRaster(raster: Raster, lon: number, lat: number): number {
  const { bbox, width, height } = raster.header;
  const u = (lon - bbox.minLon) / (bbox.maxLon - bbox.minLon);
  const v = (bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat); // row 0 is north
  if (u < 0 || u > 1 || v < 0 || v > 1) return Number.NaN;
  const col = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
  const row = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
  return raster.data[row * width + col];
}

// ─── CLI ───────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  bun scripts/env/raster.ts --bbox=minLon,minLat,maxLon,maxLat [--kind=dtm|dsm|mnh] [--refresh]

Fetches one elevation raster and reports what came back: size, native cell,
value range, and a coverage map. Run it against a new circuit's bbox before
migrating it, to see whether the provider has real data there.`;

function parseBBox(value: string): RasterBBox {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`bad --bbox: ${value}`);
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  return { minLon, minLat, maxLon, maxLat };
}

function coverageMap(raster: Raster, size = 48): string {
  const { width, height } = raster.header;
  const rows: string[] = [];
  for (let i = 0; i < size; i++) {
    let row = "";
    for (let j = 0; j < size; j++) {
      const r = Math.round((i * (height - 1)) / (size - 1));
      const c = Math.round((j * (width - 1)) / (size - 1));
      row += Number.isNaN(raster.data[r * width + c]) ? "." : "#";
    }
    rows.push(`  ${row}`);
  }
  return rows.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(USAGE);
    return;
  }
  const bboxArg = argv.find((a) => a.startsWith("--bbox="));
  if (!bboxArg) throw new Error(USAGE);
  const kindArg = (argv.find((a) => a.startsWith("--kind="))?.split("=")[1] ??
    "dtm") as RasterKind;

  const raster = await fetchElevationRaster({
    kind: kindArg,
    bbox: parseBBox(bboxArg.split("=")[1]),
    refresh: argv.includes("--refresh"),
  });

  const h = raster.header;
  const pct = (100 * h.validCount) / (h.width * h.height);
  console.log(`${h.provider} ${h.kind} — ${h.layer}`);
  console.log(`  grid        ${h.width} x ${h.height}`);
  console.log(
    `  pixel       ${h.pixelSizeM.x.toFixed(2)} x ${h.pixelSizeM.y.toFixed(2)} m ` +
      `(native cell ${h.nativeCellM} m)`,
  );
  console.log(`  values      ${h.minValue.toFixed(2)} .. ${h.maxValue.toFixed(2)} m`);
  console.log(`  coverage    ${pct.toFixed(1)}% (${h.nodataCount} nodata)`);
  console.log(coverageMap(raster));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
