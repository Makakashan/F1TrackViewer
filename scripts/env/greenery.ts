/**
 * Surveyed areas that are neither ground nor building: parks, lawns, woods, pools,
 * pitches. Each is a lid following the terrain vertex by vertex.
 */

import { ShapeUtils, Vector2 } from "three";

import { addFlatTriangle, createMesh, type Mesh } from "./mesh";
import type { GreenWay } from "./overpass";
import type { PropPlacement } from "./props";
import type { ScenePlane } from "./plane";

/** How far a lid floats over the terrain. */
const SURFACE_LIFT_M = 0.35;
/**
 * Each kind on its own floor, most specific highest: a pool inside a pitch inside a
 * park. Half a metre beats the lids' disagreement about the ground.
 */
const LID_FLOOR_M: Record<string, number> = { grass: -0.2, scrub: -0.2, wood: -0.2, park: 0, pitch: 0.5, pool: 0.8 };
/** A lawn or a wood runs to hectares; split as finely as a park, one wood blew the belt's budget. */
const OPEN_LID_STEP_M = 8;
/** A wood is darker than the lawn beside it. */
const WOOD_SHADE = 0.86;
const OPEN_GREEN = new Set(["grass", "scrub", "wood"]);

export interface GreeneryResult {
  /** Water surfaces at ground level: swimming pools and fountains. */
  pools: Mesh;
  /** Playing surfaces: pitches and courts. */
  pitches: Mesh;
  /** Parks, gardens, lawns and woods, as the ground they cover. */
  parks: Mesh;
  stats: {
    pools: number;
    pitches: number;
    parks: number;
  };
}

/**
 * Per-triangle shade from a hash of position, so a hectare of green is not flat paint.
 * The rim is darker.
 */
function paint(mesh: Mesh, from: number, shade: number): void {
  mesh.colors ??= [];
  const vertices = mesh.positions.length / 3;
  for (let i = from; i < vertices; i++) mesh.colors.push(shade, shade, shade);
}

/** Longest lid edge before it is split; one big triangle crosses the hill under it. */
const LID_STEP_M = 3;
/** Cap on the splitting, so a park the size of a hillside cannot run away. */
const LID_SPLIT_DEPTH = 7;

/** The highest ground within half a step, so the lid between vertices stays above the terrain. */
function groundTop(groundAt: (x: number, z: number) => number, x: number, z: number): number {
  const reach = LID_STEP_M / 2;
  let top = Number.NaN;
  for (const [dx, dz] of [[0, 0], [reach, 0], [-reach, 0], [0, reach], [0, -reach]] as const) {
    const height = groundAt(x + dx, z + dz);
    if (Number.isNaN(height)) continue;
    if (Number.isNaN(top) || height > top) top = height;
  }
  return top;
}

interface LidPoint {
  x: number;
  z: number;
  y: number;
}

/** Split a lid triangle until it follows the ground; the midpoint takes the ground's height. */
function splitToGround(
  mesh: Mesh,
  a: LidPoint,
  b: LidPoint,
  c: LidPoint,
  groundAt: (x: number, z: number) => number,
  lift: number,
  step: number,
  depth: number,
  keep: (x: number, z: number) => boolean,
): void {
  const ab = Math.hypot(a.x - b.x, a.z - b.z);
  const bc = Math.hypot(b.x - c.x, b.z - c.z);
  const ca = Math.hypot(c.x - a.x, c.z - a.z);
  const longest = Math.max(ab, bc, ca);
  if (depth >= LID_SPLIT_DEPTH || longest <= step) {
    if (keep((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3)) {
      addFlatTriangle(mesh, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    return;
  }
  const cut = (from: LidPoint, to: LidPoint): LidPoint => {
    const x = (from.x + to.x) / 2;
    const z = (from.z + to.z) / 2;
    const ground = groundTop(groundAt, x, z);
    return { x, z, y: (Number.isNaN(ground) ? (from.y + to.y) / 2 - lift : ground) + lift };
  };
  if (longest === ab) {
    const m = cut(a, b);
    splitToGround(mesh, a, m, c, groundAt, lift, step, depth + 1, keep);
    splitToGround(mesh, m, b, c, groundAt, lift, step, depth + 1, keep);
    return;
  }
  if (longest === bc) {
    const m = cut(b, c);
    splitToGround(mesh, a, b, m, groundAt, lift, step, depth + 1, keep);
    splitToGround(mesh, a, m, c, groundAt, lift, step, depth + 1, keep);
    return;
  }
  const m = cut(c, a);
  splitToGround(mesh, a, b, m, groundAt, lift, step, depth + 1, keep);
  splitToGround(mesh, m, b, c, groundAt, lift, step, depth + 1, keep);
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

// build
/** How tall a kit tree is planted. Monaco's street planting is a small tree. */
const TREE_HEIGHT_M = 7;
/** Spacing along a surveyed tree row, which OSM gives as a line and not as trees. */
const TREE_ROW_STEP_M = 9;

/** OSM's surveyed trees, placed as kit models alternating between several. */
export function plantTrees(
  ways: GreenWay[],
  models: string[],
  plane: ScenePlane,
  /** False where the corridor owns the ground; street trees are mapped at the kerb. */
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
  /** The height of the ground as drawn, not as the field reads it. */
  groundAt: (x: number, z: number) => number,
  plane: ScenePlane,
  /** False on the road: a lawn mapped up to the kerb is drawn over the ribbon, and its depth bias wins. */
  offTrack: (x: number, z: number) => boolean,
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
          : way.kind === "park" || OPEN_GREEN.has(way.kind)
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
    const lift = SURFACE_LIFT_M + (LID_FLOOR_M[way.kind] ?? 0);
    const heights = ring.map((point) => groundTop(groundAt, point.x, point.z));
    if (heights.some((height) => Number.isNaN(height))) continue;

    // Triangulated, not fanned: gardens are often concave. Built in (x, -z) so the
    // winding faces the sky.
    const contour = ring.map((point) => new Vector2(point.x, -point.z));
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
      const from = target.positions.length / 3;
      // A pool is a few metres of flat water and its edges are already shorter
      // than the step; splitting it would spend triangles on nothing.
      const step = way.kind === "pool" ? Infinity : OPEN_GREEN.has(way.kind) ? OPEN_LID_STEP_M : LID_STEP_M;
      splitToGround(
        target,
        { x: ring[a].x, z: ring[a].z, y: heights[a] + lift },
        { x: ring[b].x, z: ring[b].z, y: heights[b] + lift },
        { x: ring[c].x, z: ring[c].z, y: heights[c] + lift },
        groundAt,
        lift,
        step,
        0,
        offTrack,
      );
      // Parks vary per triangle. A lawn or wood takes one shade: its slivers look like shards.
      if (target === parks) {
        const shade = OPEN_GREEN.has(way.kind)
          ? dapple(ring[0].x, ring[0].z) * (way.kind === "wood" ? WOOD_SHADE : 1)
          : dapple((ring[a].x + ring[b].x + ring[c].x) / 3, (ring[a].z + ring[b].z + ring[c].z) / 3);
        paint(target, from, shade);
      }
    }

    if (way.kind === "pitch") stats.pitches++;
    else if (target === parks) stats.parks++;
    else stats.pools++;
  }

  return { pools, pitches, parks, stats };
}
