/**
 * Trees, and the ground they stand on (docs/city-generation.md P4.3).
 *
 * Greenery arrives from OSM in three resolutions and each is used for what it
 * is good for. A surveyed `natural=tree` is a position, and Monaco has 662 of
 * them along the streets the circuit runs down — those are placed exactly where
 * the survey put them. A `tree_row` is a line to step along. A park or a wood
 * is an area, and an area says *there are trees here*, not where, so trees are
 * scattered over it.
 *
 * Two things are then done with that, at two ranges. Near the circuit the
 * greenery is trees, because a tree is what you see. Far from it the greenery
 * is a colour: a wood at 600 m is a green patch on a hillside, and drawing five
 * thousand trees to say so would cost a third of the far belt's whole budget
 * for something no one can resolve. So the areas tint the terrain everywhere
 * and grow trees only where the camera is close enough to tell.
 */

import type { Corridor } from "./belts";
import type { HeightField } from "./heightfield";
import { addFlatQuad, addFlatTriangle, createMesh, type Mesh } from "./mesh";
import type { GreenWay } from "./overpass";
import type { ScenePlane } from "./plane";

/** Beyond this the ground is tinted but nothing is planted on it. */
export const TREE_RANGE_M = 600;
/** Trees are not planted on the road. */
const TRACK_CLEAR_M = 9;
/** Scatter spacing, by how close to the circuit the patch is. */
const SPACING_NEAR_M = 10;
const SPACING_FAR_M = 20;
const NEAR_M = 150;
/** Areas that carry trees. The rest tint the ground and grow nothing. */
const PLANTED_KINDS = new Set<GreenWay["kind"]>(["wood", "scrub", "park"]);
/** Areas that colour the ground. A pool is not a lawn. */
const TINTED_KINDS = new Set<GreenWay["kind"]>([
  "wood",
  "scrub",
  "park",
  "grass",
  "pitch",
]);
/** Metres between trees along a surveyed row. */
const ROW_STEP_M = 8;
const TREE_MIN_H_M = 5;
const TREE_MAX_H_M = 12;

export interface TreePlacement {
  x: number;
  z: number;
  y: number;
  heightM: number;
  /** Turned so a row of them does not read as one shape repeated. */
  spinRad: number;
}

/**
 * A surveyed area that is neither ground nor building: a pool, a pitch.
 *
 * Drawn as a flat lid a hair above the terrain, triangulated by fanning from
 * the centroid — these are simple convex-ish rings and a fan holds them. It is
 * the cheapest honest answer to "there is something there": Monaco's pool quay
 * reads as bare concrete otherwise, and the halls beside the pool are the Grand
 * Prix's own and are in nobody's survey.
 */
const SURFACE_LIFT_M = 0.12;

export interface GreeneryResult {
  /**
   * Split where the belts split. A street tree by the barrier is part of the
   * first thing the scene draws; a tree on the hillside can wait for the belt
   * the hillside is in.
   */
  foliage: { core: Mesh; city: Mesh };
  trunks: { core: Mesh; city: Mesh };
  /** Water surfaces at ground level: swimming pools. */
  pools: Mesh;
  /** Playing surfaces: pitches and courts. */
  pitches: Mesh;
  /** True where the ground belongs to a park, a wood or a lawn. */
  isGreen(x: number, z: number): boolean;
  stats: {
    surveyed: number;
    fromRows: number;
    scattered: number;
    planted: number;
    skippedOnTrack: number;
    skippedAtSea: number;
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

// ─── planting ──────────────────────────────────────────────────────────────

/** Repeatable: the same spot grows the same tree every bake. */
function hashed(x: number, z: number, salt: number): number {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

// ─── geometry ──────────────────────────────────────────────────────────────

/**
 * A tree: a four-sided trunk under a six-sided canopy.
 *
 * Twenty triangles, which at a thousand trees is a fifth of what one belt
 * spends on buildings. What reads at street level is the canopy's silhouette
 * and the shadow under it, and neither needs a leaf.
 */
const CANOPY_SIDES = 6;

function tree(
  foliage: Mesh,
  trunks: Mesh,
  placement: TreePlacement,
  groundAt: (x: number, z: number) => number,
) {
  const { x, y, z, heightM, spinRad } = placement;
  const trunkH = heightM * 0.38;
  const trunkR = heightM * 0.035;
  const crownR = heightM * 0.32;
  const crownBottom = trunkH;
  const crownWaist = trunkH + (heightM - trunkH) * 0.4;
  const top = y + heightM;

  // Each corner of the trunk meets its own ground, never higher than the
  // tree's own: on a slope a single base plane leaves the downhill side of the
  // trunk in the air, which the audit sees as a floating tree.
  const foot = (fx: number, fz: number) => {
    const own = groundAt(fx, fz);
    return Number.isNaN(own) ? y : Math.min(own, y);
  };
  for (let i = 0; i < 4; i++) {
    const a0 = spinRad + (Math.PI * 2 * i) / 4;
    const a1 = spinRad + (Math.PI * 2 * (i + 1)) / 4;
    const x0 = x + Math.cos(a0) * trunkR;
    const z0 = z + Math.sin(a0) * trunkR;
    const x1 = x + Math.cos(a1) * trunkR;
    const z1 = z + Math.sin(a1) * trunkR;
    addFlatQuad(
      trunks,
      x0, foot(x0, z0), z0,
      x1, foot(x1, z1), z1,
      x1, y + trunkH, z1,
      x0, y + trunkH, z0,
    );
  }

  for (let i = 0; i < CANOPY_SIDES; i++) {
    const a0 = spinRad + (Math.PI * 2 * i) / CANOPY_SIDES;
    const a1 = spinRad + (Math.PI * 2 * (i + 1)) / CANOPY_SIDES;
    const x0 = x + Math.cos(a0) * crownR;
    const z0 = z + Math.sin(a0) * crownR;
    const x1 = x + Math.cos(a1) * crownR;
    const z1 = z + Math.sin(a1) * crownR;
    // Skirt down to where the canopy meets the trunk, then up to the crown.
    addFlatTriangle(
      foliage,
      x0, y + crownBottom, z0,
      x, y + crownBottom - crownR * 0.35, z,
      x1, y + crownBottom, z1,
    );
    addFlatQuad(
      foliage,
      x0, y + crownBottom, z0,
      x1, y + crownBottom, z1,
      x1, y + crownWaist, z1,
      x0, y + crownWaist, z0,
    );
    addFlatTriangle(
      foliage,
      x0, y + crownWaist, z0,
      x1, y + crownWaist, z1,
      x, top, z,
    );
  }
}

// ─── build ─────────────────────────────────────────────────────────────────

export function buildGreenery(
  ways: GreenWay[],
  field: HeightField,
  plane: ScenePlane,
  corridor: Corridor,
): GreeneryResult {
  const areas: Area[] = [];
  let areaM2 = 0;
  for (const way of ways) {
    if (way.kind === "tree" || way.kind === "tree_row") continue;
    if (way.points.length < 4) continue;
    if (!TINTED_KINDS.has(way.kind) && !PLANTED_KINDS.has(way.kind)) continue;
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
    surveyed: 0,
    fromRows: 0,
    scattered: 0,
    planted: 0,
    skippedOnTrack: 0,
    skippedAtSea: 0,
    areas: areas.length,
    areaM2: Math.round(areaM2),
    pools: 0,
    pitches: 0,
  };

  const foliage = { core: createMesh(), city: createMesh() };
  const trunks = { core: createMesh(), city: createMesh() };
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

  const plant = (x: number, z: number, salt: number): boolean => {
    const distance = corridor.distance(x, z);
    if (distance > TREE_RANGE_M) return false;
    if (distance < TRACK_CLEAR_M) {
      stats.skippedOnTrack++;
      return false;
    }
    const ground = field.heightAt(plane.lon(x), plane.lat(z));
    if (Number.isNaN(ground)) {
      stats.skippedAtSea++;
      return false;
    }
    const roll = hashed(x, z, salt);
    const belt = distance <= NEAR_M ? "core" : "city";
    tree(
      foliage[belt],
      trunks[belt],
      {
        x,
        z,
        y: ground,
        heightM: TREE_MIN_H_M + roll * (TREE_MAX_H_M - TREE_MIN_H_M),
        spinRad: hashed(z, x, salt + 1) * Math.PI * 2,
      },
      (fx, fz) => field.heightAt(plane.lon(fx), plane.lat(fz)),
    );
    stats.planted++;
    return true;
  };

  // What the survey knows exactly.
  for (const way of ways) {
    if (way.kind === "tree") {
      const [lon, lat] = way.points[0];
      if (plant(plane.x(lon), plane.z(lat), 1)) stats.surveyed++;
      continue;
    }
    if (way.kind !== "tree_row") continue;
    const points = way.points.map(([lon, lat]) => ({ x: plane.x(lon), z: plane.z(lat) }));
    let carried = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      for (let along = carried; along < length; along += ROW_STEP_M) {
        const t = along / length;
        if (plant(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, 2)) stats.fromRows++;
      }
      carried = (carried - length) % ROW_STEP_M;
      if (carried < 0) carried += ROW_STEP_M;
    }
  }

  // And what it only knows the outline of. The lattice is global rather than
  // per-area, so two parks that touch do not plant two trees in the same metre.
  for (const area of areas) {
    // Only what actually grows trees. A meadow or a lawn is green ground and
    // nothing else — Silverstone is ringed by 750 ha of farmland tagged
    // `landuse=grass`, and scattering into it planted 8 050 trees in fields.
    if (!PLANTED_KINDS.has(area.kind)) continue;
    const spacing = corridor.distance(
      (area.minX + area.maxX) / 2,
      (area.minZ + area.maxZ) / 2,
    ) <= NEAR_M
      ? SPACING_NEAR_M
      : SPACING_FAR_M;
    const fromCol = Math.ceil(area.minX / spacing);
    const toCol = Math.floor(area.maxX / spacing);
    const fromRow = Math.ceil(area.minZ / spacing);
    const toRow = Math.floor(area.maxZ / spacing);
    for (let col = fromCol; col <= toCol; col++) {
      for (let row = fromRow; row <= toRow; row++) {
        // Jittered, or a wood comes out as an orchard.
        const x = col * spacing + (hashed(col, row, 3) - 0.5) * spacing * 0.7;
        const z = row * spacing + (hashed(row, col, 4) - 0.5) * spacing * 0.7;
        if (!pointInRing(area.ring, x, z)) continue;
        if (plant(x, z, 5)) stats.scattered++;
      }
    }
  }

  return { foliage, trunks, pools, pitches, isGreen, stats };
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
