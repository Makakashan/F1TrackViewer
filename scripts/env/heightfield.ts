/**
 * The height field: the one source of truth for ground level. Metres above sea, NaN
 * for no data, which at the coast is the sea. Build-time only, never shipped.
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

// types
export interface TrackConstraint {
  /** Centreline in lon/lat, densified by the builder. */
  coords: [number, number][];
  /** Half the driving surface, before the verge. Metres. */
  halfWidthM: number;
  /** Shoulder the ground meets flush. Wider suits a parkland circuit. */
  vergeM?: number;
  /** Distance over which the ground eases back to its own level. */
  blendM?: number;
  /** A surveyed wall or cliff between two points. The verge stops at it. */
  walls?(lon0: number, lat0: number, lon1: number, lat1: number): boolean;
  /**
   * Where the track runs underground. The raster sees the hill, so these heights are interpolated.
   */
  buried?(lon: number, lat: number): boolean;
  /**
   * Where a vault holds the hill up, so the ground keeps its height. Narrower than
   * `buried`: past the vault the road is in a cutting. Defaults to `buried`.
   */
  vaulted?(lon: number, lat: number): boolean;
}

export interface HeightFieldStats {
  /** Centreline samples left unburned because a vault holds the hill up. */
  vaultedSamples: number;
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

// constants
/**
 * Paved shoulder the ground meets flush: one terrain cell, so the slope starts
 * outside the ribbon.
 */
export const DEFAULT_VERGE_M = 4;
/**
 * Distance the ground eases back from track level. Longer turns retaining walls
 * into embankments.
 */
const DEFAULT_BLEND_M = 6;
/** Centreline step for the burn-in. Below the 3.9 m cell, so no cell is skipped. */
const TRACK_SAMPLE_M = 3;
/** Profile smoothing: enough to remove DEM cell steps, not enough to flatten the climb. */
/** Lowest a road outside a tunnel is laid: clear of the land held 0.25 m over the sea plane. */
const ROAD_FLOOR_M = 0.5;
const TRACK_SMOOTH_RADIUS_M = 25;

const METERS_PER_DEG_LAT = 111_320;

// local metric plane
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

// centreline
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

/** The track's elevation from the same raster, cleaned into a drivable line. */
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

  // A road in the open is above the sea. The DEM over a lagoon reads metres
  // under it, and at Jeddah the ribbon sank under the water and the ground.
  for (let i = 0; i < filled.length; i++) {
    if (!buried?.(coords[i][0], coords[i][1])) filled[i] = Math.max(filled[i], ROAD_FLOOR_M);
  }

  return smoothTerrainTrackProfile(filled, coords, TRACK_SMOOTH_RADIUS_M);
}

/** Burn to the chords the app draws between vertices, not the dense samples. */
function alongChords(
  elevations: number[],
  vertices: [number, number][],
  dense: [number, number][],
): number[] {
  const out = elevations.slice();
  let from = 0;
  for (let v = 1; v < vertices.length; v++) {
    let to = from + 1;
    while (to < dense.length - 1 && (dense[to][0] !== vertices[v][0] || dense[to][1] !== vertices[v][1])) to++;
    for (let i = from + 1; i < to; i++) {
      const t = (i - from) / (to - from);
      out[i] = elevations[from] + (elevations[to] - elevations[from]) * t;
    }
    from = to;
  }
  return out;
}

// burn-in
function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * Set the field to track level in the corridor, easing back over `BLEND_M`. Only
 * the corridor itself may turn sea into ground.
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
  vaulted: ((lon: number, lat: number) => boolean) | undefined,
  walls?: (lon0: number, lat0: number, lon1: number, lat1: number) => boolean,
): HeightFieldStats {
  const cellX = bboxSizeMeters(bbox).width / (width - 1);
  const cellZ = bboxSizeMeters(bbox).height / (height - 1);
  // The corridor must be wider than the grid cell, or on a 30 m grid it falls between nodes.
  const cell = Math.max(cellX, cellZ);
  const hard = Math.max(halfWidthM + vergeM, cell * 1.2);
  const reach = hard + Math.max(blendM, cell * 1.5);

  // Nearest approach of the centreline to each touched cell, with the track's
  // elevation at that point. Per-cell minimum, so overlapping segments and the
  // start/finish join cannot fight.
  const bestDist = new Float32Array(width * height).fill(Infinity);
  const bestElev = new Float32Array(width * height);
  // Where along the lap each claim came from, so two legs can be told from two
  // neighbouring stretches of one road.
  const bestArc = new Float32Array(width * height);
  const arcAt = [0];
  for (let i = 1; i < coords.length; i++) {
    arcAt.push(
      arcAt[i - 1]
        + Math.hypot(
          plane.toX(coords[i][0]) - plane.toX(coords[i - 1][0]),
          plane.toZ(coords[i][1]) - plane.toZ(coords[i - 1][1]),
        ),
    );
  }
  const lap = arcAt[arcAt.length - 1];

  // Stop the burn square at a vault's mouth with a plane, or the round end caps
  // flatten the hill the portal sits in.
  const clipRadius = reach + Math.hypot(cellX, cellZ);
  const mouths: { x: number; z: number; ux: number; uz: number }[] = [];
  if (vaulted) {
    for (let i = 0; i < coords.length - 1; i++) {
      const here = vaulted(coords[i][0], coords[i][1]);
      const next = vaulted(coords[i + 1][0], coords[i + 1][1]);
      if (here === next) continue;
      const inner = here ? i : i + 1;
      const outer = here ? i + 1 : i;
      const x = plane.toX(coords[inner][0]);
      const z = plane.toZ(coords[inner][1]);
      let ux = x - plane.toX(coords[outer][0]);
      let uz = z - plane.toZ(coords[outer][1]);
      const length = Math.hypot(ux, uz);
      if (length < 1e-6) continue;
      mouths.push({ x, z, ux: ux / length, uz: uz / length });
    }
  }
  const insideAVault = (px: number, pz: number) => {
    for (const mouth of mouths) {
      const dx = px - mouth.x;
      const dz = pz - mouth.z;
      if (dx * dx + dz * dz > clipRadius * clipRadius) continue;
      if (dx * mouth.ux + dz * mouth.uz > 0) return true;
    }
    return false;
  };

  let vaultedSamples = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    if (vaulted?.(coords[i][0], coords[i][1])) {
      vaultedSamples++;
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
        if (insideAVault(px, pz)) continue;
        const t = abLenSq > 0
          ? Math.min(1, Math.max(0, ((px - ax) * abx + (pz - az) * abz) / abLenSq))
          : 0;
        const dx = px - (ax + abx * t);
        const dz = pz - (az + abz * t);
        const dist = Math.hypot(dx, dz);
        if (dist > reach) continue;
        const toLon = (x: number) => bbox.minLon + x / plane.mPerDegLon;
        const toLat = (z: number) => bbox.maxLat - z / METERS_PER_DEG_LAT;
        if (
          walls
          && dist > halfWidthM
          && walls(toLon(ax + abx * t), toLat(az + abz * t), toLon(px), toLat(pz))
        ) continue;
        const idx = row * width + col;
        const elevation = ea + (eb - ea) * t;
        const arc = arcAt[i] + t * (arcAt[i + 1] - arcAt[i]);
        const apart = Math.abs(arc - bestArc[idx]);
        const otherLeg = Number.isFinite(bestDist[idx]) && Math.min(apart, lap - apart) > 3 * reach;
        // Where two legs of the lap meet, the lower road keeps the verge.
        const verge = (d: number) => d > halfWidthM - 4 && d <= hard;
        if (otherLeg && verge(dist) && verge(bestDist[idx])) {
          if (elevation >= bestElev[idx]) continue;
        } else if (dist >= bestDist[idx]) continue;
        bestDist[idx] = dist;
        bestElev[idx] = elevation;
        bestArc[idx] = arc;
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
    vaultedSamples,
    cellsBurned,
    maxLiftM,
    maxCutM,
    cellsCreatedOverWater,
    trackMinM: Number.isFinite(trackMinM) ? trackMinM : 0,
    trackMaxM: Number.isFinite(trackMaxM) ? trackMaxM : 0,
  };
}

// build
/** What a field carries when nothing was burned into it — a synthetic one. */
const EMPTY_STATS: HeightFieldStats = {
  vaultedSamples: 0,
  cellsBurned: 0,
  maxLiftM: 0,
  maxCutM: 0,
  cellsCreatedOverWater: 0,
  trackMinM: 0,
  trackMaxM: 0,
};

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
  const elevations = alongChords(trackElevationProfile(dtm, coords, track.buried), track.coords, coords);
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
    track.vaulted ?? track.buried,
    track.walls,
  );

  return heightFieldFrom({
    bbox,
    width,
    height,
    data,
    trackProfile: { coords, elevations },
    stats,
  });
}

export interface HeightFieldParts {
  bbox: RasterBBox;
  width: number;
  height: number;
  /** Row-major, north-up, NaN for nodata — the grid as it will be read. */
  data: Float32Array;
  trackProfile?: HeightField["trackProfile"];
  stats?: HeightFieldStats;
}

/** A field over a final grid. Tests come in here directly; the bake via `buildHeightField`. */
export function heightFieldFrom(parts: HeightFieldParts): HeightField {
  const { bbox, width, height, data } = parts;
  const cellSizeM = {
    x: bboxSizeMeters(bbox).width / (width - 1),
    y: bboxSizeMeters(bbox).height / (height - 1),
  };

  function heightAtNode(row: number, col: number): number {
    const r = Math.min(height - 1, Math.max(0, row));
    const c = Math.min(width - 1, Math.max(0, col));
    return data[r * width + c];
  }

  /**
   * Bilinear where the cell is whole; nearest valid corner at the shore, so nodata
   * never averages in.
   */
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
    trackProfile: parts.trackProfile ?? { coords: [], elevations: [] },
    stats: parts.stats ?? EMPTY_STATS,
    heightAt,
    heightAtNode,
    isWater: (lon, lat) => Number.isNaN(heightAt(lon, lat)),
  };
}

// cache
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

// CLI
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
