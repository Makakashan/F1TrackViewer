/**
 * Where the circuit runs under the ground rather than on it.
 *
 * Monaco has 333 tunnelled ways and the circuit uses one of them, so a tunnel
 * only counts here if the racing line actually follows it. What this produces
 * is a predicate the height field asks before burning the track into the
 * ground: burning a tunnel in would carve a canyon through the hill the road
 * passes under (docs/city-generation.md D4).
 */

import type { StructureWay } from "./overpass";
import type { ScenePlane } from "./plane";

/** How close a tagged way has to run to the centreline to be the same road. */
const MATCH_DISTANCE_M = 12;
/**
 * Monaco is stacked: tunnels run beneath the streets the circuit uses, and by
 * horizontal distance alone the track appears to be inside all of them. A way
 * two levels down is under the road, not the road.
 */
const MIN_LAYER = -1;
/** The road the track follows runs along it; a tunnel crossing beneath does not. */
const MIN_DIRECTION_AGREEMENT = 0.8;
/** Portals are placed this far back from the first buried sample. */
const PORTAL_SETBACK_M = 4;

export interface TunnelRun {
  wayId: string;
  name?: string;
  /** Indices into the sample array the run covers. */
  from: number;
  to: number;
  lengthM: number;
  /** Scene-space mouths, in the order the track passes them. */
  entry: { x: number; z: number };
  exit: { x: number; z: number };
}

export interface TunnelMask {
  /** True where the track is under the ground. */
  buried(lon: number, lat: number): boolean;
  runs: TunnelRun[];
  buriedLengthM: number;
}

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit direction, for the parallel test. */
  ux: number;
  uz: number;
  way: StructureWay;
}

function distanceToSegment(
  x: number,
  z: number,
  segment: Segment,
): number {
  const dx = segment.bx - segment.ax;
  const dz = segment.bz - segment.az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0
    ? Math.min(1, Math.max(0, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq))
    : 0;
  return Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t));
}

/**
 * Walks the centreline and asks, at each step, whether a tunnelled way runs
 * along it. Consecutive hits become a run, which is what the portals are built
 * from.
 */
export function buildTunnelMask(
  coords: [number, number][],
  ways: StructureWay[],
  plane: ScenePlane,
  stepM = 5,
): TunnelMask {
  const segments: Segment[] = [];
  for (const way of ways) {
    if (!way.tunnel) continue;
    // A building passage is a road running through a building, not under a
    // hill: the ground above it is the building, which is already modelled.
    if (way.tunnel === "building_passage") continue;
    if (way.layer < MIN_LAYER) continue;
    for (let i = 0; i < way.points.length - 1; i++) {
      const ax = plane.x(way.points[i][0]);
      const az = plane.z(way.points[i][1]);
      const bx = plane.x(way.points[i + 1][0]);
      const bz = plane.z(way.points[i + 1][1]);
      const length = Math.hypot(bx - ax, bz - az) || 1;
      segments.push({ ax, az, bx, bz, ux: (bx - ax) / length, uz: (bz - az) / length, way });
    }
  }

  const samples: { x: number; z: number; lon: number; lat: number; ux: number; uz: number }[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = plane.x(coords[i][0]);
    const az = plane.z(coords[i][1]);
    const bx = plane.x(coords[i + 1][0]);
    const bz = plane.z(coords[i + 1][1]);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / stepM));
    const length = Math.hypot(bx - ax, bz - az) || 1;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const lon = coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t;
      const lat = coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t;
      samples.push({
        x: ax + (bx - ax) * t,
        z: az + (bz - az) * t,
        lon,
        lat,
        ux: (bx - ax) / length,
        uz: (bz - az) / length,
      });
    }
  }

  const hitWay: (StructureWay | null)[] = samples.map((sample) => {
    let best: StructureWay | null = null;
    let bestDistance = MATCH_DISTANCE_M;
    for (const segment of segments) {
      const agreement = Math.abs(sample.ux * segment.ux + sample.uz * segment.uz);
      if (agreement < MIN_DIRECTION_AGREEMENT) continue;
      const distance = distanceToSegment(sample.x, sample.z, segment);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = segment.way;
      }
    }
    return best;
  });

  const runs: TunnelRun[] = [];
  let start = -1;
  for (let i = 0; i <= hitWay.length; i++) {
    const inside = i < hitWay.length && hitWay[i] !== null;
    if (inside && start < 0) start = i;
    if (!inside && start >= 0) {
      const end = i - 1;
      const way = hitWay[start] as StructureWay;
      const lengthM = (end - start) * stepM;
      // A couple of samples is a way passing under a junction, not a tunnel the
      // track drives through.
      if (lengthM >= 40) {
        runs.push({
          wayId: way.id,
          name: way.name,
          from: start,
          to: end,
          lengthM,
          entry: samples[Math.max(0, start)],
          exit: samples[Math.min(samples.length - 1, end)],
        });
      }
      start = -1;
    }
  }

  const buriedSamples = new Set<number>();
  for (const run of runs) {
    for (let i = run.from; i <= run.to; i++) buriedSamples.add(i);
  }

  // The predicate is asked for arbitrary points, so it answers by proximity to
  // the samples the runs cover rather than by index.
  const buriedPoints = [...buriedSamples].map((i) => samples[i]);
  const setback = PORTAL_SETBACK_M;

  function buried(lon: number, lat: number): boolean {
    if (!buriedPoints.length) return false;
    const x = plane.x(lon);
    const z = plane.z(lat);
    for (const point of buriedPoints) {
      if (Math.hypot(x - point.x, z - point.z) <= stepM + setback) return true;
    }
    return false;
  }

  return {
    buried,
    runs,
    buriedLengthM: buriedSamples.size * stepM,
  };
}
