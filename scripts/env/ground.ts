/**
 * The ground, as one surface — the answer to "how high is it here" that every
 * other part of the bake is required to use.
 *
 * Before this module there were two answers. The terrain meshed a belt by
 * point-sampling the height field at the belt's own step, and everything that
 * stands on the ground — buildings, kit models, props — read the field directly
 * at 3.9 m. On smooth ground the two agree. On Monaco they do not: the field's
 * high-frequency content has an RMS of 0.93 m at its own cell, and sampling
 * that at 8 m turns ±1 m of ripple into random tilt. Measured on the shipped
 * bake, 269 of 3,286 buildings stood clear of the terrain drawn under them,
 * the worst by 11.16 m, and `MAX_UNDERCUT_M` existed to hide the rest.
 *
 * Two things follow from having one surface:
 *
 * 1. **A belt averages the field rather than sampling it.** A coarse mesh that
 *    point-samples a fine field is aliasing, plainly: the kink between
 *    neighbouring faces measures 3.76 m at 8 m and 7.70 m at 16 m, against
 *    2.55 m and 4.97 m for the same nodes box-averaged, while the mean slope
 *    moves 16.6° → 16.3°. The noise goes and the relief stays. The window stops
 *    at a surveyed cliff, wall or quay (`breaklines.ts`), which is what keeps the
 *    averaging from turning one into a ramp.
 * 2. **`at()` interpolates the way the mesh triangulates.** Not bilinear — the
 *    terrain splits each cell across its main diagonal, so a query has to pick
 *    the same triangle or it answers about a surface nobody drew.
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
}

/**
 * How wide a belt's filter window is, in field nodes either side.
 *
 * A belt cell that is the field's own cell needs no filter — there is nothing
 * between its samples to alias — so the core belt, at 4 m against 3.9 m, keeps
 * reading the field exactly as it did.
 */
function radiusFor(cellM: number, fieldCellM: number): number {
  return Math.max(0, Math.round(cellM / fieldCellM / 2 - 0.5));
}

/**
 * Smoothing passes over a belt's own nodes, and how far each moves toward its
 * neighbours' mean. Two gentle passes rather than one hard one: the same
 * smoothing, with a wider reach and no risk of a node overshooting its own
 * neighbourhood.
 */
export const SMOOTH_PASSES = 16;
/**
 * How far a node moves toward its neighbours' mean in one pass, on ground that
 * is flat and on a face.
 *
 * A DTM sees a cliff badly: a laser scan from above gets few returns off a
 * vertical face, and what it interpolates between them comes out as spikes.
 * Meshed at four metres those are drawn as a row of teeth down the rock. The
 * face's own drop survives any amount of averaging — it is the noise on top of
 * it that goes — so the steeper the ground, the harder this pulls.
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
/** Four neighbours, not eight: a diagonal is a cell and a half away. */
const NEIGHBOURS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/**
 * Summed-area tables over the field, one for the values and one for the count
 * of valid nodes, so a window average costs four lookups regardless of its size
 * and nodata never drags a mean toward the datum.
 */
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

    // The window is walked node by node only where a surveyed line runs through
    // it. Everywhere else — nearly everywhere — the summed-area tables answer in
    // four lookups, so the breaklines cost the bake nothing away from a wall.
    // The question is whether a line is *in* the window, not whether it crosses
    // the window's diagonal: a wall clipping a corner still splits the average.
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

  /**
   * A belt's nodes, computed once. The mesher walks every node several times
   * and the placement pass walks them again, so the table is cheaper than the
   * window it replaces — and it is the table that makes the two agree.
   *
   * One node of margin on each side: the mesher asks for the ring outside the
   * grid when it looks for solid ground beside a wet node.
   */
  const nodesFor = (belt: Belt): Float32Array => {
    const existing = nodes[belt];
    if (existing) return existing;
    const grid = gridFor(belt);
    const width = grid.cols + 3;
    const height = grid.rows + 3;
    const table = new Float32Array(width * height);
    for (let row = -1; row <= grid.rows + 1; row++) {
      for (let col = -1; col <= grid.cols + 1; col++) {
        const x = minX + col * grid.cell;
        const z = minZ + row * grid.cell;
        const lon = plane.lon(x);
        const lat = plane.lat(z);
        let value: number;
        if (grid.radius === 0) {
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

    // A pass or two of smoothing over the belt's own nodes, on top of the
    // filter's window over the field. The window can only average what fits
    // inside one cell; the ripple left over is between the cells, and on a rock
    // face meshed at four metres that is what reads as a rough surface.
    //
    // It lets go at a surveyed wall, and it does so gradually. Refusing to
    // average across the line outright was tried first: the line meanders
    // between nodes, so which neighbours a node kept flipped from node to node,
    // and the result measured rougher than no smoothing at all — kink 3.24 m
    // against 2.55 m. Fading the smoothing out as the wall comes near keeps the
    // step and adds no ripple of its own.
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
        const east = field.heightAt(plane.lon(x + grid.cell), plane.lat(z));
        const west = field.heightAt(plane.lon(x - grid.cell), plane.lat(z));
        const south = field.heightAt(plane.lon(x), plane.lat(z + grid.cell));
        const north = field.heightAt(plane.lon(x), plane.lat(z - grid.cell));
        let face = 0;
        if (![east, west, south, north].some(Number.isNaN)) {
          const run = Math.hypot(
            (east - west) / (2 * grid.cell),
            (south - north) / (2 * grid.cell),
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
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      const before = new Float32Array(settled);
      for (let row = -1; row <= grid.rows + 1; row++) {
        for (let col = -1; col <= grid.cols + 1; col++) {
          const index = (row + 1) * width + col + 1;
          const here = before[index];
          if (Number.isNaN(here)) continue;
          const away = wallAway[index];
          let sum = 0;
          let count = 0;
          let complete = true;
          const lon = plane.lon(minX + col * grid.cell);
          const lat = plane.lat(minZ + row * grid.cell);
          for (const [dr, dc] of NEIGHBOURS) {
            const r = row + dr;
            const c = col + dc;
            const value =
              r < -1 || c < -1 || r > grid.rows + 1 || c > grid.cols + 1
                ? Number.NaN
                : before[(r + 1) * width + c + 1];
            // Neither the sea nor a built wall is averaged across, and a node
            // that cannot see all four of its neighbours is left alone: a
            // one-sided mean tips it off the slope it belongs on. A natural
            // cliff is different — on a face the line marks the rock, not a
            // step between two flats — so it is crossed where the ground is
            // steep and held to where it is not.
            const neighbourLon = plane.lon(minX + c * grid.cell);
            const neighbourLat = plane.lat(minZ + r * grid.cell);
            if (
              Number.isNaN(value)
              || (breaklines?.count
                && (breaklines.crossesWallLonLat(lon, lat, neighbourLon, neighbourLat)
                  || (faceShare[index] < 0.5
                    && breaklines.crossesLonLat(lon, lat, neighbourLon, neighbourLat))))
            ) {
              complete = false;
              break;
            }
            sum += value;
            count++;
          }
          if (!complete || count !== NEIGHBOURS.length) continue;
          const clear = Math.min(1, away / WALL_FADE_CELLS);
          const strength = pull[index] * (clear + (1 - clear) * faceShare[index]);
          settled[index] = here + (sum / count - here) * strength;
        }
      }
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
        if (town) settled[index] = value + (town.height - value) * town.weight;
      }
    }

    nodes[belt] = settled;
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
    const h11 = nodeAt(belt, row + 1, col + 1);
    // The mesher splits a cell across the main diagonal: (row, col) to
    // (row + 1, col + 1). Below it the third corner is (row + 1, col); above
    // it, (row, col + 1). Reading the other one answers about a surface that
    // was never drawn.
    if (v >= u) {
      const h01 = nodeAt(belt, row + 1, col);
      if (Number.isNaN(h00) || Number.isNaN(h01) || Number.isNaN(h11)) return Number.NaN;
      return h00 + (h11 - h01) * u + (h01 - h00) * v;
    }
    const h10 = nodeAt(belt, row, col + 1);
    if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h11)) return Number.NaN;
    return h00 + (h10 - h00) * u + (h11 - h10) * v;
  };

  return { gridFor, nodeAt, at };
}
