import type { EnvironmentManifest, TerrainFile } from "@/lib/environment-types";

export const TERRAIN_VERTICAL_SCALE = 1;

export interface TerrainSampler {
  heightAt(lon: number, lat: number): number;
  minHeight: number;
  maxHeight: number;
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
): TerrainSampler {
  const n = terrain.gridSize;
  const minLon = manifest.bbox.minLon;
  const minLat = manifest.bbox.minLat;
  const maxLat = manifest.bbox.maxLat;
  const maxLon = manifest.bbox.maxLon;

  const referenceElevation = terrainReferenceElevation(terrain);
  let maxLocalHeight = 0;
  for (const h of terrain.heights) {
    maxLocalHeight = Math.max(
      maxLocalHeight,
      terrainLocalHeight(h, referenceElevation),
    );
  }

  const localHeights = new Float32Array(terrain.heights.length);
  for (let i = 0; i < terrain.heights.length; i++) {
    localHeights[i] = terrainLocalHeight(
      terrain.heights[i],
      referenceElevation,
    );
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

/**
 * Max terrain height in a small neighbourhood around a point, instead of the
 * raw bilinear sample at that exact point. The rendered terrain mesh is
 * flat-shaded — a triangle can bulge above the bilinear plane near a ridge —
 * so anything draped on top (track ribbon, roads) needs this margin to avoid
 * dipping below the actual rendered surface.
 */
export function terrainHeightNear(
  sampler: TerrainSampler,
  lon: number,
  lat: number,
  radiusMeters: number,
): number {
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const dLat = radiusMeters / metersPerDegLat;
  const dLon = radiusMeters / metersPerDegLon;
  let max = sampler.heightAt(lon, lat);
  for (const [ox, oy] of [
    [dLon, 0],
    [-dLon, 0],
    [0, dLat],
    [0, -dLat],
    [dLon, dLat],
    [dLon, -dLat],
    [-dLon, dLat],
    [-dLon, -dLat],
  ] as const) {
    max = Math.max(max, sampler.heightAt(lon + ox, lat + oy));
  }
  return max;
}
