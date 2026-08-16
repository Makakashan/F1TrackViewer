/**
 * The height field: the one source of truth for ground level.
 *
 * docs/city-generation.md D2, D3, D15. Terrain, buildings, roads, water and the
 * track ribbon all read this, so none of them can disagree about where the
 * ground is — which is what made buildings float and the track cut through
 * hills when each of them sampled its own grid.
 *
 * Heights are metres above sea level, unshifted. `NaN` means no data, which at
 * a coastal circuit means the sea: the provider carries no bathymetry, so the
 * coastline is the nodata boundary rather than a second opinion from OSM.
 *
 * Storage is uniform at the provider's native cell, not the adaptive quadtree
 * §3.3 sketched. Monaco is 2 MB at 3.9 m — a build-time array, never shipped.
 * The belts in D3/D7 decide how finely each part of the *mesh* is built; making
 * the field itself adaptive would buy nothing and cost a lookup per sample.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { smoothTerrainTrackProfile } from "../../src/lib/track/elevation";
import {
  bboxSizeMeters,
  sampleRaster,
  type Raster,
  type RasterBBox,
} from "./raster";

// ─── types ─────────────────────────────────────────────────────────────────

export interface TrackConstraint {
  /** Centreline in lon/lat, densified by the builder. */
  coords: [number, number][];
  /** Half the driving surface, before the verge. Metres. */
  halfWidthM: number;
  /** Shoulder the ground meets flush. Wider suits a parkland circuit. */
  vergeM?: number;
  /** Distance over which the ground eases back to its own level. */
  blendM?: number;
  /**
   * Where the track runs under the ground rather than on it — the Monaco
   * tunnel. Burning those stretches in would carve a canyon through the hill
   * the road passes under, so the ground there keeps its own height and the
   * portals in the bake are what show the road going in.
   */
  buried?(lon: number, lat: number): boolean;
}

export interface HeightFieldStats {
  /** Centreline samples skipped because the track is under the ground there. */
  buriedSamples: number;
  cellsBurned: number;
  maxLiftM: number;
  maxCutM: number;
  cellsCreatedOverWater: number;
  trackMinM: number;
  trackMaxM: number;
}

export interface HeightField {
  bbox: RasterBBox;
  width: number;
  height: number;
  cellSizeM: { x: number; y: number };
  /** Row-major, north-up. NaN is nodata, which on the coast is the sea. */
  data: Float32Array;
  /** Elevation per densified centreline vertex, in the same datum. */
  trackProfile: { coords: [number, number][]; elevations: number[] };
  stats: HeightFieldStats;
  heightAt(lon: number, lat: number): number;
  heightAtNode(row: number, col: number): number;
  isWater(lon: number, lat: number): boolean;
}

// ─── constants ─────────────────────────────────────────────────────────────

/**
 * Paved shoulder the ground has to meet flush before it is allowed to rise.
 * Two metres, not the six §3.4 guessed: a street circuit's road is a shelf cut
 * into the slope with a wall at its edge, and a wide corridor flattens the
 * hillside the buildings stand on.
 */
const DEFAULT_VERGE_M = 2;
/**
 * Over this distance the ground eases from the track's level back to its own.
 * Short for the same reason — a 25 m ramp turns Monaco's retaining walls into
 * embankments and moved cells by up to 24 m when measured. Long enough only to
 * stop a one-cell cliff at the corridor edge.
 */
const DEFAULT_BLEND_M = 6;
/** Centreline step for the burn-in. Below the 3.9 m cell, so no cell is skipped. */
const TRACK_SAMPLE_M = 3;
/**
 * The DEM cell is now 3.9 m rather than 43 m, so the profile needs enough
 * smoothing to kill cell steps and no more — 120 m would flatten the climb to
 * Casino into a ramp.
 */
const TRACK_SMOOTH_RADIUS_M = 25;

const METERS_PER_DEG_LAT = 111_320;

// ─── local metric plane ────────────────────────────────────────────────────

interface Plane {
  toX(lon: number): number;
  toZ(lat: number): number;
  mPerDegLon: number;
}

function makePlane(bbox: RasterBBox): Plane {
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const mPerDegLon = METERS_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180);
  return {
    mPerDegLon,
    toX: (lon) => (lon - bbox.minLon) * mPerDegLon,
    toZ: (lat) => (bbox.maxLat - lat) * METERS_PER_DEG_LAT, // south is +Z, row order
  };
}

// ─── centreline ────────────────────────────────────────────────────────────

/** Split every segment so no step exceeds `stepM`. GeoJSON straights run 400 m. */
function densify(coords: [number, number][], stepM: number, plane: Plane): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const dx = plane.toX(b[0]) - plane.toX(a[0]);
    const dz = plane.toZ(b[1]) - plane.toZ(a[1]);
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / stepM));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/**
 * The track's own elevation, read from the same raster as the ground and then
 * put through the scene's existing profile cleanup, so the constraint the field
 * relaxes to is a drivable line rather than raw DEM noise.
 */
function trackElevationProfile(
  dtm: Raster,
  coords: [number, number][],
  buried?: (lon: number, lat: number) => boolean,
): number[] {
  // Inside a tunnel the raster describes the hill, not the road under it, so
  // those samples are thrown away and the road is carried between the portals
  // instead. Nothing else knows where a tunnelled road runs.
  const raw = coords.map(([lon, lat]) =>
    buried?.(lon, lat) ? Number.NaN : sampleRaster(dtm, lon, lat),
  );

  const filled = raw.slice();
  for (let i = 0; i < filled.length; i++) {
    if (!Number.isNaN(filled[i])) continue;
    let before = i - 1;
    while (before >= 0 && Number.isNaN(raw[before])) before--;
    let after = i + 1;
    while (after < raw.length && Number.isNaN(raw[after])) after++;
    if (before < 0 && after >= raw.length) {
      filled[i] = 0;
    } else if (before < 0) {
      filled[i] = raw[after];
    } else if (after >= raw.length) {
      filled[i] = raw[before];
    } else {
      const t = (i - before) / (after - before);
      filled[i] = raw[before] + (raw[after] - raw[before]) * t;
    }
  }

  return smoothTerrainTrackProfile(filled, coords, TRACK_SMOOTH_RADIUS_M);
}

// ─── burn-in ───────────────────────────────────────────────────────────────

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * Sets the field to the track's level inside the corridor and eases back to the
 * ground over `BLEND_M`. The ease never invents land where the raster says sea:
 * only the corridor itself may create ground, because the road is demonstrably
 * there.
 */
function burnTrack(
  data: Float32Array,
  width: number,
  height: number,
  plane: Plane,
  bbox: RasterBBox,
  coords: [number, number][],
  elevations: number[],
  halfWidthM: number,
  vergeM: number,
  blendM: number,
  buried: ((lon: number, lat: number) => boolean) | undefined,
): HeightFieldStats {
  const cellX = bboxSizeMeters(bbox).width / (width - 1);
  const cellZ = bboxSizeMeters(bbox).height / (height - 1);
  const hard = halfWidthM + vergeM;
  const reach = hard + blendM;

  // Nearest approach of the centreline to each touched cell, with the track's
  // elevation at that point. Per-cell minimum, so overlapping segments and the
  // start/finish join cannot fight.
  const bestDist = new Float32Array(width * height).fill(Infinity);
  const bestElev = new Float32Array(width * height);

  let buriedSamples = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    if (buried?.(coords[i][0], coords[i][1])) {
      buriedSamples++;
      continue;
    }
    const ax = plane.toX(coords[i][0]);
    const az = plane.toZ(coords[i][1]);
    const bx = plane.toX(coords[i + 1][0]);
    const bz = plane.toZ(coords[i + 1][1]);
    const ea = elevations[i];
    const eb = elevations[i + 1];

    const colFrom = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / cellX));
    const colTo = Math.min(width - 1, Math.ceil((Math.max(ax, bx) + reach) / cellX));
    const rowFrom = Math.max(0, Math.floor((Math.min(az, bz) - reach) / cellZ));
    const rowTo = Math.min(height - 1, Math.ceil((Math.max(az, bz) + reach) / cellZ));

    const abx = bx - ax;
    const abz = bz - az;
    const abLenSq = abx * abx + abz * abz;

    for (let row = rowFrom; row <= rowTo; row++) {
      const pz = row * cellZ;
      for (let col = colFrom; col <= colTo; col++) {
        const px = col * cellX;
        const t = abLenSq > 0
          ? Math.min(1, Math.max(0, ((px - ax) * abx + (pz - az) * abz) / abLenSq))
          : 0;
        const dx = px - (ax + abx * t);
        const dz = pz - (az + abz * t);
        const dist = Math.hypot(dx, dz);
        if (dist > reach) continue;
        const idx = row * width + col;
        if (dist >= bestDist[idx]) continue;
        bestDist[idx] = dist;
        bestElev[idx] = ea + (eb - ea) * t;
      }
    }
  }

  let cellsBurned = 0;
  let maxLiftM = 0;
  let maxCutM = 0;
  let cellsCreatedOverWater = 0;

  for (let idx = 0; idx < data.length; idx++) {
    const dist = bestDist[idx];
    if (!Number.isFinite(dist)) continue;
    const target = bestElev[idx];
    const ground = data[idx];

    if (dist <= hard) {
      if (Number.isNaN(ground)) cellsCreatedOverWater++;
      else {
        const delta = target - ground;
        if (delta > maxLiftM) maxLiftM = delta;
        if (-delta > maxCutM) maxCutM = -delta;
      }
      data[idx] = target;
      cellsBurned++;
      continue;
    }

    // Outside the corridor the ground keeps its own level where it has one, and
    // stays sea where it does not.
    if (Number.isNaN(ground)) continue;
    const blended = target + (ground - target) * smoothstep((dist - hard) / blendM);
    const delta = blended - ground;
    if (delta > maxLiftM) maxLiftM = delta;
    if (-delta > maxCutM) maxCutM = -delta;
    data[idx] = blended;
    cellsBurned++;
  }

  let trackMinM = Infinity;
  let trackMaxM = -Infinity;
  for (const v of elevations) {
    if (!Number.isFinite(v)) continue;
    if (v < trackMinM) trackMinM = v;
    if (v > trackMaxM) trackMaxM = v;
  }
  return {
    buriedSamples,
    cellsBurned,
    maxLiftM,
    maxCutM,
    cellsCreatedOverWater,
    trackMinM: Number.isFinite(trackMinM) ? trackMinM : 0,
    trackMaxM: Number.isFinite(trackMaxM) ? trackMaxM : 0,
  };
}

// ─── build ─────────────────────────────────────────────────────────────────

export interface BuildHeightFieldOptions {
  dtm: Raster;
  track: TrackConstraint;
}

export function buildHeightField(options: BuildHeightFieldOptions): HeightField {
  const { dtm, track } = options;
  const { bbox, width, height } = dtm.header;
  const plane = makePlane(bbox);

  const data = new Float32Array(dtm.data); // the raster stays untouched
  const coords = densify(track.coords, TRACK_SAMPLE_M, plane);
  const elevations = trackElevationProfile(dtm, coords, track.buried);
  const stats = burnTrack(
    data,
    width,
    height,
    plane,
    bbox,
    coords,
    elevations,
    track.halfWidthM,
    track.vergeM ?? DEFAULT_VERGE_M,
    track.blendM ?? DEFAULT_BLEND_M,
    track.buried,
  );

  const cellSizeM = {
    x: bboxSizeMeters(bbox).width / (width - 1),
    y: bboxSizeMeters(bbox).height / (height - 1),
  };

  function heightAtNode(row: number, col: number): number {
    const r = Math.min(height - 1, Math.max(0, row));
    const c = Math.min(width - 1, Math.max(0, col));
    return data[r * width + c];
  }

  /** Bilinear where the cell is whole; nearest valid corner where it straddles
   *  the shore, because averaging across nodata is what §5.5 warns about. */
  function heightAt(lon: number, lat: number): number {
    const u = (lon - bbox.minLon) / (bbox.maxLon - bbox.minLon);
    const v = (bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat);
    if (u < 0 || u > 1 || v < 0 || v > 1) return Number.NaN;

    const fx = u * (width - 1);
    const fy = v * (height - 1);
    const col = Math.min(width - 2, Math.floor(fx));
    const row = Math.min(height - 2, Math.floor(fy));
    const tx = fx - col;
    const ty = fy - row;

    const h00 = heightAtNode(row, col);
    const h10 = heightAtNode(row, col + 1);
    const h01 = heightAtNode(row + 1, col);
    const h11 = heightAtNode(row + 1, col + 1);

    if (!Number.isNaN(h00) && !Number.isNaN(h10) && !Number.isNaN(h01) && !Number.isNaN(h11)) {
      const top = h00 + (h10 - h00) * tx;
      const bottom = h01 + (h11 - h01) * tx;
      return top + (bottom - top) * ty;
    }

    const corners: [number, number][] = [
      [h00, (tx) ** 2 + (ty) ** 2],
      [h10, (1 - tx) ** 2 + (ty) ** 2],
      [h01, (tx) ** 2 + (1 - ty) ** 2],
      [h11, (1 - tx) ** 2 + (1 - ty) ** 2],
    ];
    let best = Number.NaN;
    let bestD = Infinity;
    for (const [value, d] of corners) {
      if (Number.isNaN(value) || d >= bestD) continue;
      best = value;
      bestD = d;
    }
    return best;
  }

  return {
    bbox,
    width,
    height,
    cellSizeM,
    data,
    trackProfile: { coords, elevations },
    stats,
    heightAt,
    heightAtNode,
    isWater: (lon, lat) => Number.isNaN(heightAt(lon, lat)),
  };
}

// ─── cache ─────────────────────────────────────────────────────────────────

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CACHE_DIR = join(REPO_ROOT, "data", "cache", "heightfield");

interface HeightFieldHeader {
  schemaVersion: 1;
  circuitId: string;
  bbox: RasterBBox;
  width: number;
  height: number;
  cellSizeM: { x: number; y: number };
  stats: HeightFieldStats;
  builtAt: string;
}

export async function writeHeightField(circuitId: string, field: HeightField): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const header: HeightFieldHeader = {
    schemaVersion: 1,
    circuitId,
    bbox: field.bbox,
    width: field.width,
    height: field.height,
    cellSizeM: field.cellSizeM,
    stats: field.stats,
    builtAt: new Date().toISOString().slice(0, 10),
  };
  await writeFile(join(CACHE_DIR, `${circuitId}.json`), JSON.stringify(header, null, 2));
  await writeFile(join(CACHE_DIR, `${circuitId}.f32`), Buffer.from(field.data.buffer));
}

export async function readHeightFieldHeader(
  circuitId: string,
): Promise<HeightFieldHeader | null> {
  try {
    return JSON.parse(
      await readFile(join(CACHE_DIR, `${circuitId}.json`), "utf8"),
    ) as HeightFieldHeader;
  } catch {
    return null;
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  bun scripts/env/heightfield.ts <circuitId> [--half-width=6] [--refresh]

Builds the height field for a circuit and reports what the burn-in did: how far
the ground moved to meet the track, and whether the corridor had to create any
ground where the raster says sea.`;

async function main() {
  const { fetchElevationRaster } = await import("./raster");
  const { loadCircuitCoords, circuitBBox } = await import("./circuit");

  const argv = process.argv.slice(2);
  const circuitId = argv.find((a) => !a.startsWith("--"));
  if (!circuitId || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const halfWidthM = Number(
    argv.find((a) => a.startsWith("--half-width="))?.split("=")[1] ?? 6,
  );

  const coords = await loadCircuitCoords(circuitId);
  const bbox = circuitBBox(coords);
  const dtm = await fetchElevationRaster({
    kind: "dtm",
    bbox,
    refresh: argv.includes("--refresh"),
  });

  const field = buildHeightField({ dtm, track: { coords, halfWidthM } });
  await writeHeightField(circuitId, field);

  let water = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of field.data) {
    if (Number.isNaN(v)) {
      water++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const s = field.stats;
  const cells = field.width * field.height;
  console.log(`height field — ${circuitId}`);
  console.log(`  grid          ${field.width} x ${field.height} @ ${field.cellSizeM.x.toFixed(2)} m`);
  console.log(`  ground        ${min.toFixed(2)} .. ${max.toFixed(2)} m`);
  console.log(`  water         ${((100 * water) / cells).toFixed(1)}% of cells`);
  console.log(`  track         ${s.trackMinM.toFixed(2)} .. ${s.trackMaxM.toFixed(2)} m over ${field.trackProfile.coords.length} samples`);
  console.log(`  burn-in       ${s.cellsBurned} cells (${((100 * s.cellsBurned) / cells).toFixed(1)}%)`);
  console.log(`  ground moved  up to +${s.maxLiftM.toFixed(2)} m up, ${s.maxCutM.toFixed(2)} m down`);
  console.log(`  over water    ${s.cellsCreatedOverWater} corridor cells had no ground`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
