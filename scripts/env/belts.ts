/**
 * Detail belts, measured from the track centreline (docs/city-generation.md D7).
 *
 * Distance to the racing surface — not to the middle of the bbox — is what
 * decides how finely a thing is built, so the harbour and Le Rocher land in the
 * detailed belts on their own and the housing up the hill honestly does not.
 */

import type { ScenePlane } from "./plane";

export type Belt = "core" | "city" | "far";

export const BELT_ORDER: Belt[] = ["core", "city", "far"];

/** Outer edge of each belt, in metres from the centreline. `far` is the rest. */
export const BELT_RADIUS_M: Record<Exclude<Belt, "far">, number> = {
  core: 150,
  city: 600,
};

/** Terrain cell each belt is meshed at. D3, after P0.1 put the floor at 4 m. */
export const BELT_CELL_M: Record<Belt, number> = {
  core: 4,
  city: 8,
  far: 16,
};

/**
 * What each belt may ship (D5, D14). Lives here rather than in the audit
 * because the bake now spends against it too — the kit pass takes a share of a
 * belt's triangles — and two files holding the same budget is how they drift.
 */
export const BELT_BUDGET: Record<Belt, { bytes: number; triangles: number }> = {
  core: { bytes: 6_000_000, triangles: 450_000 },
  city: { bytes: 7_000_000, triangles: 350_000 },
  far: { bytes: 2_000_000, triangles: 120_000 },
};

export function beltAtDistance(distanceM: number): Belt {
  if (distanceM <= BELT_RADIUS_M.core) return "core";
  if (distanceM <= BELT_RADIUS_M.city) return "city";
  return "far";
}

export interface CorridorMeasure {
  distanceM: number;
  /** The point on the centreline the distance was measured to. */
  footX: number;
  footZ: number;
}

export interface Corridor {
  /** Metres from a scene-space point to the nearest point of the centreline. */
  distance(x: number, z: number): number;
  /** The same, with the foot of the measure — what pushing a footprint needs. */
  measure(x: number, z: number): CorridorMeasure;
  /** Densified centreline in scene space, as the distance is measured against. */
  samples: { x: number; z: number }[];
}

/** Step the centreline is resampled to before distances are measured. */
const SAMPLE_M = 10;

/**
 * Distances are asked for once per terrain cell and once per building vertex,
 * which is hundreds of thousands of queries against thousands of samples — so
 * the samples go in a uniform hash keyed by the widest belt, and a query only
 * looks at its own cell and the ring around it.
 */
export function buildCorridor(
  coords: [number, number][],
  plane: ScenePlane,
  reachM = BELT_RADIUS_M.city,
): Corridor {
  const samples: { x: number; z: number }[] = [];
  let previous = { x: plane.x(coords[0][0]), z: plane.z(coords[0][1]) };
  samples.push(previous);
  for (let i = 1; i < coords.length; i++) {
    const next = { x: plane.x(coords[i][0]), z: plane.z(coords[i][1]) };
    const steps = Math.max(1, Math.ceil(Math.hypot(next.x - previous.x, next.z - previous.z) / SAMPLE_M));
    for (let step = 1; step <= steps; step++) {
      samples.push({
        x: previous.x + ((next.x - previous.x) * step) / steps,
        z: previous.z + ((next.z - previous.z) * step) / steps,
      });
    }
    previous = next;
  }

  const cellSize = Math.max(reachM, SAMPLE_M) * 2;
  const grid = new Map<number, number[]>();
  const keyOf = (cx: number, cz: number) => cx * 100_000 + cz;
  for (let i = 0; i < samples.length; i++) {
    const key = keyOf(Math.floor(samples[i].x / cellSize), Math.floor(samples[i].z / cellSize));
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  function measure(x: number, z: number): CorridorMeasure {
    const cx = Math.floor(x / cellSize);
    const cz = Math.floor(z / cellSize);
    let bestSq = Infinity;
    let footX = x;
    let footZ = z;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const bucket = grid.get(keyOf(gx, gz));
        if (!bucket) continue;
        for (const i of bucket) {
          const a = samples[i];
          const b = samples[(i + 1) % samples.length];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const lengthSq = dx * dx + dz * dz;
          const t = lengthSq > 0
            ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq))
            : 0;
          const px = a.x + dx * t;
          const pz = a.z + dz * t;
          const distSq = (x - px) ** 2 + (z - pz) ** 2;
          if (distSq < bestSq) {
            bestSq = distSq;
            footX = px;
            footZ = pz;
          }
        }
      }
    }
    // Beyond the hash's reach every answer is "far", and the belt split is all
    // this is asked for.
    return { distanceM: bestSq === Infinity ? Infinity : Math.sqrt(bestSq), footX, footZ };
  }

  return { distance: (x, z) => measure(x, z).distanceM, measure, samples };
}
