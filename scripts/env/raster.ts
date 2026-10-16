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

import { SKADI_PROVIDER } from "./skadi";

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
  /** How many source pixels were averaged per output pixel, per axis. */
  supersample: number;
  /** Cells the flat-constant rule turned into water. */
  flatWaterCells: number;
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
  /** A service that renders a raster per request answers with a URL. */
  url?(layer: string, bbox: RasterBBox, width: number, height: number): string;
  /**
   * A service that ships fixed tiles answers with the grid itself.
   *
   * One of `url` and `grid` has to be there. The split is not decoration: a WMS
   * is asked for the exact window wanted and a tiled archive is not, so the
   * resampling has to live on the provider that needs it.
   */
  grid?(
    layer: string,
    bbox: RasterBBox,
    width: number,
    height: number,
  ): Promise<Float32Array>;
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

/**
 * In order of how good the data is, not of how convenient it is. IGN is 3.9 m
 * over France; Skadi is 30 m over the world. A circuit takes the first that
 * covers it, so Monaco keeps the LiDAR and everything else still gets ground.
 */
const PROVIDERS: ElevationProvider[] = [IGN_PROVIDER, SKADI_PROVIDER];

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
 * Two source pixels per output pixel per axis. Enough to break the beat in §5.7
 * at four times the bytes, all of which stay in the cache.
 */
const DEFAULT_SUPERSAMPLE = 2;

/** Smallest constant-value region taken for water: 0.46 ha at a 3.9 m cell. */
const FLAT_WATER_MIN_CELLS = 300;
/**
 * Safety valve on the flat-water rule, not a statement about water: above this
 * a constant plateau is more likely a man-made surface than a basin.
 */
const FLAT_WATER_MAX_ELEVATION_M = 50;
/**
 * Smallest patch of land allowed to sit in open water. Below a small building's
 * footprint it is a boat or a buoy in the LiDAR, not an island.
 */
const MIN_ISLAND_M2 = 150;
/**
 * Smallest enclosed patch of nodata kept as water.
 *
 * The DTM has holes: a boat shadow, a crane, a gap in the flight lines. Ringed
 * by ground, one of those is not a pond — it is a hole punched through the quay,
 * and the terrain cuts a coastline around it. The one at the root of Port
 * Hercule's T pier is 24 m2. Kept the same size as an islet, because the two
 * questions are the same one turned over.
 */
const MIN_POND_M2 = 150;
/**
 * Half the narrowest strip of land kept, in metres.
 *
 * Measured, not guessed: a marina pontoon is 3–4 m across and Monaco's quays
 * are 10–20 m, so the cut has to fall between them. Set at 5 m it took the
 * quays with it — erosion by three cells leaves nothing of a five-cell jetty
 * but a chewed remnant — so it sits at one cell instead, which deletes strips
 * up to about 4 m wide and leaves anything wider untouched.
 */
const MIN_LAND_HALF_WIDTH_M = 2;

/** The sentinel and everything it was blended into. */
function maskNodata(values: Float32Array): void {
  for (let i = 0; i < values.length; i++) {
    if (!(values[i] > NODATA_FLOOR_M)) values[i] = Number.NaN; // NaN-safe form
  }
}

/**
 * Average `factor`×`factor` blocks down to the target grid, ignoring nodata.
 *
 * The service's grid is 3.90 m across and 4.35 m down — not square, and not
 * aligned to anything we can ask for. Sampling it at one pixel per cell beats
 * against that mismatch and lays periodic ridges across the raster every fourth
 * row, which would read as terraces on a hillside. Fetching at twice the pitch
 * and averaging removes the beat without touching real relief.
 */
function downsample(
  values: Float32Array,
  width: number,
  height: number,
  factor: number,
): { data: Float32Array; width: number; height: number } {
  if (factor <= 1) return { data: values, width, height };
  const outWidth = Math.floor(width / factor);
  const outHeight = Math.floor(height / factor);
  const out = new Float32Array(outWidth * outHeight);

  for (let row = 0; row < outHeight; row++) {
    for (let col = 0; col < outWidth; col++) {
      let sum = 0;
      let n = 0;
      for (let dr = 0; dr < factor; dr++) {
        for (let dc = 0; dc < factor; dc++) {
          const v = values[(row * factor + dr) * width + col * factor + dc];
          if (Number.isNaN(v)) continue;
          sum += v;
          n++;
        }
      }
      // A block that is mostly sea stays sea: half-covered cells on the
      // shoreline are the ones §5.5 says not to trust.
      out[row * outWidth + col] = n * 2 >= factor * factor ? sum / n : Number.NaN;
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

/**
 * Enclosed water — a harbour, a marina, a sheltered bay — does not arrive as
 * nodata the way the open sea does. The service stamps it with a single
 * constant: Port Hercule is 22.5 ha of exactly 1.20 m, Fontvieille 7.0 ha of
 * 0.61 m, Larvotto 4.3 ha of -0.23 m. Ground is never bit-identical over
 * hectares, so a large connected run of one value is the source telling us it
 * filled water, and marking it NaN keeps the coastline decided by the DEM alone
 * (D15) instead of borrowing an OSM polygon that would not line up.
 */
function markFlatWater(
  values: Float32Array,
  width: number,
  height: number,
  minCells: number,
  maxElevationM: number,
): number {
  const seen = new Uint8Array(values.length);
  const stack: number[] = [];
  const region: number[] = [];
  let marked = 0;

  for (let start = 0; start < values.length; start++) {
    if (seen[start]) continue;
    const value = values[start];
    if (Number.isNaN(value) || value > maxElevationM) continue;

    seen[start] = 1;
    stack.length = 0;
    region.length = 0;
    stack.push(start);

    while (stack.length) {
      const i = stack.pop() as number;
      region.push(i);
      const row = (i / width) | 0;
      const col = i % width;
      if (row > 0) pushIfSame(i - width);
      if (row < height - 1) pushIfSame(i + width);
      if (col > 0) pushIfSame(i - 1);
      if (col < width - 1) pushIfSame(i + 1);
    }

    if (region.length < minCells) continue;
    for (const i of region) values[i] = Number.NaN;
    marked += region.length;

    function pushIfSame(j: number) {
      if (seen[j] || Number.isNaN(values[j])) return;
      if (Math.abs(values[j] - value) > 0.005) return;
      seen[j] = 1;
      stack.push(j);
    }
  }

  return marked;
}

/**
 * Erode the valid mask, one cell per pass: a pixel touching nodata was averaged
 * with it, whatever it now claims. Runs at the fetched pitch, so two passes cost
 * one output cell of open coast and leave harbour edges — which are not nodata
 * at this point — untouched.
 */
/**
 * Land too small to be land. A LiDAR return off a moored boat, a buoy or a
 * pontoon leaves a handful of dry cells sitting in the middle of a basin, and
 * the terrain dutifully builds an islet there — from any distance the harbour
 * reads as a speckled edge rather than as water.
 *
 * Anything enclosed by water and smaller than a building's footprint goes back
 * to being water. A component touching the raster's edge is left alone: it runs
 * out of the frame and its real size is not knowable here.
 */
/**
 * Land narrower than it is long is not land here.
 *
 * A marina reads back as a comb: pontoons, moored hulls and the odd crane leave
 * strips of dry cells one or two wide running out into the basin, and the
 * shoreline grows tongues and detached flakes that no amount of smoothing the
 * edge can fix, because the mask itself says they are there. A morphological
 * opening — erode the land, then dilate what survives — deletes anything
 * thinner than twice the radius while leaving a real quay, which is tens of
 * metres across, exactly where it was.
 */
function openLand(
  data: Float32Array,
  width: number,
  height: number,
  radius: number,
): number {
  const isLand = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) isLand[i] = Number.isNaN(data[i]) ? 0 : 1;

  const pass = (source: Uint8Array, keepWhenAllNeighbours: boolean): Uint8Array => {
    const out = new Uint8Array(source.length);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        let all = true;
        let any = false;
        for (let dr = -radius; dr <= radius && (all || !any); dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            const nr = row + dr;
            const nc = col + dc;
            // Off the edge counts as land, so the frame is not eaten away.
            const value = nr < 0 || nc < 0 || nr >= height || nc >= width
              ? 1
              : source[nr * width + nc];
            if (value) any = true;
            else all = false;
          }
        }
        out[row * width + col] = keepWhenAllNeighbours ? (all ? 1 : 0) : (any ? 1 : 0);
      }
    }
    return out;
  };

  const eroded = pass(isLand, true);
  const opened = pass(eroded, false);

  let removed = 0;
  for (let i = 0; i < data.length; i++) {
    if (isLand[i] && !opened[i]) {
      data[i] = Number.NaN;
      removed++;
    }
  }
  return removed;
}

function despeckleLand(
  data: Float32Array,
  width: number,
  height: number,
  minCells: number,
): number {
  const seen = new Uint8Array(width * height);
  const component: number[] = [];
  const queue: number[] = [];
  let removed = 0;

  for (let start = 0; start < data.length; start++) {
    if (seen[start] || Number.isNaN(data[start])) continue;
    component.length = 0;
    queue.length = 0;
    queue.push(start);
    seen[start] = 1;
    let touchesEdge = false;

    while (queue.length) {
      const index = queue.pop() as number;
      component.push(index);
      const row = Math.floor(index / width);
      const col = index - row * width;
      if (row === 0 || col === 0 || row === height - 1 || col === width - 1) touchesEdge = true;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue;
        const next = nr * width + nc;
        if (seen[next] || Number.isNaN(data[next])) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }

    if (touchesEdge || component.length > minCells) continue;
    for (const index of component) data[index] = Number.NaN;
    removed += component.length;
  }

  return removed;
}

/**
 * Fills small enclosed patches of nodata, the mirror of `despeckleLand`.
 *
 * A nodata component that never reaches the edge of the raster is surrounded by
 * ground, so it is either a real pond or a hole in the survey. Below a pond's
 * size it is a hole, and it is filled from the ring of ground around it rather
 * than left for the terrain to cut a coastline through.
 */
function fillPonds(
  data: Float32Array,
  width: number,
  height: number,
  minCells: number,
): number {
  const seen = new Uint8Array(width * height);
  const component: number[] = [];
  const queue: number[] = [];
  let filled = 0;

  for (let start = 0; start < data.length; start++) {
    if (seen[start] || !Number.isNaN(data[start])) continue;
    component.length = 0;
    queue.length = 0;
    queue.push(start);
    seen[start] = 1;
    let touchesEdge = false;

    while (queue.length) {
      const index = queue.pop() as number;
      component.push(index);
      const row = Math.floor(index / width);
      const col = index - row * width;
      if (row === 0 || col === 0 || row === height - 1 || col === width - 1) touchesEdge = true;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue;
        const next = nr * width + nc;
        if (seen[next] || !Number.isNaN(data[next])) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }

    if (touchesEdge || component.length > minCells) continue;

    // The mean of the ground touching the hole: the quay it is punched through
    // is flat, so its own rim is the best answer available.
    let sum = 0;
    let count = 0;
    for (const index of component) {
      const row = Math.floor(index / width);
      const col = index - row * width;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue;
        const value = data[nr * width + nc];
        if (Number.isNaN(value)) continue;
        sum += value;
        count++;
      }
    }
    if (count === 0) continue;
    const level = sum / count;
    for (const index of component) data[index] = level;
    filled += component.length;
  }

  return filled;
}

function erodeNodata(
  values: Float32Array,
  width: number,
  height: number,
  passes = 1,
): void {
  for (let pass = 0; pass < passes; pass++) erodeOnce(values, width, height);
}

function erodeOnce(values: Float32Array, width: number, height: number): void {
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

/**
 * The last of the water cleanup, applied to the finished grid rather than to
 * the fetched one.
 *
 * The cache holds the processed raster, not the tiles behind it, so a change
 * anywhere earlier in the pipeline can only be made by refetching every tile
 * from the IGN. This step reads the same as it would there — a hole in the quay
 * is smaller than a pond at any cell size — so it runs here, on whatever the
 * cache hands back, and costs nobody a download.
 */
function cleanWater(raster: Raster, kind: RasterKind): void {
  if (kind === "mnh") return;
  const cellAreaM2 = raster.header.pixelSizeM.x * raster.header.pixelSizeM.y;
  fillPonds(
    raster.data,
    raster.header.width,
    raster.header.height,
    Math.max(1, Math.round(MIN_POND_M2 / cellAreaM2)),
  );
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
  /** Defaults to one pixel per native cell, before supersampling. */
  width?: number;
  height?: number;
  /** Fetch this many times finer and average back down. 1 disables it. */
  supersample?: number;
  /** Detect enclosed water stamped as a flat constant. On by default. */
  flatWater?: boolean;
  refresh?: boolean;
  provider?: ElevationProvider;
}

/** A WMS window, as a raw little-endian float32 BIL body. */
async function fetchBil(
  provider: ElevationProvider,
  layer: string,
  kind: RasterKind,
  bbox: RasterBBox,
  width: number,
  height: number,
): Promise<Float32Array> {
  if (!provider.url) throw new Error(`${provider.id} has neither url nor grid`);
  const res = await fetch(provider.url(layer, bbox, width, height));
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
  return new Float32Array(body);
}

/**
 * The raster, from the best provider that actually has data there.
 *
 * `covers` is a bounding box and a country is not. IGN's box has to hold France,
 * which means it also holds Belgium, Luxembourg, the Rhineland, Piedmont and
 * Catalonia — and IGN has nothing in any of them. Spa came out of P4.4's sweep
 * with a raster of **875 280 nodata and no valid pixel**, a city belt of zero
 * triangles, and no error anywhere: the coverage test said yes and the service
 * said nothing, which is not the same as the service saying nothing is there.
 *
 * So coverage is claimed by the box and confirmed by the answer. A provider that
 * returns an empty raster hands the circuit to the next one that covers it.
 */
export async function fetchElevationRaster(options: FetchRasterOptions): Promise<Raster> {
  const { bbox } = options;
  if (options.provider) return fetchFromProvider(options, options.provider);

  const candidates = PROVIDERS.filter((candidate) => candidate.covers(bbox));
  if (!candidates.length) {
    throw new Error(
      `no elevation provider covers ${JSON.stringify(bbox)} — see docs/city-generation.md §5.1`,
    );
  }
  let last: Raster | null = null;
  for (const candidate of candidates) {
    if (!candidate.layerFor(options.kind)) continue;
    const raster = await fetchFromProvider(options, candidate);
    last = raster;
    if (raster.header.validCount > 0) return raster;
    console.warn(
      `  ${candidate.id} has no data for ${options.kind} here — falling through`,
    );
  }
  if (!last) throw new Error(`no provider has a ${options.kind} layer for this bbox`);
  return last;
}

async function fetchFromProvider(
  options: FetchRasterOptions,
  provider: ElevationProvider,
): Promise<Raster> {
  const { kind, bbox, refresh = false } = options;
  const layer = provider.layerFor(kind);
  if (!layer) throw new Error(`${provider.id} has no layer for ${kind}`);

  const native = nativeGridSize(bbox, provider.nativeCellM, provider.maxPixels);
  const width = options.width ?? native.width;
  const height = options.height ?? native.height;
  const supersample = Math.max(1, Math.round(options.supersample ?? DEFAULT_SUPERSAMPLE));
  const fetchWidth = width * supersample;
  const fetchHeight = height * supersample;
  if (fetchWidth > provider.maxPixels || fetchHeight > provider.maxPixels) {
    throw new Error(
      `${provider.id} renders at most ${provider.maxPixels} px per side ` +
        `(asked ${fetchWidth} x ${fetchHeight} at ${supersample}x)`,
    );
  }

  const key = cacheKey(provider, kind, bbox, width, height);
  if (!refresh) {
    const cached = await readCachedRaster(key);
    if (cached) {
      cleanWater(cached, kind);
      return cached;
    }
  }

  await throttle(provider.minRequestIntervalMs);
  const fetched = provider.grid
    ? await provider.grid(layer, bbox, fetchWidth, fetchHeight)
    : await fetchBil(provider, layer, kind, bbox, fetchWidth, fetchHeight);
  maskNodata(fetched);
  // Erode at the fetched pitch first: a contaminated pixel that survives into a
  // block average drags the whole output cell below sea level, and the coast is
  // where that shows.
  // Two passes: the sentinel bleeds two pixels deep in places, and what the
  // first pass leaves behind is what dragged the coast to -13 m when the
  // output-pitch erosion was dropped.
  erodeNodata(fetched, fetchWidth, fetchHeight, 2);
  // Order matters at the shore. Water is marked at the fetched pitch, before
  // any averaging: a block straddling the quay would otherwise mix the basin's
  // fill into the wall and leave a low ramp where a vertical face belongs.
  // Averaging then skips those cells, so a half-water block takes the quay's
  // own height. One erosion, at the fetched pitch, is enough — the second at
  // the output pitch only ate another 3.9 m of coast.
  const flatWaterFetched =
    kind === "mnh" || options.flatWater === false
      ? 0
      : markFlatWater(
          fetched,
          fetchWidth,
          fetchHeight,
          FLAT_WATER_MIN_CELLS * supersample * supersample,
          FLAT_WATER_MAX_ELEVATION_M,
        );
  // After the water is known, and before averaging blurs a speck into its
  // neighbours: a boat left as land here becomes an islet in the harbour.
  const cellM = provider.nativeCellM / supersample;
  const cellAreaM2 = cellM ** 2;
  if (kind !== "mnh" && options.flatWater !== false) {
    // Order matters: opening first, so the flakes it cuts loose are then seen
    // as specks and removed rather than left floating in the basin.
    openLand(fetched, fetchWidth, fetchHeight, Math.max(1, Math.round(MIN_LAND_HALF_WIDTH_M / cellM)));
    despeckleLand(fetched, fetchWidth, fetchHeight, Math.max(1, Math.round(MIN_ISLAND_M2 / cellAreaM2)));
  }
  const flatWaterCells = Math.round(flatWaterFetched / (supersample * supersample));
  const reduced = downsample(fetched, fetchWidth, fetchHeight, supersample);
  const data = reduced.data;

  const size = bboxSizeMeters(bbox);
  const raster: Raster = {
    header: {
      schemaVersion: 1,
      kind,
      provider: provider.id,
      layer,
      width: reduced.width,
      height: reduced.height,
      bbox,
      supersample,
      flatWaterCells,
      pixelSizeM: { x: size.width / reduced.width, y: size.height / reduced.height },
      nativeCellM: provider.nativeCellM,
      fetchedAt: new Date().toISOString().slice(0, 10),
      ...summarise(data),
    },
    data,
  };

  await writeCachedRaster(key, raster);
  cleanWater(raster, kind);
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
