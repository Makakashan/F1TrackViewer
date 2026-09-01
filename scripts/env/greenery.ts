/**
 * Surveyed surfaces that are neither ground nor building (docs/city-generation.md P4.3).
 *
 * Trees were built here once, a canopy and a trunk each, and read as one
 * six-sided shape repeated a thousand times. They are gone and are not coming
 * back: `natural=tree`, `tree_row`, woods and lawns are fetched and ignored.
 *
 * What is drawn is areas somebody surveyed as a thing rather than as ground —
 * a park, a garden, a fountain, a swimming pool, a pitch. Each is a lid over
 * the terrain that follows it vertex by vertex, so a park on a hillside is a
 * park on a hillside rather than a plate cut into one.
 */

import { ShapeUtils, Vector2 } from "three";

import { addFlatTriangle, createMesh, type Mesh } from "./mesh";
import type { GreenWay } from "./overpass";
import type { ScenePlane } from "./plane";

/**
 * A surveyed area that is neither ground nor building: a pool, a pitch.
 *
 * Drawn as a flat lid a hair above the terrain, triangulated by fanning from
 * the centroid — these are simple convex-ish rings and a fan holds them.
 */
const SURFACE_LIFT_M = 0.12;

export interface GreeneryResult {
  /** Water surfaces at ground level: swimming pools and fountains. */
  pools: Mesh;
  /** Playing surfaces: pitches and courts. */
  pitches: Mesh;
  /** Parks and gardens, as the ground they cover. */
  parks: Mesh;
  stats: {
    pools: number;
    pitches: number;
    parks: number;
  };
}

function ringArea(ring: { x: number; z: number }[], signed = false): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return signed ? sum / 2 : Math.abs(sum) / 2;
}

// ─── build ─────────────────────────────────────────────────────────────────

export function buildGreenery(
  ways: GreenWay[],
  /**
   * The height of the ground as it is *drawn*, not as the field reads it. A
   * belt filters the field over its own cell, so on a slope the two differ by
   * up to a metre — enough to sink a park under the hill it lies on.
   */
  groundAt: (x: number, z: number) => number,
  plane: ScenePlane,
): GreeneryResult {
  const stats: GreeneryResult["stats"] = { pools: 0, pitches: 0, parks: 0 };

  const pools = createMesh();
  const pitches = createMesh();
  const parks = createMesh();

  for (const way of ways) {
    // A fountain is water like a pool is, so it ships with them rather than
    // earning a material of its own for the six Monaco has.
    const target =
      way.kind === "pool" || way.kind === "fountain"
        ? pools
        : way.kind === "pitch"
          ? pitches
          : way.kind === "park"
            ? parks
            : null;
    if (!target || way.points.length < 4) continue;

    const ring = way.points.map(([lon, lat]) => ({ x: plane.x(lon), z: plane.z(lat) }));
    // OSM closes an area by repeating its first node; a triangulation does not
    // want the repeat.
    if (
      Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].z - ring[ring.length - 1].z) < 1e-6
    ) {
      ring.pop();
    }
    if (ring.length < 3) continue;

    // Every vertex takes the ground under it. A centroid fan on one height was
    // enough for a pool, which is flat and small; a park is neither, and on
    // Monaco's slopes a flat lid would bury its uphill half.
    const heights = ring.map((point) => groundAt(point.x, point.z));
    if (heights.some((height) => Number.isNaN(height))) continue;

    // Triangulated as the polygon it is, rather than fanned from the middle:
    // a garden is concave often enough that a fan spills over its own edge.
    //
    // The contour is built in (x, −z) so that the triangulator's own winding
    // comes out facing the sky here; taking it the other way round drew every
    // park face-down, which is invisible and was only found by a ray that went
    // straight through one.
    const contour = ring.map((point) => new Vector2(point.x, -point.z));
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
      addFlatTriangle(
        target,
        ring[a].x, heights[a] + SURFACE_LIFT_M, ring[a].z,
        ring[b].x, heights[b] + SURFACE_LIFT_M, ring[b].z,
        ring[c].x, heights[c] + SURFACE_LIFT_M, ring[c].z,
      );
    }

    if (way.kind === "pitch") stats.pitches++;
    else if (way.kind === "park") stats.parks++;
    else stats.pools++;
  }

  return { pools, pitches, parks, stats };
}
