/**
 * The ground as one surface that every part of the bake asks for heights. A belt
 * box-averages the field (stopping at surveyed walls) instead of point-sampling it,
 * and `at()` picks the same triangle the mesh draws.
 */

import type { Breaklines } from "./breaklines";
import { BELT_CELL_M, type Belt } from "./belts";
import type { HeightField } from "./heightfield";
import type { ScenePlane } from "./plane";
import type { StreetGround } from "./streets";

export interface BeltGrid {
  cell: number;
  cols: number;
  rows: number;
  minX: number;
  minZ: number;
  /** Field nodes averaged per belt node, as a radius. Zero is a plain sample. */
  radius: number;
}

export interface Ground {
  gridFor(belt: Belt): BeltGrid;
  /** Filtered height at a belt's grid node. NaN is water. */
  nodeAt(belt: Belt, row: number, col: number): number;
  /** Height of the surface the belt meshes, at a scene point. NaN is water. */
  at(x: number, z: number, belt: Belt): number;
  /** Highest a belt's node may stand for the shoreline beside it (`shoreCeiling`); a node with no reading of its own needs it too. */
  ceilingAt(belt: Belt, row: number, col: number): number;
}

/** Filter window width in field nodes. A belt at the field's own cell needs none. */
function radiusFor(cellM: number, fieldCellM: number): number {
  return Math.max(0, Math.round(cellM / fieldCellM / 2 - 0.5));
}

/** Smoothing passes over a belt's nodes. Many gentle passes, so no node overshoots. */
export const SMOOTH_PASSES = 16;
/**
 * Pull toward neighbours per pass, flat and on a face. A DTM draws cliffs as spikes,
 * so steeper ground pulls harder.
 */
const FLAT_STRENGTH = 0.09;
const FACE_STRENGTH = 0.55;
/** Slope, in degrees, over which the ground counts wholly as a face. */
const FACE_FROM_DEG = 25;
const FACE_FULL_DEG = 45;
/** Cells of fade: at the wall no smoothing, this far off it the full strength. */
const WALL_FADE_CELLS = 2;
/** Stand-in for "no wall anywhere near", in cells. */
const FAR_FROM_WALL = 1e6;
/** Steepest face the ground keeps between two neighbouring nodes, and how many passes it gets to settle. */
export const MAX_SLOPE_DEG = 55;
/** Highest the ground stands where it meets the water: a quay's lip, not a cliff's brow. */
export const SHORE_LIP_M = 3;

/** Highest the ground may stand this far from the shore: the lip, then capped slope. */
export function shoreCeiling(land: number): number {
  return land > 0 ? SHORE_LIP_M + land * Math.tan((MAX_SLOPE_DEG * Math.PI) / 180) : Infinity;
}

/** Metres from each node to the nearest shore crossing, swept both ways twice. */
export function distanceToShore(land: Float32Array, width: number, height: number, cell: number): Float32Array {
  const crossX: number[] = [];
  const crossZ: number[] = [];
  const nearest = new Int32Array(width * height).fill(-1);
  const away = new Float32Array(width * height).fill(Infinity);
  const offer = (index: number, crossing: number): void => {
    const dx = crossX[crossing] - (index % width);
    const dz = crossZ[crossing] - Math.floor(index / width);
    const distance = Math.hypot(dx, dz) * cell;
    if (distance < away[index]) {
      away[index] = distance;
      nearest[index] = crossing;
    }
  };
  for (let index = 0; index < width * height; index++) {
    const col = index % width;
    for (const next of [col < width - 1 ? index + 1 : -1, index + width < width * height ? index + width : -1]) {
      if (next < 0 || land[index] > 0 === land[next] > 0) continue;
      const t = land[index] / (land[index] - land[next]);
      crossX.push(col + (next === index + 1 ? t : 0));
      crossZ.push(Math.floor(index / width) + (next === index + 1 ? 0 : t));
      offer(index, crossX.length - 1);
      offer(next, crossX.length - 1);
    }
  }
  const sweep = (from: number, to: number, step: number, neighbours: [number, number][]): void => {
    for (let index = from; index !== to; index += step) {
      const row = Math.floor(index / width);
      const col = index % width;
      for (const [dr, dc] of neighbours) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || c < 0 || r >= height || c >= width) continue;
        const crossing = nearest[r * width + c];
        if (crossing >= 0) offer(index, crossing);
      }
    }
  };
  for (let round = 0; round < 2; round++) {
    sweep(0, width * height, 1, [[-1, -1], [-1, 0], [-1, 1], [0, -1]]);
    sweep(width * height - 1, -1, -1, [[1, 1], [1, 0], [1, -1], [0, 1]]);
  }
  return away;
}

const SLOPE_PASSES = 64;
/** Rounds of smoothing and limiting again after the first limit. */
export const SETTLE_ROUNDS = 12;

/** Split the cell along the ground, not across it, or a diagonal ridge draws as a saw. */
export function splitsOnMain(h00: number, h01: number, h11: number, h10: number): boolean {
  return !(Math.abs(h01 - h10) < Math.abs(h00 - h11));
}
/** Four neighbours, not eight: a diagonal is a cell and a half away. */
const NEIGHBOURS = 4;

/** Summed-area tables: a window average in four lookups, ignoring nodata. */
function summedArea(field: HeightField): { sums: Float64Array; counts: Uint32Array } {
  const { width, height, data } = field;
  const stride = width + 1;
  const sums = new Float64Array(stride * (height + 1));
  const counts = new Uint32Array(stride * (height + 1));
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const value = data[row * width + col];
      const valid = Number.isNaN(value) ? 0 : 1;
      const at = (row + 1) * stride + col + 1;
      sums[at] = (valid ? value : 0) + sums[at - 1] + sums[at - stride] - sums[at - stride - 1];
      counts[at] = valid + counts[at - 1] + counts[at - stride] - counts[at - stride - 1];
    }
  }
  return { sums, counts };
}

export function buildGround(
  field: HeightField,
  plane: ScenePlane,
  breaklines?: Breaklines,
  /** The level the town is built to, where there is a town; see `streets.ts`. */
  streets?: StreetGround,
  /** The road's level at a node, NaN off it. A node on the road is held there. */
  roadAt?: (x: number, z: number) => number,
  /** Metres from the shoreline, positive on land. */
  landAt?: (x: number, z: number) => number,
): Ground {
  const { sums, counts } = summedArea(field);
  const stride = field.width + 1;
  const fieldCellM = (field.cellSizeM.x + field.cellSizeM.y) / 2;

  const minX = plane.x(field.bbox.minLon);
  const maxX = plane.x(field.bbox.maxLon);
  const minZ = plane.z(field.bbox.maxLat); // the north edge is the smaller Z
  const maxZ = plane.z(field.bbox.minLat);

  const clampRow = (row: number) => Math.max(0, Math.min(field.height - 1, row));
  const clampCol = (col: number) => Math.max(0, Math.min(field.width - 1, col));

  /** Mean of the valid field nodes in a square window, NaN if there are none. */
  const windowMean = (row: number, col: number, radius: number): number => {
    const rowFrom = clampRow(row - radius);
    const rowTo = clampRow(row + radius);
    const colFrom = clampCol(col - radius);
    const colTo = clampCol(col + radius);

    // Walk the window node by node only when a surveyed line is in it; elsewhere the
    // tables answer.
    if (breaklines?.count && breaklines.near(colFrom, rowFrom, colTo, rowTo)) {
      let sum = 0;
      let count = 0;
      for (let r = rowFrom; r <= rowTo; r++) {
        for (let c = colFrom; c <= colTo; c++) {
          const value = field.data[r * field.width + c];
          if (Number.isNaN(value)) continue;
          // A node on the far side of a wall says nothing about this side.
          if ((r !== row || c !== col) && breaklines.crosses(col, row, c, r)) continue;
          sum += value;
          count++;
        }
      }
      // Only its own node is left when a line runs between it and every
      // neighbour, which is the answer: an unfiltered sample on a knife edge.
      return count === 0 ? field.data[clampRow(row) * field.width + clampCol(col)] : sum / count;
    }

    const bottom = (rowTo + 1) * stride;
    const top = rowFrom * stride;
    const right = colTo + 1;
    const left = colFrom;
    const count = counts[bottom + right] - counts[bottom + left] - counts[top + right] + counts[top + left];
    if (count === 0) return Number.NaN;
    const sum = sums[bottom + right] - sums[bottom + left] - sums[top + right] + sums[top + left];
    return sum / count;
  };

  const grids = {} as Record<Belt, BeltGrid>;
  const nodes = {} as Record<Belt, Float32Array>;
  const ceilings = {} as Record<Belt, Float32Array>;

  const gridFor = (belt: Belt): BeltGrid => {
    const existing = grids[belt];
    if (existing) return existing;
    const cell = BELT_CELL_M[belt];
    const grid: BeltGrid = {
      cell,
      cols: Math.floor((maxX - minX) / cell),
      rows: Math.floor((maxZ - minZ) / cell),
      minX,
      minZ,
      radius: radiusFor(cell, fieldCellM),
    };
    grids[belt] = grid;
    return grid;
  };

  /** A belt's nodes computed once, with a margin ring for the mesher's neighbour lookups. */
  const nodesFor = (belt: Belt): Float32Array => {
    const existing = nodes[belt];
    if (existing) return existing;
    const grid = gridFor(belt);
    const width = grid.cols + 3;
    const height = grid.rows + 3;
    const table = new Float32Array(width * height);
    const held = new Uint8Array(width * height);
    for (let row = -1; row <= grid.rows + 1; row++) {
      for (let col = -1; col <= grid.cols + 1; col++) {
        const x = minX + col * grid.cell;
        const z = minZ + row * grid.cell;
        const lon = plane.lon(x);
        const lat = plane.lat(z);
        let value: number;
        const road = roadAt?.(x, z) ?? Number.NaN;
        if (!Number.isNaN(road)) {
          held[(row + 1) * width + col + 1] = 1;
          value = road;
        } else if (grid.radius === 0) {
          value = field.heightAt(lon, lat);
        } else {
          // The window is centred on the field node nearest the belt node, so
          // the average is symmetric about the point it stands for.
          const u = (lon - field.bbox.minLon) / (field.bbox.maxLon - field.bbox.minLon);
          const v = (field.bbox.maxLat - lat) / (field.bbox.maxLat - field.bbox.minLat);
          value = windowMean(
            Math.round(v * (field.height - 1)),
            Math.round(u * (field.width - 1)),
            grid.radius,
          );
        }
        table[(row + 1) * width + col + 1] = value;
      }
    }

    // Extra smoothing between cells, fading out near a surveyed wall. A hard cut at
    // the wall flipped neighbours node to node and came out rougher.
    const wallAway = new Float32Array(width * height).fill(FAR_FROM_WALL);
    if (breaklines?.count) {
      for (let row = -1; row <= grid.rows + 1; row++) {
        for (let col = -1; col <= grid.cols + 1; col++) {
          const lon = plane.lon(minX + col * grid.cell);
          const lat = plane.lat(minZ + row * grid.cell);
          const east = plane.lon(minX + (col + 1) * grid.cell);
          const south = plane.lat(minZ + (row + 1) * grid.cell);
          if (
            breaklines.crossesLonLat(lon, lat, east, lat)
            || breaklines.crossesLonLat(lon, lat, lon, south)
          ) {
            wallAway[(row + 1) * width + col + 1] = 0;
          }
        }
      }
      const spread = (index: number, from: number) => {
        const candidate = wallAway[from] + 1;
        if (candidate < wallAway[index]) wallAway[index] = candidate;
      };
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const index = row * width + col;
          if (row > 0) spread(index, index - width);
          if (col > 0) spread(index, index - 1);
        }
      }
      for (let row = height - 1; row >= 0; row--) {
        for (let col = width - 1; col >= 0; col--) {
          const index = row * width + col;
          if (row < height - 1) spread(index, index + width);
          if (col < width - 1) spread(index, index + 1);
        }
      }
    }

    // How hard each node is pulled, from how steep the bare ground is there.
    const pull = new Float32Array(width * height);
    const faceShare = new Float32Array(width * height);
    for (let row = -1; row <= grid.rows + 1; row++) {
      for (let col = -1; col <= grid.cols + 1; col++) {
        const x = minX + col * grid.cell;
        const z = minZ + row * grid.cell;
        const inside = (px: number, pz: number): boolean => {
          const lon = plane.lon(px);
          const lat = plane.lat(pz);
          return (
            lon >= field.bbox.minLon && lon <= field.bbox.maxLon
            && lat >= field.bbox.minLat && lat <= field.bbox.maxLat
          );
        };
        const here = field.heightAt(plane.lon(x), plane.lat(z));
        const east = field.heightAt(plane.lon(x + grid.cell), plane.lat(z));
        const west = field.heightAt(plane.lon(x - grid.cell), plane.lat(z));
        const south = field.heightAt(plane.lon(x), plane.lat(z + grid.cell));
        const north = field.heightAt(plane.lon(x), plane.lat(z - grid.cell));
        // At the water the slope is read from the side that has ground, or the
        // last row of land before a cliff reads flat. Past the bbox there is no
        // ground either side, so that node keeps the flat pull it had.
        const gradient = (ahead: number, behind: number, aheadIn: boolean, behindIn: boolean): number => {
          if (!Number.isNaN(ahead) && !Number.isNaN(behind)) return (ahead - behind) / (2 * grid.cell);
          if (Number.isNaN(here) || !aheadIn || !behindIn) return Number.NaN;
          if (!Number.isNaN(ahead)) return (ahead - here) / grid.cell;
          if (!Number.isNaN(behind)) return (here - behind) / grid.cell;
          return Number.NaN;
        };
        const alongX = gradient(east, west, inside(x + grid.cell, z), inside(x - grid.cell, z));
        const alongZ = gradient(south, north, inside(x, z + grid.cell), inside(x, z - grid.cell));
        let face = 0;
        if (!Number.isNaN(alongX) || !Number.isNaN(alongZ)) {
          const run = Math.hypot(
            Number.isNaN(alongX) ? 0 : alongX,
            Number.isNaN(alongZ) ? 0 : alongZ,
          );
          const slope = (Math.atan(run) * 180) / Math.PI;
          face = Math.max(0, Math.min(1, (slope - FACE_FROM_DEG) / (FACE_FULL_DEG - FACE_FROM_DEG)));
        }
        const index = (row + 1) * width + col + 1;
        faceShare[index] = face;
        pull[index] = FLAT_STRENGTH + (FACE_STRENGTH - FLAT_STRENGTH) * face;
      }
    }

    const settled = new Float32Array(table);
    const smoothPass = (): void => {
      const before = new Float32Array(settled);
      for (let row = -1; row <= grid.rows + 1; row++) {
        for (let col = -1; col <= grid.cols + 1; col++) {
          const index = (row + 1) * width + col + 1;
          const here = before[index];
          if (Number.isNaN(here) || held[index]) continue;
          const away = wallAway[index];
          const lon = plane.lon(minX + col * grid.cell);
          const lat = plane.lat(minZ + row * grid.cell);
          /** NaN is water, undefined is off the table. */
          const neighbour = (dr: number, dc: number): number | undefined => {
            const r = row + dr;
            const c = col + dc;
            if (r < -1 || c < -1 || r > grid.rows + 1 || c > grid.cols + 1) return undefined;
            return before[(r + 1) * width + c + 1];
          };
          // A built wall is not averaged across, and a node beside one is left
          // alone. A natural cliff is the rock itself, not a step between two
          // flats, so it is crossed where the ground is steep.
          const walled = (dr: number, dc: number): boolean => {
            if (!breaklines?.count) return false;
            const neighbourLon = plane.lon(minX + (col + dc) * grid.cell);
            const neighbourLat = plane.lat(minZ + (row + dr) * grid.cell);
            return (
              breaklines.crossesWallLonLat(lon, lat, neighbourLon, neighbourLat)
              || (faceShare[index] < 0.5
                && breaklines.crossesLonLat(lon, lat, neighbourLon, neighbourLat))
            );
          };
          // One axis at a time, mirroring the sea, so the brow along the shore still smooths.
          let sum = 0;
          let blocked = false;
          for (const [dr, dc] of [[-1, 0], [0, -1]] as const) {
            if (walled(dr, dc) || walled(-dr, -dc)) { blocked = true; break; }
            const back = neighbour(dr, dc);
            const forth = neighbour(-dr, -dc);
            // Past the bbox there is nothing to reflect: leave the node be.
            if (back === undefined || forth === undefined) { blocked = true; break; }
            // The mirror is `2 * here - dry`, so a wet axis averages to `here`.
            sum += Number.isNaN(back) || Number.isNaN(forth) ? 2 * here : back + forth;
          }
          if (blocked) continue;
          const clear = Math.min(1, away / WALL_FADE_CELLS);
          const strength = pull[index] * (clear + (1 - clear) * faceShare[index]);
          settled[index] = here + (sum / NEIGHBOURS - here) * strength;
        }
      }
    };
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) smoothPass();

    // No face steeper than the limit between two nodes; built walls excepted.
    const maxRise = grid.cell * Math.tan((MAX_SLOPE_DEG * Math.PI) / 180);
    // Cap height near the shore, measured to where the mesh puts the line.
    const shoreCap = new Float32Array(width * height).fill(Infinity);
    if (landAt) {
      const land = new Float32Array(width * height);
      for (let row = -1; row <= grid.rows + 1; row++) {
        for (let col = -1; col <= grid.cols + 1; col++) {
          land[(row + 1) * width + col + 1] = landAt(minX + col * grid.cell, minZ + row * grid.cell);
        }
      }
      const away = distanceToShore(land, width, height, grid.cell);
      for (let index = 0; index < width * height; index++) {
        if (!held[index]) shoreCap[index] = shoreCeiling(Math.min(land[index], away[index]));
      }
    }
    for (let index = 0; index < width * height; index++) {
      if (settled[index] > shoreCap[index]) settled[index] = shoreCap[index];
    }
    const limit = (a: number, b: number): boolean => {
      const ha = settled[a];
      const hb = settled[b];
      if (Number.isNaN(ha) || Number.isNaN(hb)) return false;
      const excess = Math.abs(ha - hb) - maxRise;
      if (excess <= 1e-3) return false;
      const sign = ha > hb ? 1 : -1;
      if (held[a] && held[b]) return false;
      if (held[a]) settled[b] += sign * excess;
      else if (held[b]) settled[a] -= sign * excess;
      else {
        settled[a] -= (sign * excess) / 2;
        settled[b] += (sign * excess) / 2;
      }
      return true;
    };
    const limitAll = (): void => {
      for (let pass = 0; pass < SLOPE_PASSES; pass++) {
        let moved = false;
        for (let index = 0; index < width * height; index++) {
          const col = index % width;
          if (col < width - 1 && limit(index, index + 1)) moved = true;
          if (index + width < width * height && limit(index, index + width)) moved = true;
        }
        if (!moved) break;
      }
    };
    // The limit works one pair of nodes at a time along the axes, and what it
    // leaves on a face is a crumple of its own: smoothed again and limited
    // again, the face settles into one slope.
    limitAll();
    for (let round = 0; round < SETTLE_ROUNDS; round++) {
      smoothPass();
      for (let index = 0; index < width * height; index++) {
        if (settled[index] > shoreCap[index]) settled[index] = shoreCap[index];
      }
      limitAll();
    }

    // The town's levels go on after the smoothing, not through it: the road is
    // drawn at its own height and the ground has to meet it there.
    for (let row = -1; row <= grid.rows + 1; row++) {
      for (let col = -1; col <= grid.cols + 1; col++) {
        const index = (row + 1) * width + col + 1;
        const value = settled[index];
        if (Number.isNaN(value)) continue;
        if (!streets?.count) continue;
        const town = streets.at(minX + col * grid.cell, minZ + row * grid.cell);
        // Still off the shoreline: a street the survey puts on a seawall half
        // a metre from the line is a wall straight into the sea.
        if (town) settled[index] = Math.min(value + (town.height - value) * town.weight, shoreCap[index]);
      }
    }

    nodes[belt] = settled;
    ceilings[belt] = shoreCap;
    return settled;
  };

  const nodeAt = (belt: Belt, row: number, col: number): number => {
    const grid = gridFor(belt);
    if (row < -1 || col < -1 || row > grid.rows + 1 || col > grid.cols + 1) return Number.NaN;
    return nodesFor(belt)[(row + 1) * (grid.cols + 3) + col + 1];
  };

  const at = (x: number, z: number, belt: Belt): number => {
    const grid = gridFor(belt);
    const fx = (x - grid.minX) / grid.cell;
    const fz = (z - grid.minZ) / grid.cell;
    const col = Math.floor(fx);
    const row = Math.floor(fz);
    const u = fx - col;
    const v = fz - row;

    const h00 = nodeAt(belt, row, col);
    const h01 = nodeAt(belt, row + 1, col);
    const h11 = nodeAt(belt, row + 1, col + 1);
    const h10 = nodeAt(belt, row, col + 1);
    // The same diagonal the mesher drew (`splitsOnMain`): reading the other
    // one answers about a surface that was never drawn.
    if (splitsOnMain(h00, h01, h11, h10)) {
      if (v >= u) {
        if (Number.isNaN(h00) || Number.isNaN(h01) || Number.isNaN(h11)) return Number.NaN;
        return h00 + (h11 - h01) * u + (h01 - h00) * v;
      }
      if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h11)) return Number.NaN;
      return h00 + (h10 - h00) * u + (h11 - h10) * v;
    }
    if (u + v <= 1) {
      if (Number.isNaN(h00) || Number.isNaN(h01) || Number.isNaN(h10)) return Number.NaN;
      return h00 + (h10 - h00) * u + (h01 - h00) * v;
    }
    if (Number.isNaN(h11) || Number.isNaN(h01) || Number.isNaN(h10)) return Number.NaN;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  };

  const ceilingAt = (belt: Belt, row: number, col: number): number => {
    const grid = gridFor(belt);
    if (row < -1 || col < -1 || row > grid.rows + 1 || col > grid.cols + 1) return Infinity;
    nodesFor(belt);
    return ceilings[belt][(row + 1) * (grid.cols + 3) + col + 1];
  };

  return { gridFor, nodeAt, at, ceilingAt };
}
