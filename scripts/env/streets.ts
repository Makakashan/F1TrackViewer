import type { Breaklines } from "./breaklines";
import type { HeightField } from "./heightfield";
import type { ScenePlane } from "./plane";
import type { StreetWay } from "./overpass";

/**
 * The level the town is built to, read off its streets.
 *
 * A DTM is bare earth, and in a town almost none of it is ever seen: what the
 * eye reads as ground is the streets, the squares and the courtyards between
 * the blocks. Monaco's bare earth climbs fifteen metres from the quay to
 * Avenue d'Ostende, and every one of them is buildings and retaining walls —
 * meshed as a height field it comes out as a hillock standing between the
 * blocks, which is what made the city read as a snowdrift.
 *
 * So the streets are laid into a raster of their own, every cell holding the
 * level of the street that runs through it; the gaps between them — the blocks
 * — are filled by letting those levels diffuse into the empty cells, and the
 * result is smoothed. That is a surface with no ridge or spike of its own: away
 * from a street it is the average of the streets around it, which is the level
 * a block is built to, and beyond the network's reach it fades out and the bare
 * field comes back, which is the open hillside above the town.
 */

/** Anchors this far apart along a way. Finer than the raster, so no cell is missed. */
const STEP_M = 6;
/** The raster's cell. A city block is three to six of these. */
const CELL_M = 8;
/** Inside this of a street the town's own level is the whole answer. */
const FULL_M = 35;
/** Past this the field is on its own again. */
const REACH_M = 90;
/**
 * A correction of this much is a block's ground being levelled, which is what
 * the streets are for. Past `STEEP_M` it is not a block at all — it is a cliff
 * or a retaining wall the network happens to run along the top of, and rewriting
 * that is how the coast came out shredded. Between the two the town lets go.
 */
const GENTLE_M = 4;
const STEEP_M = 12;
/**
 * A correction under this is not worth making. The raster is eight metres and
 * the core belt four, so a half-metre nudge lands as a facet per raster cell —
 * visible as blotches on ground that was already right.
 */
const DEAD_M = 0.4;
const ALIVE_M = 0.9;
/**
 * Slope, in degrees, at which the town stops speaking. A street's level says
 * what the block beside it is built to; it says nothing about the cliff the
 * block stands on, and laying it over one carved the coast into steps.
 */
const FLAT_DEG = 15;
const CLIFF_DEG = 28;
/**
 * How far a surveyed wall or cliff holds the town off.
 *
 * The level does not spread across a wall, so the two sides settle at different
 * heights — and the boundary between them is a raster edge, which drew the step
 * as a staircase of eight-metre treads along the quays. The field already holds
 * that step itself (the filter's window stops at the line), so the town simply
 * lets go as it comes near one.
 */
const WALL_CLEAR_M = 6;
const WALL_FULL_M = 20;
/** Diffusion passes: enough to cross a block, cheap enough to run every bake. */
const FILL_PASSES = 60;
/** Smoothing passes over the filled raster. */
const BLUR_PASSES = 2;
/** Smoothing passes over how much say the town has, so it fades in over cells. */
const WEIGHT_BLUR_PASSES = 3;
/**
 * Below this the town is not speaking, it is whispering: the smoothing leaves a
 * long tail of hundredths over open ground, and a correction that small is
 * ripple added to hillside the filter has already settled.
 */
const MIN_SAY = 0.05;
/** Where the circuit's own level is laid, measured from its centreline. */
const TRACK_OFFSETS_M = [-7, -3.5, 0, 3.5, 7];
/**
 * The track's own ground: the field is burned to its profile out to here
 * (`heightfield.ts`, half width and verge), and the town lets go of it over
 * `TRACK_FADE_M` beyond. Read off an eight-metre raster, a street beside the
 * road lifted the racing surface by up to a metre along the harbour.
 */
const TRACK_OWN_M = 8;
const TRACK_FADE_M = 8;
/** The classes that are ground a car or a crowd stands on. */
const GROUND_KINDS = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
  "residential", "living_street", "service", "pedestrian",
]);

export interface StreetGround {
  /** The town's level here and how much of the answer it is, or null where there is none. */
  at(x: number, z: number): { height: number; weight: number } | null;
  /** How many cells the network laid down. Zero means the field is untouched. */
  readonly count: number;
}

export function buildStreetGround(
  ways: StreetWay[],
  /** The circuit's own line: the one street whose course is known exactly. */
  track: [number, number][],
  field: HeightField,
  plane: ScenePlane,
  /** Surveyed walls and cliffs: the level may not spread across one. */
  breaklines?: Breaklines,
  /** Metres of land at a point; a pier's walkway is not ground to level. */
  landAt?: (x: number, z: number) => number,
): StreetGround {
  const minX = plane.x(field.bbox.minLon);
  const maxX = plane.x(field.bbox.maxLon);
  const minZ = plane.z(field.bbox.maxLat);
  const maxZ = plane.z(field.bbox.minLat);
  const cols = Math.max(1, Math.ceil((maxX - minX) / CELL_M) + 1);
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / CELL_M) + 1);

  const sum = new Float64Array(rows * cols);
  const hits = new Int32Array(rows * cols);
  // The circuit's own cells are kept apart: where the track and a street above
  // it land in one cell, the track's level is the one the road is drawn at, and
  // averaging the two lifts the ground through the racing surface.
  const trackSum = new Float64Array(rows * cols);
  const trackHits = new Int32Array(rows * cols);
  let laid = 0;

  const lay = (x: number, z: number, onTrack = false, at = field.heightAt(plane.lon(x), plane.lat(z))) => {
    const height = at;
    if (Number.isNaN(height)) return;
    if (!onTrack && landAt && landAt(x, z) <= 0) return;
    const col = Math.round((x - minX) / CELL_M);
    const row = Math.round((z - minZ) / CELL_M);
    if (row < 0 || col < 0 || row >= rows || col >= cols) return;
    const index = row * cols + col;
    if (hits[index] === 0 && trackHits[index] === 0) laid++;
    if (onTrack) {
      trackSum[index] += height;
      trackHits[index]++;
      return;
    }
    sum[index] += height;
    hits[index]++;
  };

  for (const way of ways) {
    if (way.offGround) continue;
    if (!GROUND_KINDS.has(way.highway)) continue;
    for (let i = 1; i < way.points.length; i++) {
      const ax = plane.x(way.points[i - 1][0]);
      const az = plane.z(way.points[i - 1][1]);
      const bx = plane.x(way.points[i][0]);
      const bz = plane.z(way.points[i][1]);
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP_M));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        lay(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    }
  }

  // Across the road, not along its middle: the corridor is fourteen metres and a
  // street one cell off it would otherwise own the ground the cars drive on. At
  // the centreline's height all the way across — a road is level from kerb to
  // kerb, and seven metres out the field is the slope beside it, which lifted
  // the racing surface by a metre along the harbour.
  for (let i = 1; i < track.length; i++) {
    const ax = plane.x(track[i - 1][0]);
    const az = plane.z(track[i - 1][1]);
    const bx = plane.x(track[i][0]);
    const bz = plane.z(track[i][1]);
    const length = Math.hypot(bx - ax, bz - az);
    if (!(length > 0)) continue;
    const nx = -(bz - az) / length;
    const nz = (bx - ax) / length;
    const steps = Math.max(1, Math.ceil(length / STEP_M));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const centre = field.heightAt(plane.lon(x), plane.lat(z));
      for (const off of TRACK_OFFSETS_M) lay(x + nx * off, z + nz * off, true, centre);
    }
  }

  if (!laid) {
      return { count: 0, at: () => null };
  }

  // A surveyed wall or cliff is the reason two sides sit at different heights,
  // so nothing crosses one: not the fill, not the smoothing, not the reach.
  const wallRight = new Uint8Array(rows * cols);
  const wallDown = new Uint8Array(rows * cols);
  if (breaklines?.count) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        const x = minX + col * CELL_M;
        const z = minZ + row * CELL_M;
        const lon = plane.lon(x);
        const lat = plane.lat(z);
        if (col < cols - 1) {
          wallRight[index] = breaklines.crossesLonLat(lon, lat, plane.lon(x + CELL_M), lat) ? 1 : 0;
        }
        if (row < rows - 1) {
          wallDown[index] = breaklines.crossesLonLat(lon, lat, lon, plane.lat(z + CELL_M)) ? 1 : 0;
        }
      }
    }
  }
  // Distance to the nearest wall cell, in cells, by the same two sweeps.
  const wallAway = new Float32Array(rows * cols).fill(1e9);
  const openRight = (row: number, col: number) =>
    row >= 0 && row < rows && col >= 0 && col < cols - 1 && !wallRight[row * cols + col];
  const openDown = (row: number, col: number) =>
    row >= 0 && row < rows - 1 && col >= 0 && col < cols && !wallDown[row * cols + col];

  if (breaklines?.count) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (!wallRight[index] && !wallDown[index]) continue;
        wallAway[index] = 0;
        if (col < cols - 1) wallAway[index + 1] = 0;
        if (row < rows - 1) wallAway[index + cols] = 0;
      }
    }
    const spread = (index: number, from: number, step: number) => {
      const candidate = wallAway[from] + step;
      if (candidate < wallAway[index]) wallAway[index] = candidate;
    };
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (row > 0) spread(index, index - cols, 1);
        if (col > 0) spread(index, index - 1, 1);
        if (row > 0 && col > 0) spread(index, index - cols - 1, Math.SQRT2);
        if (row > 0 && col < cols - 1) spread(index, index - cols + 1, Math.SQRT2);
      }
    }
    for (let row = rows - 1; row >= 0; row--) {
      for (let col = cols - 1; col >= 0; col--) {
        const index = row * cols + col;
        if (row < rows - 1) spread(index, index + cols, 1);
        if (col < cols - 1) spread(index, index + 1, 1);
        if (row < rows - 1 && col < cols - 1) spread(index, index + cols + 1, Math.SQRT2);
        if (row < rows - 1 && col > 0) spread(index, index + cols - 1, Math.SQRT2);
      }
    }
  }

  // Distance to the nearest street, in cells, by two chamfer passes.
  const FAR = 1e9;
  const distance = new Float32Array(rows * cols).fill(FAR);
  for (let i = 0; i < distance.length; i++) if (hits[i] || trackHits[i]) distance[i] = 0;
  const relax = (index: number, from: number, step: number) => {
    const candidate = distance[from] + step;
    if (candidate < distance[index]) distance[index] = candidate;
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      if (openDown(row - 1, col)) relax(index, index - cols, 1);
      if (openRight(row, col - 1)) relax(index, index - 1, 1);
      if (openDown(row - 1, col) && openRight(row - 1, col - 1)) relax(index, index - cols - 1, Math.SQRT2);
      if (openDown(row - 1, col) && openRight(row - 1, col)) relax(index, index - cols + 1, Math.SQRT2);
    }
  }
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      const index = row * cols + col;
      if (openDown(row, col)) relax(index, index + cols, 1);
      if (openRight(row, col)) relax(index, index + 1, 1);
      if (openDown(row, col) && openRight(row + 1, col)) relax(index, index + cols + 1, Math.SQRT2);
      if (openDown(row, col) && openRight(row + 1, col - 1)) relax(index, index + cols - 1, Math.SQRT2);
    }
  }

  // The streets' own levels, then the gaps filled from them. A cell with a
  // street keeps its reading; every other cell settles to the average of its
  // neighbours, which over enough passes is the levels around the block.
  let level = new Float64Array(rows * cols);
  for (let i = 0; i < level.length; i++) {
    level[i] = trackHits[i]
      ? trackSum[i] / trackHits[i]
      : hits[i]
        ? sum[i] / hits[i]
        : Number.NaN;
  }
  // Somewhere to start: the nearest street's level, spread by the same sweeps
  // the distance was, so the diffusion begins near its answer rather than at
  // zero and sixty passes are enough to settle a block.
  const seed = new Float64Array(level);
  const carry = (index: number, from: number) => {
    if (Number.isNaN(seed[index]) && !Number.isNaN(seed[from])) seed[index] = seed[from];
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      if (openDown(row - 1, col)) carry(index, index - cols);
      if (openRight(row, col - 1)) carry(index, index - 1);
    }
  }
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      const index = row * cols + col;
      if (openDown(row, col)) carry(index, index + cols);
      if (openRight(row, col)) carry(index, index + 1);
    }
  }
  for (let i = 0; i < level.length; i++) if (Number.isNaN(level[i])) level[i] = seed[i];

  let next = new Float64Array(level.length);
  for (let pass = 0; pass < FILL_PASSES + BLUR_PASSES; pass++) {
    // The last passes smooth the ordinary streets too: a street held hard
    // against a settled block is a ridge along its kerb, drawn as an eight
    // metre step. The circuit's own cells are never smoothed — the road is
    // drawn at its own level and the ground has to meet it there.
    const hold = pass < FILL_PASSES;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (trackHits[index] || (hold && hits[index])) {
          next[index] = level[index];
          continue;
        }
        let total = level[index];
        let count = 1;
        if (openDown(row - 1, col)) { total += level[index - cols]; count++; }
        if (openDown(row, col)) { total += level[index + cols]; count++; }
        if (openRight(row, col - 1)) { total += level[index - 1]; count++; }
        if (openRight(row, col)) { total += level[index + 1]; count++; }
        next[index] = total / count;
      }
    }
    const swap = level;
    level = next;
    next = swap;
  }

  // The bare field at the raster's own resolution, and from it the two things
  // the town is judged by: how steep the ground is, and how far the town is
  // asking it to move. Both are read off the raster rather than per query — on
  // a DTM as rough as this one, gating on a point sample makes the correction
  // flicker from node to node, and a flickering correction is drawn as a
  // staircase of cells.
  const bare = new Float64Array(rows * cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const height = field.heightAt(
        plane.lon(minX + col * CELL_M),
        plane.lat(minZ + row * CELL_M),
      );
      bare[row * cols + col] = height;
    }
  }

  let weight = new Float64Array(rows * cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      const here = bare[index];
      if (Number.isNaN(here)) continue;
      // The circuit's own cells are not up for judgement: the road is drawn at
      // this level and the ground has to meet it, however small the move.
      if (trackHits[index]) {
        weight[index] = 1;
        continue;
      }
      const away = distance[index] * CELL_M;
      if (away >= REACH_M) continue;
      const fromWall = wallAway[index] * CELL_M;
      if (fromWall <= WALL_CLEAR_M) continue;

      const east = bare[row * cols + Math.min(cols - 1, col + 1)];
      const west = bare[row * cols + Math.max(0, col - 1)];
      const south = bare[Math.min(rows - 1, row + 1) * cols + col];
      const north = bare[Math.max(0, row - 1) * cols + col];
      if ([east, west, south, north].some(Number.isNaN)) continue;
      const run = Math.hypot((east - west) / (2 * CELL_M), (south - north) / (2 * CELL_M));
      const slope = (Math.atan(run) * 180) / Math.PI;
      if (slope >= CLIFF_DEG) continue;

      const move = Math.abs(level[index] - here);
      if (move <= DEAD_M || move >= STEEP_M) continue;

      const near = away <= FULL_M ? 1 : 1 - (away - FULL_M) / (REACH_M - FULL_M);
      const gentle = move <= GENTLE_M ? 1 : 1 - (move - GENTLE_M) / (STEEP_M - GENTLE_M);
      const worth = move >= ALIVE_M ? 1 : (move - DEAD_M) / (ALIVE_M - DEAD_M);
      const flat = slope <= FLAT_DEG ? 1 : 1 - (slope - FLAT_DEG) / (CLIFF_DEG - FLAT_DEG);
      const clear = fromWall >= WALL_FULL_M
        ? 1
        : (fromWall - WALL_CLEAR_M) / (WALL_FULL_M - WALL_CLEAR_M);
      weight[index] = near * gentle * worth * flat * clear;
    }
  }

  // Smoothed, so the town takes hold and lets go over a few cells rather than
  // at one cell's edge. The circuit's own cells keep the full say: the road is
  // drawn at its level and the ground has to meet it.
  let nextWeight = new Float64Array(weight.length);
  for (let pass = 0; pass < WEIGHT_BLUR_PASSES; pass++) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (trackHits[index]) {
          nextWeight[index] = weight[index];
          continue;
        }
        let total = weight[index];
        let count = 1;
        if (row > 0) { total += weight[index - cols]; count++; }
        if (row < rows - 1) { total += weight[index + cols]; count++; }
        if (col > 0) { total += weight[index - 1]; count++; }
        if (col < cols - 1) { total += weight[index + 1]; count++; }
        nextWeight[index] = total / count;
      }
    }
    const swap = weight;
    weight = nextWeight;
    nextWeight = swap;
  }

  const sample = (grid: Float64Array | Float32Array, x: number, z: number): number => {
    const fx = Math.min(cols - 1, Math.max(0, (x - minX) / CELL_M));
    const fz = Math.min(rows - 1, Math.max(0, (z - minZ) / CELL_M));
    const col = Math.min(cols - 2, Math.floor(fx));
    const row = Math.min(rows - 2, Math.floor(fz));
    const u = fx - col;
    const v = fz - row;
    const a = grid[row * cols + col];
    const b = grid[row * cols + col + 1];
    const c = grid[(row + 1) * cols + col];
    const d = grid[(row + 1) * cols + col + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };

  // Distance to the centreline, from segments bucketed on the same raster.
  const segments: number[][] = [];
  const buckets = new Map<number, number[]>();
  const reach = TRACK_OWN_M + TRACK_FADE_M;
  for (let i = 1; i < track.length; i++) {
    const seg = [plane.x(track[i - 1][0]), plane.z(track[i - 1][1]), plane.x(track[i][0]), plane.z(track[i][1])];
    const id = segments.push(seg) - 1;
    const c0 = Math.floor((Math.min(seg[0], seg[2]) - reach - minX) / CELL_M);
    const c1 = Math.floor((Math.max(seg[0], seg[2]) + reach - minX) / CELL_M);
    const r0 = Math.floor((Math.min(seg[1], seg[3]) - reach - minZ) / CELL_M);
    const r1 = Math.floor((Math.max(seg[1], seg[3]) + reach - minZ) / CELL_M);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = r * 100_003 + c;
        const list = buckets.get(key);
        if (list) list.push(id);
        else buckets.set(key, [id]);
      }
    }
  }
  const fromTrack = (x: number, z: number): number => {
    const key = Math.floor((z - minZ) / CELL_M) * 100_003 + Math.floor((x - minX) / CELL_M);
    let best = Infinity;
    for (const id of buckets.get(key) ?? []) {
      const [ax, az, bx, bz] = segments[id];
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
    }
    return best;
  };

  return {
    count: laid,
    at(x, z) {
      const away = fromTrack(x, z);
      if (away <= TRACK_OWN_M) return null;
      const t = Math.min(1, (away - TRACK_OWN_M) / TRACK_FADE_M);
      const share = sample(weight, x, z) * t * t * (3 - 2 * t);
      if (!(share > MIN_SAY)) return null;
      const height = sample(level, x, z);
      if (Number.isNaN(height)) return null;
      return { height, weight: Math.min(1, share) };
    },
  };
}
