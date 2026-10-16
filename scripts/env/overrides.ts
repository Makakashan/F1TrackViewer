/**
 * Hand corrections, versioned in git (docs/city-generation.md D1, D10).
 *
 * The generator is one recipe for every circuit; a handful of circuits need a
 * human to say what the data got wrong. Those corrections live beside the baked
 * files as `overrides.json`, they are read by the bake rather than applied to
 * its output, and every one of them is counted in the bake's report — an
 * override nobody can see applied is worse than none.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BuildingFeature, BuildingsFile } from "../../src/lib/env/environment-types";
import type { HeightField } from "./heightfield";
import type { ShoreWay } from "./overpass";
import type { ScenePlane } from "./plane";
import type { PropPlacement } from "./props";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

export type MaskKind = "water" | "no-build" | "tunnel";

export interface CityOverrides {
  schemaVersion: 1;
  circuitId: string;
  /** Why these exist. Read by people, not by code. */
  note?: string;
  buildings?: {
    remove?: string[];
    /** Metres, by building id. */
    height?: Record<string, number>;
    add?: BuildingFeature[];
  };
  terrain?: {
    /** Pulls the ground to `elevation` within `radiusM`, easing out to the edge. */
    points?: { lon: number; lat: number; elevation: number; radiusM: number }[];
  };
  masks?: { kind: MaskKind; polygon: [number, number][]; note?: string }[];
  tunnels?: {
    /** Ways the matcher found that are not tunnels the circuit drives through. */
    ignoreWays?: string[];
  };
  splines?: {
    kind: "quay" | "breakwater";
    points: [number, number][];
    note?: string;
  }[];
  /**
   * Things that are there because somebody says they are: a named building the
   * survey has no shape for, a crane, a temporary grandstand (P4.2). Either a
   * parametric `kind` or a `model` naming a `.glb` under the repo root.
   *
   * Yachts are not written here — they are berthed from the harbour survey.
   */
  props?: PropPlacement[];
}

export interface OverrideStats {
  buildingsRemoved: number;
  buildingsRetimed: number;
  buildingsAdded: number;
  buildingsMasked: number;
  terrainPoints: number;
  waterMasks: number;
  tunnelMasks: number;
  ignoredTunnelWays: number;
  shoreSplines: number;
  props: number;
}

export function emptyOverrideStats(): OverrideStats {
  return {
    buildingsRemoved: 0,
    buildingsRetimed: 0,
    buildingsAdded: 0,
    buildingsMasked: 0,
    terrainPoints: 0,
    waterMasks: 0,
    tunnelMasks: 0,
    ignoredTunnelWays: 0,
    shoreSplines: 0,
    props: 0,
  };
}

export async function loadOverrides(circuitId: string): Promise<CityOverrides | null> {
  try {
    const raw = await readFile(
      join(REPO_ROOT, "public", "environments", circuitId, "overrides.json"),
      "utf8",
    );
    const overrides = JSON.parse(raw) as CityOverrides;
    if (overrides.schemaVersion !== 1) return null;
    return overrides;
  } catch {
    return null;
  }
}

// ─── geometry ──────────────────────────────────────────────────────────────

export function pointInPolygon(lon: number, lat: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// ─── application ───────────────────────────────────────────────────────────

/**
 * Terrain edits, applied to the field after the track was burned into it: a
 * hand-set height wins over both the raster and the road.
 */
export function applyTerrainOverrides(
  field: HeightField,
  overrides: CityOverrides | null,
  plane: ScenePlane,
  stats: OverrideStats,
): void {
  if (!overrides) return;

  for (const point of overrides.terrain?.points ?? []) {
    const px = plane.x(point.lon);
    const pz = plane.z(point.lat);
    for (let row = 0; row < field.height; row++) {
      for (let col = 0; col < field.width; col++) {
        const lon =
          field.bbox.minLon +
          ((field.bbox.maxLon - field.bbox.minLon) * col) / (field.width - 1);
        const lat =
          field.bbox.maxLat -
          ((field.bbox.maxLat - field.bbox.minLat) * row) / (field.height - 1);
        const distance = Math.hypot(plane.x(lon) - px, plane.z(lat) - pz);
        if (distance > point.radiusM) continue;
        const weight = 1 - distance / point.radiusM;
        const index = row * field.width + col;
        const current = field.data[index];
        field.data[index] = Number.isNaN(current)
          ? point.elevation
          : current + (point.elevation - current) * weight;
      }
    }
    stats.terrainPoints++;
  }

  for (const mask of overrides.masks ?? []) {
    if (mask.kind !== "water") continue;
    for (let row = 0; row < field.height; row++) {
      for (let col = 0; col < field.width; col++) {
        const lon =
          field.bbox.minLon +
          ((field.bbox.maxLon - field.bbox.minLon) * col) / (field.width - 1);
        const lat =
          field.bbox.maxLat -
          ((field.bbox.maxLat - field.bbox.minLat) * row) / (field.height - 1);
        if (!pointInPolygon(lon, lat, mask.polygon)) continue;
        field.data[row * field.width + col] = Number.NaN;
      }
    }
    stats.waterMasks++;
  }
}

/** Buildings the data got wrong: removed, re-heighted, added, or masked out. */
export function applyBuildingOverrides(
  buildings: BuildingsFile,
  overrides: CityOverrides | null,
  stats: OverrideStats,
): BuildingsFile {
  if (!overrides) return buildings;

  const removed = new Set(overrides.buildings?.remove ?? []);
  const heights = overrides.buildings?.height ?? {};
  const noBuild = (overrides.masks ?? []).filter((mask) => mask.kind === "no-build");

  const kept: BuildingFeature[] = [];
  for (const building of buildings.buildings) {
    if (removed.has(building.id)) {
      stats.buildingsRemoved++;
      continue;
    }
    let centroidLon = 0;
    let centroidLat = 0;
    for (const [lon, lat] of building.footprint) {
      centroidLon += lon;
      centroidLat += lat;
    }
    centroidLon /= building.footprint.length;
    centroidLat /= building.footprint.length;
    if (noBuild.some((mask) => pointInPolygon(centroidLon, centroidLat, mask.polygon))) {
      stats.buildingsMasked++;
      continue;
    }
    const height = heights[building.id];
    if (height !== undefined) {
      stats.buildingsRetimed++;
      kept.push({ ...building, height });
      continue;
    }
    kept.push(building);
  }

  for (const added of overrides.buildings?.add ?? []) {
    kept.push(added);
    stats.buildingsAdded++;
  }

  return { ...buildings, buildings: kept };
}

/** Extra shoreline the map does not carry, drawn by hand. */
export function overrideShoreWays(
  ways: ShoreWay[],
  overrides: CityOverrides | null,
  stats: OverrideStats,
): ShoreWay[] {
  if (!overrides?.splines?.length) return ways;
  const extra: ShoreWay[] = overrides.splines.map((spline, index) => ({
    id: `override/${index}`,
    points: spline.points,
    kind: spline.kind,
  }));
  stats.shoreSplines += extra.length;
  return [...ways, ...extra];
}
