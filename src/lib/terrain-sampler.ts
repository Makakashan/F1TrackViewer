import type { EnvironmentManifest, TerrainFile } from "@/lib/environment-types";

export const TERRAIN_VERTICAL_SCALE = 1;

export interface TerrainSampler {
  heightAt(lon: number, lat: number): number;
  /** Rendered height at a grid node, row-major. */
  heightAtNode(row: number, col: number): number;
  gridSize: number;
  minHeight: number;
  maxHeight: number;
}

/**
 * Modifiers the terrain mesh applies on top of the raw elevation grid. Anything
 * draped on the terrain has to see them too, or it sits on a surface that is
 * not the one being drawn.
 */
export interface TerrainSurfaceOptions {
  isWater?(lon: number, lat: number): boolean;
  isCarved?(lon: number, lat: number): boolean;
  carveDepthMeters?: number;
}

export function terrainReferenceElevation(terrain: TerrainFile): number {
  let min = Infinity;
  let minNonNegative = Infinity;
  for (const h of terrain.heights) {
    if (!Number.isFinite(h)) continue;
    if (h < min) min = h;
    if (h >= 0 && h < minNonNegative) minNonNegative = h;
  }
  if (Number.isFinite(minNonNegative)) return minNonNegative;
  return Number.isFinite(min) ? min : 0;
}

export function terrainLocalHeight(
  height: number,
  referenceElevation: number,
): number {
  if (!Number.isFinite(height)) return 0;
  return Math.max(0, height - referenceElevation) * TERRAIN_VERTICAL_SCALE;
}

export function buildTerrainSampler(
  terrain: TerrainFile,
  manifest: EnvironmentManifest,
  options: TerrainSurfaceOptions = {},
): TerrainSampler {
  const n = terrain.gridSize;
  const { minLon, minLat, maxLon, maxLat } = manifest.bbox;
  const { isWater, isCarved, carveDepthMeters = 0 } = options;

  const referenceElevation = terrainReferenceElevation(terrain);
  const heights = new Float32Array(terrain.heights.length);
  let maxHeight = 0;

  for (let row = 0; row < n; row++) {
    const lat = minLat + ((maxLat - minLat) * row) / (n - 1);
    for (let col = 0; col < n; col++) {
      const i = row * n + col;
      const lon = minLon + ((maxLon - minLon) * col) / (n - 1);
      let y =
        isWater?.(lon, lat) === true
          ? 0
          : terrainLocalHeight(terrain.heights[i], referenceElevation);
      if (isCarved?.(lon, lat) === true) {
        y = Math.max(0, y - carveDepthMeters);
      }
      heights[i] = y;
      if (y > maxHeight) maxHeight = y;
    }
  }

  function heightAtNode(row: number, col: number): number {
    const r = Math.min(n - 1, Math.max(0, row));
    const c = Math.min(n - 1, Math.max(0, col));
    return heights[r * n + c];
  }

  /**
   * Interpolates across the same two triangles the mesh builds per cell —
   * split along the (row, col+1)–(row+1, col) diagonal — so a draped point
   * lands on the rendered surface rather than on a bilinear approximation of
   * it. Bilinear was off by meters on this 40-plus-meter grid, which is what
   * the old neighbourhood-max plus fixed clearance was papering over.
   */
  function heightAt(lon: number, lat: number): number {
    if (n < 2) return 0;
    const u = (lon - minLon) / (maxLon - minLon);
    const v = (lat - minLat) / (maxLat - minLat);
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;

    const fx = u * (n - 1);
    const fy = v * (n - 1);
    const col = Math.min(n - 2, Math.floor(fx));
    const row = Math.min(n - 2, Math.floor(fy));
    const tx = fx - col;
    const ty = fy - row;

    const h00 = heightAtNode(row, col);
    const h10 = heightAtNode(row, col + 1);
    const h01 = heightAtNode(row + 1, col);
    const h11 = heightAtNode(row + 1, col + 1);

    if (tx + ty <= 1) {
      return h00 + tx * (h10 - h00) + ty * (h01 - h00);
    }
    return h11 + (1 - tx) * (h01 - h11) + (1 - ty) * (h10 - h11);
  }

  return { heightAt, heightAtNode, gridSize: n, minHeight: 0, maxHeight };
}
