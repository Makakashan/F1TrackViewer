import type { EnvironmentManifest, TerrainFile } from "@/lib/environment-types";

export const TERRAIN_VERTICAL_SCALE = 1;

export interface TerrainSampler {
  heightAt(lon: number, lat: number): number;
  minHeight: number;
  maxHeight: number;
}

export function buildTerrainSampler(
  terrain: TerrainFile,
  manifest: EnvironmentManifest,
): TerrainSampler {
  const n = terrain.gridSize;
  const minLon = manifest.bbox.minLon;
  const minLat = manifest.bbox.minLat;
  const maxLat = manifest.bbox.maxLat;
  const maxLon = manifest.bbox.maxLon;

  let maxH = -Infinity;
  for (const h of terrain.heights) {
    if (h > maxH) maxH = h;
  }
  const maxLocalHeight = Math.max(0, maxH) * TERRAIN_VERTICAL_SCALE;

  const localHeights = new Float32Array(terrain.heights.length);
  for (let i = 0; i < terrain.heights.length; i++) {
    localHeights[i] = Math.max(0, terrain.heights[i]) * TERRAIN_VERTICAL_SCALE;
  }

  function heightAt(lon: number, lat: number): number {
    if (n < 2) return 0;
    const u = (lon - minLon) / (maxLon - minLon);
    const v = (lat - minLat) / (maxLat - minLat);
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;

    const fx = u * (n - 1);
    const fy = v * (n - 1);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const ix1 = Math.min(ix + 1, n - 1);
    const iy1 = Math.min(iy + 1, n - 1);
    const tx = fx - ix;
    const ty = fy - iy;
    const h00 = localHeights[iy * n + ix];
    const h10 = localHeights[iy * n + ix1];
    const h01 = localHeights[iy1 * n + ix];
    const h11 = localHeights[iy1 * n + ix1];
    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    return h0 * (1 - ty) + h1 * ty;
  }

  return {
    heightAt,
    minHeight: 0,
    maxHeight: maxLocalHeight,
  };
}
