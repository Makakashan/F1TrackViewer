/**
 * The built edge of the water: quay walls, breakwaters, the coastline itself.
 *
 * The terrain's own edge is already the coastline (D15), but at a 4 m cell it
 * ends in a staircase, and Monaco's waterfront is a vertical wall of concrete
 * rather than an eroded slope. These walls stand along the OSM line where the
 * DEM agrees that the water is there.
 *
 * Agreement is the whole point. An OSM line that runs across dry ground, or out
 * in open water, is a line the raster disagrees with, and building a wall along
 * it would put a slab in the middle of a street or a fence in the sea. So each
 * segment is checked: water on one side, ground on the other, or it is skipped.
 */

import type { ShoreWay } from "./overpass";
import type { HeightField } from "./heightfield";
import { addFlatQuad, createMesh, type Mesh } from "./mesh";
import type { ScenePlane } from "./plane";

/**
 * How far to each side the field is asked which element it is looking at. The
 * search widens: OSM's line and the raster's edge are drawn from different
 * surveys and rarely land on the same metre, so the line gives the wall its
 * direction and the raster gives it its position.
 */
const PROBE_STEPS_M = [3, 6, 9, 12];
/** Below the datum the wall keeps going, so no gap opens under the water. */
const FOOT_M = 2.5;
/** A quay is at least this tall even where the ground behind it is barely dry. */
const MIN_TOP_M = 1.5;
/**
 * And no taller than this, or it is not a quay.
 *
 * The wall takes its height from the ground behind the line, which is right on a
 * waterfront and absurd against a cliff: along Le Rocher the ground behind the
 * coastline is the clifftop, and the walls came out as a row of 38 m fangs
 * standing out of the sea. Nobody poured that; it is a headland, and the terrain
 * already renders it. Median wall is 1.6 m, so this cuts the tail, not the job.
 */
const MAX_TOP_M = 8;

export interface ShoreResult {
  walls: Mesh;
  built: number;
  skippedDisagreement: number;
  skippedKind: number;
  /** Segments where the ground behind the line is a cliff, not a quay. */
  skippedCliff: number;
}

export function bakeShoreWalls(
  ways: ShoreWay[],
  field: HeightField,
  plane: ScenePlane,
): ShoreResult {
  const walls = createMesh();
  const result: ShoreResult = {
    walls,
    built: 0,
    skippedDisagreement: 0,
    skippedKind: 0,
    skippedCliff: 0,
  };

  for (const way of ways) {
    // A pier runs down the middle of its own deck, so both sides of the line
    // are the same thing and the water test cannot say anything about it. A
    // basin's outline is a water area, not a built edge — it says where the
    // water stops, not that anyone poured concrete there.
    if (way.kind === "pier" || way.kind === "groyne" || way.kind === "water") {
      result.skippedKind++;
      continue;
    }

    for (let i = 0; i < way.points.length - 1; i++) {
      const ax = plane.x(way.points[i][0]);
      const az = plane.z(way.points[i][1]);
      const bx = plane.x(way.points[i + 1][0]);
      const bz = plane.z(way.points[i + 1][1]);
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.5) continue;

      const nx = -(bz - az) / length;
      const nz = (bx - ax) / length;
      const midX = (ax + bx) / 2;
      const midZ = (az + bz) / 2;

      let leftIsWater = false;
      let groundHeight = Number.NaN;
      for (const probe of PROBE_STEPS_M) {
        const left = field.heightAt(
          plane.lon(midX + nx * probe),
          plane.lat(midZ + nz * probe),
        );
        const right = field.heightAt(
          plane.lon(midX - nx * probe),
          plane.lat(midZ - nz * probe),
        );
        const leftWater = Number.isNaN(left);
        const rightWater = Number.isNaN(right);
        if (leftWater === rightWater) continue;
        leftIsWater = leftWater;
        groundHeight = leftWater ? right : left;
        break;
      }
      if (Number.isNaN(groundHeight)) {
        // No probe found an edge: the line runs well inside the land or well
        // out in the water, and a wall here would be a guess.
        result.skippedDisagreement++;
        continue;
      }
      if (groundHeight > MAX_TOP_M) {
        result.skippedCliff++;
        continue;
      }
      const top = Math.max(MIN_TOP_M, groundHeight);
      // Face the water: the wall is seen from the harbour, not from the street.
      const sign = leftIsWater ? 1 : -1;
      const ox = nx * 0.2 * sign;
      const oz = nz * 0.2 * sign;

      if (sign > 0) {
        addFlatQuad(
          walls,
          ax + ox, -FOOT_M, az + oz,
          bx + ox, -FOOT_M, bz + oz,
          bx + ox, top, bz + oz,
          ax + ox, top, az + oz,
        );
      } else {
        addFlatQuad(
          walls,
          bx + ox, -FOOT_M, bz + oz,
          ax + ox, -FOOT_M, az + oz,
          ax + ox, top, az + oz,
          bx + ox, top, bz + oz,
        );
      }
      result.built++;
    }
  }

  return result;
}
