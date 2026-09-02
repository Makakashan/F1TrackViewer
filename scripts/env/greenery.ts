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

import { addFlatQuad, addFlatTriangle, createMesh, type Mesh } from "./mesh";
import type { GreenWay } from "./overpass";
import type { ScenePlane } from "./plane";

/**
 * A surveyed area that is neither ground nor building: a pool, a pitch.
 *
 * Drawn as a flat lid a hair above the terrain, triangulated by fanning from
 * the centroid — these are simple convex-ish rings and a fan holds them.
 */
const SURFACE_LIFT_M = 0.12;
/**
 * How high a park stands over the ground around it.
 *
 * Flat, it read as green paint on grey — the same complaint that killed the
 * ground tint. Monte-Carlo's gardens are terraces held by a wall, and that is
 * what gives the shape a side for the light to find: three quarters of a metre
 * is enough to read from the air and small enough to walk over at street level.
 */
const PARK_RIM_M = 0.75;
/** How much darker the terrace wall is than the planting it holds up. */
const PARK_RIM_SHADE = 0.72;

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

/**
 * A shade per vertex for the triangles just added.
 *
 * One flat green over a hectare reads as paint whatever its colour, so the
 * planting is broken up by a hash of where each triangle sits — a few per cent
 * either way, invisible as a pattern and enough to stop the mass reading as one
 * poured shape. The rim takes a darker one, because a wall in daylight is
 * darker than the ground it holds up.
 */
function paint(mesh: Mesh, from: number, shade: number): void {
  mesh.colors ??= [];
  const vertices = mesh.positions.length / 3;
  for (let i = from; i < vertices; i++) mesh.colors.push(shade, shade, shade);
}

/** A repeatable ±14 % from a point, with no pattern the eye can find. */
function dapple(x: number, z: number): number {
  let hash = Math.imul(Math.round(x * 4) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(z * 4) | 0, 0x165667b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2545f491);
  return 0.86 + (((hash >>> 8) % 1000) / 1000) * 0.28;
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

    // A park stands on its own rim; a pool or a pitch lies flat.
    const lift = way.kind === "park" ? SURFACE_LIFT_M + PARK_RIM_M : SURFACE_LIFT_M;

    // Triangulated as the polygon it is, rather than fanned from the middle:
    // a garden is concave often enough that a fan spills over its own edge.
    //
    // The contour is built in (x, −z) so that the triangulator's own winding
    // comes out facing the sky here; taking it the other way round drew every
    // park face-down, which is invisible and was only found by a ray that went
    // straight through one.
    const contour = ring.map((point) => new Vector2(point.x, -point.z));
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
      const from = target.positions.length / 3;
      addFlatTriangle(
        target,
        ring[a].x, heights[a] + lift, ring[a].z,
        ring[b].x, heights[b] + lift, ring[b].z,
        ring[c].x, heights[c] + lift, ring[c].z,
      );
      // Per triangle, not per park: a hectare of one green is the paint the
      // ground tint was, and the triangulation's own patches are the shape the
      // variation wants anyway.
      if (way.kind === "park") {
        paint(target, from, dapple((ring[a].x + ring[b].x + ring[c].x) / 3, (ring[a].z + ring[b].z + ring[c].z) / 3));
      }
    }

    // The wall that holds the terrace up, wound so it faces away from the park.
    if (way.kind === "park") {
      const rimFrom = target.positions.length / 3;
      const clockwise = ringArea(ring, true) < 0;
      for (let i = 0; i < ring.length; i++) {
        const next = (i + 1) % ring.length;
        const [from, to] = clockwise ? [next, i] : [i, next];
        addFlatQuad(
          target,
          ring[from].x, heights[from] + lift, ring[from].z,
          ring[to].x, heights[to] + lift, ring[to].z,
          ring[to].x, heights[to] - SURFACE_LIFT_M, ring[to].z,
          ring[from].x, heights[from] - SURFACE_LIFT_M, ring[from].z,
        );
      }
      paint(target, rimFrom, PARK_RIM_SHADE);
    }

    if (way.kind === "pitch") stats.pitches++;
    else if (way.kind === "park") stats.parks++;
    else stats.pools++;
  }

  return { pools, pitches, parks, stats };
}
