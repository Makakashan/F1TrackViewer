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
import type { PropPlacement } from "./props";
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

/** How tall a kit tree is planted. Monaco's street planting is a small tree. */
const TREE_HEIGHT_M = 7;
/** Spacing along a surveyed tree row, which OSM gives as a line and not as trees. */
const TREE_ROW_STEP_M = 9;

/**
 * The survey's own trees, as kit models.
 *
 * Trees were built here once from a canopy and a trunk and read as one shape
 * repeated a thousand times; these are somebody else's models, and there are
 * enough of them in the kit to alternate. The positions are not scattered
 * either: OSM has 662 of Monaco's trees as nodes, which is where they are.
 */
export function plantTrees(
  ways: GreenWay[],
  models: string[],
  plane: ScenePlane,
  /**
   * False where the corridor owns the ground. Monaco's street trees are mapped
   * at the kerb, which on a race weekend is behind the barrier and in our
   * geometry is inside the racing surface — `env:audit` counted 417 vertices of
   * planting standing in the corridor.
   */
  clear: (x: number, z: number) => boolean,
): PropPlacement[] {
  if (!models.length) return [];
  const planted: PropPlacement[] = [];
  const pick = (lon: number, lat: number) => {
    // A repeatable choice of model and size, so a rebake plants the same wood.
    let hash = Math.imul(Math.round(lon * 1e5) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(lat * 1e5) | 0, 0x165667b1);
    hash = Math.imul(hash ^ (hash >>> 15), 0x2545f491) >>> 0;
    return {
      model: models[hash % models.length],
      fitLengthM: TREE_HEIGHT_M * (0.8 + ((hash >>> 8) % 100) / 250),
      headingDeg: (hash >>> 16) % 360,
    };
  };

  for (const way of ways) {
    if (way.kind === "tree") {
      const [lon, lat] = way.points[0];
      if (!clear(plane.x(lon), plane.z(lat))) continue;
      planted.push({ lon, lat, ...pick(lon, lat) });
      continue;
    }
    if (way.kind !== "tree_row" || way.points.length < 2) continue;
    // A row is a line somebody drew down an avenue; the trees are ours to space.
    for (let i = 0; i < way.points.length - 1; i++) {
      const [aLon, aLat] = way.points[i];
      const [bLon, bLat] = way.points[i + 1];
      const ax = plane.x(aLon);
      const az = plane.z(aLat);
      const length = Math.hypot(plane.x(bLon) - ax, plane.z(bLat) - az);
      const steps = Math.max(1, Math.round(length / TREE_ROW_STEP_M));
      for (let step = 0; step < steps; step++) {
        const t = step / steps;
        const lon = aLon + (bLon - aLon) * t;
        const lat = aLat + (bLat - aLat) * t;
        if (!clear(plane.x(lon), plane.z(lat))) continue;
        planted.push({ lon, lat, ...pick(lon, lat) });
      }
    }
  }
  return planted;
}

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
      const from = target.positions.length / 3;
      addFlatTriangle(
        target,
        ring[a].x, heights[a] + SURFACE_LIFT_M, ring[a].z,
        ring[b].x, heights[b] + SURFACE_LIFT_M, ring[b].z,
        ring[c].x, heights[c] + SURFACE_LIFT_M, ring[c].z,
      );
      // Per triangle, not per park: a hectare of one green is the paint the
      // ground tint was, and the triangulation's own patches are the shape the
      // variation wants anyway.
      if (way.kind === "park") {
        paint(target, from, dapple((ring[a].x + ring[b].x + ring[c].x) / 3, (ring[a].z + ring[b].z + ring[c].z) / 3));
      }
    }

    if (way.kind === "pitch") stats.pitches++;
    else if (way.kind === "park") stats.parks++;
    else stats.pools++;
  }

  return { pools, pitches, parks, stats };
}
