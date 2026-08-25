/**
 * Surveyed surfaces that are neither ground nor building (docs/city-generation.md P4.3).
 *
 * What is left of the greenery pass. Trees were built here once, a canopy and a
 * trunk each, and read as one six-sided shape repeated a thousand times; the
 * green ground tint that replaced them at range read as paint on the terrain.
 * Both are gone. The terrain keeps its own colour and the survey's `natural=tree`,
 * `tree_row`, woods and lawns are fetched and ignored.
 *
 * Two kinds of area are still drawn, because they are things rather than
 * colour: a swimming pool and a pitch. Monaco's pool quay reads as bare
 * concrete otherwise, and the halls beside the pool are the Grand Prix's own
 * and are in nobody's survey.
 */

import type { HeightField } from "./heightfield";
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
  /** Water surfaces at ground level: swimming pools. */
  pools: Mesh;
  /** Playing surfaces: pitches and courts. */
  pitches: Mesh;
  stats: {
    pools: number;
    pitches: number;
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
  field: HeightField,
  plane: ScenePlane,
): GreeneryResult {
  const stats: GreeneryResult["stats"] = { pools: 0, pitches: 0 };

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

  return { pools, pitches, stats };
}
