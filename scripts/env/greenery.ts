/**
 * Green ground, and the surfaces that sit on it (docs/city-generation.md P4.3).
 *
 * Greenery arrives from OSM as areas: a park, a wood, a lawn. What is done
 * with them is a colour, not geometry — the terrain's own grey is pulled
 * toward green wherever an area covers it, which costs no triangle, no draw
 * call and no material. Trees were built here once, a canopy and a trunk each;
 * they read as a forest of the same six-sided shape and were taken out. The
 * survey's `natural=tree` and `tree_row` are still fetched and now ignored.
 *
 * Two kinds of surveyed area are not ground and are drawn: a swimming pool and
 * a pitch. Monaco's pool quay reads as bare concrete otherwise, and the halls
 * beside the pool are the Grand Prix's own and are in nobody's survey.
 */

import type { HeightField } from "./heightfield";
import { addFlatTriangle, createMesh, type Mesh } from "./mesh";
import type { GreenWay } from "./overpass";
import type { ScenePlane } from "./plane";

/** Areas that colour the ground. A pool is not a lawn. */
const TINTED_KINDS = new Set<GreenWay["kind"]>([
  "wood",
  "scrub",
  "park",
  "grass",
  "pitch",
]);

/**
 * A surveyed area that is neither ground nor building: a pool, a pitch.
 *
 * Drawn as a flat lid a hair above the terrain, triangulated by fanning from
 * the centroid — these are simple convex-ish rings and a fan holds them.
 */
const SURFACE_LIFT_M = 0.12;

export interface GreeneryResult {
  /** Water surfaces at ground level: swimming pools. */
  pools: Mesh;
  /** Playing surfaces: pitches and courts. */
  pitches: Mesh;
  /** True where the ground belongs to a park, a wood or a lawn. */
  isGreen(x: number, z: number): boolean;
  stats: {
    areas: number;
    areaM2: number;
    pools: number;
    pitches: number;
  };
}

// ─── areas ─────────────────────────────────────────────────────────────────

interface Area {
  kind: GreenWay["kind"];
  ring: { x: number; z: number }[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function pointInRing(ring: { x: number; z: number }[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.z > z === b.z > z) continue;
    if (x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
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

/**
 * The green areas, in a coarse bucket grid.
 *
 * `isGreen` is asked once per terrain vertex of every belt — tens of thousands
 * of times — and a scan over every ring would be the slowest thing in the bake.
 * A ring only ever needs testing if the point is inside its bounding box, so
 * the boxes are stamped into a grid and a lookup tests its own bucket.
 */
function indexAreas(areas: Area[]) {
  const BUCKET_M = 120;
  const buckets = new Map<string, Area[]>();
  const key = (col: number, row: number) => `${col},${row}`;
  for (const area of areas) {
    const fromCol = Math.floor(area.minX / BUCKET_M);
    const toCol = Math.floor(area.maxX / BUCKET_M);
    const fromRow = Math.floor(area.minZ / BUCKET_M);
    const toRow = Math.floor(area.maxZ / BUCKET_M);
    for (let col = fromCol; col <= toCol; col++) {
      for (let row = fromRow; row <= toRow; row++) {
        const id = key(col, row);
        const list = buckets.get(id);
        if (list) list.push(area);
        else buckets.set(id, [area]);
      }
    }
  }
  return (x: number, z: number): boolean => {
    const list = buckets.get(key(Math.floor(x / BUCKET_M), Math.floor(z / BUCKET_M)));
    if (!list) return false;
    for (const area of list) {
      if (x < area.minX || x > area.maxX || z < area.minZ || z > area.maxZ) continue;
      if (pointInRing(area.ring, x, z)) return true;
    }
    return false;
  };
}

// ─── build ─────────────────────────────────────────────────────────────────

export function buildGreenery(
  ways: GreenWay[],
  field: HeightField,
  plane: ScenePlane,
): GreeneryResult {
  const areas: Area[] = [];
  let areaM2 = 0;
  for (const way of ways) {
    if (way.points.length < 4) continue;
    if (!TINTED_KINDS.has(way.kind)) continue;
    const ring = way.points.map(([lon, lat]) => ({ x: plane.x(lon), z: plane.z(lat) }));
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of ring) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    areas.push({ kind: way.kind, ring, minX, maxX, minZ, maxZ });
    areaM2 += ringArea(ring);
  }
  const isGreen = indexAreas(areas);

  const stats: GreeneryResult["stats"] = {
    areas: areas.length,
    areaM2: Math.round(areaM2),
    pools: 0,
    pitches: 0,
  };

  const pools = createMesh();
  const pitches = createMesh();

  for (const way of ways) {
    const target = way.kind === "pool" ? pools : way.kind === "pitch" ? pitches : null;
    if (!target || way.points.length < 4) continue;
    const ring = way.points.map(([lon, lat]) => ({ x: plane.x(lon), z: plane.z(lat) }));
    let cx = 0;
    let cz = 0;
    for (const point of ring) {
      cx += point.x;
      cz += point.z;
    }
    cx /= ring.length;
    cz /= ring.length;
    const ground = field.heightAt(plane.lon(cx), plane.lat(cz));
    if (Number.isNaN(ground)) continue;
    const y = ground + SURFACE_LIFT_M;
    // Wound to face the sky whichever way the mapper drew the ring. This is the
    // bug that hid every flat roof in the city until P4.0b counted them, and a
    // surveyed way carries no promise about its direction.
    const clockwise = ringArea(ring, true) < 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[clockwise ? (i + 1) % ring.length : i];
      const b = ring[clockwise ? i : (i + 1) % ring.length];
      addFlatTriangle(target, cx, y, cz, a.x, y, a.z, b.x, y, b.z);
    }
    if (way.kind === "pool") stats.pools++;
    else stats.pitches++;
  }

  return { pools, pitches, isGreen, stats };
}

// ─── ground ────────────────────────────────────────────────────────────────

/**
 * Tints the terrain where it is green.
 *
 * The colour rides on the vertex colours the AO pass writes, so it costs no
 * geometry, no draw call and no material: the terrain's own grey is multiplied
 * toward the palette's green wherever a park or a wood covers it. This has to
 * run after the occlusion pass, which owns the same array.
 */
export function tintGreenGround(
  mesh: Mesh,
  isGreen: (x: number, z: number) => boolean,
  tint: [number, number, number],
): number {
  if (!mesh.colors) return 0;
  let tinted = 0;
  const count = mesh.positions.length / 3;
  for (let i = 0; i < count; i++) {
    if (!isGreen(mesh.positions[i * 3], mesh.positions[i * 3 + 2])) continue;
    mesh.colors[i * 3] *= tint[0];
    mesh.colors[i * 3 + 1] *= tint[1];
    mesh.colors[i * 3 + 2] *= tint[2];
    tinted++;
  }
  return tinted;
}
