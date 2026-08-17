/**
 * A smooth stand-in for the shoreline where no survey line covers it.
 *
 * The cut in `bake.ts` needs a scalar whose zero crossing is the water's edge.
 * The OSM line gives one, but it does not reach everywhere: around Larvotto the
 * raster's water starts as much as 160 m from the nearest mapped way, and there
 * the cut falls back on the land/water flag — which is boolean, so its edge is
 * the grid again and the coast comes out as 16 m steps.
 *
 * A signed distance to the water fixes that without any new data. Land counts
 * metres to the nearest wet node, water counts metres to the nearest dry one,
 * and the zero crossing lands between them rather than on a grid line. Blurring
 * it takes the last of the staircase out of the diagonals: the distances
 * themselves are quantised to the field's own cells, and a mean over the
 * neighbourhood turns those terraces into a slope.
 */

import type { HeightField } from "./heightfield";

/** Passes of the 3×3 mean. Two is enough to round a cell-sized corner. */
const SMOOTHING_PASSES = 2;

export interface ShoreDistance {
  /** Metres from the water's edge: positive on land, negative in water. */
  at(lon: number, lat: number): number;
}

/**
 * Chamfer distance transform, forward then backward. Exact Euclidean distance
 * is not worth its cost here — the answer is smoothed anyway, and the error of
 * the 3-4 kernel is a few percent over the handful of cells that matter.
 */
function distanceToMask(
  mask: Uint8Array,
  width: number,
  height: number,
  cellX: number,
  cellY: number,
): Float32Array {
  const far = 1e9;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 0 : far;

  const straightX = cellX;
  const straightY = cellY;
  const diagonal = Math.hypot(cellX, cellY);

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const index = row * width + col;
      let best = out[index];
      if (best === 0) continue;
      if (col > 0) best = Math.min(best, out[index - 1] + straightX);
      if (row > 0) best = Math.min(best, out[index - width] + straightY);
      if (row > 0 && col > 0) best = Math.min(best, out[index - width - 1] + diagonal);
      if (row > 0 && col < width - 1) best = Math.min(best, out[index - width + 1] + diagonal);
      out[index] = best;
    }
  }
  for (let row = height - 1; row >= 0; row--) {
    for (let col = width - 1; col >= 0; col--) {
      const index = row * width + col;
      let best = out[index];
      if (best === 0) continue;
      if (col < width - 1) best = Math.min(best, out[index + 1] + straightX);
      if (row < height - 1) best = Math.min(best, out[index + width] + straightY);
      if (row < height - 1 && col < width - 1) best = Math.min(best, out[index + width + 1] + diagonal);
      if (row < height - 1 && col > 0) best = Math.min(best, out[index + width - 1] + diagonal);
      out[index] = best;
    }
  }
  return out;
}

function smooth(data: Float32Array, width: number, height: number): void {
  const scratch = new Float32Array(data.length);
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        let sum = 0;
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const nr = row + dr;
          if (nr < 0 || nr >= height) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const nc = col + dc;
            if (nc < 0 || nc >= width) continue;
            sum += data[nr * width + nc];
            count++;
          }
        }
        scratch[row * width + col] = sum / count;
      }
    }
    data.set(scratch);
  }
}

export function buildShoreDistance(field: HeightField): ShoreDistance {
  const { width, height, data } = field;
  const land = new Uint8Array(width * height);
  const water = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    if (Number.isNaN(data[i])) water[i] = 1;
    else land[i] = 1;
  }

  const cellX = field.cellSizeM.x;
  const cellY = field.cellSizeM.y;
  const toWater = distanceToMask(water, width, height, cellX, cellY);
  const toLand = distanceToMask(land, width, height, cellX, cellY);

  // Half a cell of offset each way, so the zero sits between the last dry node
  // and the first wet one rather than on top of the dry one.
  const half = (cellX + cellY) / 4;
  const signed = new Float32Array(width * height);
  for (let i = 0; i < signed.length; i++) {
    signed[i] = water[i] ? -(toLand[i] - half) : toWater[i] - half;
  }
  smooth(signed, width, height);

  const { bbox } = field;
  return {
    at(lon: number, lat: number): number {
      const fx = ((lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * (width - 1);
      const fy = ((bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat)) * (height - 1);
      const col = Math.max(0, Math.min(width - 2, Math.floor(fx)));
      const row = Math.max(0, Math.min(height - 2, Math.floor(fy)));
      const tx = Math.max(0, Math.min(1, fx - col));
      const ty = Math.max(0, Math.min(1, fy - row));
      const i = row * width + col;
      const top = signed[i] + (signed[i + 1] - signed[i]) * tx;
      const bottom = signed[i + width] + (signed[i + width + 1] - signed[i + width]) * tx;
      return top + (bottom - top) * ty;
    },
  };
}
