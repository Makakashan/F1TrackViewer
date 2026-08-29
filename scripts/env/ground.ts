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
 *    moves 16.6° → 16.3°. The noise goes and the relief stays. (The box filter
 *    is the first kernel, not the last: an edge-preserving one, pinned by the
 *    surveyed walls, is roadmap step 5.)
 * 2. **`at()` interpolates the way the mesh triangulates.** Not bilinear — the
 *    terrain splits each cell across its main diagonal, so a query has to pick
 *    the same triangle or it answers about a surface nobody drew.
 */

import { BELT_CELL_M, type Belt } from "./belts";
import type { HeightField } from "./heightfield";
import type { ScenePlane } from "./plane";

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

export function buildGround(field: HeightField, plane: ScenePlane): Ground {
  const { sums, counts } = summedArea(field);
  const stride = field.width + 1;
  const fieldCellM = (field.cellSizeM.x + field.cellSizeM.y) / 2;

  const minX = plane.x(field.bbox.minLon);
  const maxX = plane.x(field.bbox.maxLon);
  const minZ = plane.z(field.bbox.maxLat); // the north edge is the smaller Z
  const maxZ = plane.z(field.bbox.minLat);

  /** Mean of the valid field nodes in a square window, NaN if there are none. */
  const windowMean = (row: number, col: number, radius: number): number => {
    const rowFrom = Math.max(0, Math.min(field.height - 1, row - radius));
    const rowTo = Math.max(0, Math.min(field.height - 1, row + radius));
    const colFrom = Math.max(0, Math.min(field.width - 1, col - radius));
    const colTo = Math.max(0, Math.min(field.width - 1, col + radius));
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
    nodes[belt] = table;
    return table;
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
