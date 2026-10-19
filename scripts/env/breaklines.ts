/**
 * Lines the ground may break along. Averaging ramps a 6 m quay wall and softer
 * kernels don't help; refusing to reach across a surveyed wall keeps the step.
 */

import type { BreaklineWay, ShoreWay } from "./overpass";
import type { HeightField } from "./heightfield";

/** A breakline segment in field-node space: column is x, row is y. */
interface Segment {
  /** A natural cliff, as against a built wall: the two are smoothed differently. */
  cliff: boolean;
  /** A quay or a breakwater: the edge of the land, not a step inside it. */
  shore: boolean;
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

export interface Breaklines {
  /** Does the straight line between two field nodes cross a surveyed line? */
  crosses(col0: number, row0: number, col1: number, row1: number): boolean;
  /** The same question asked in degrees, for callers that hold no field index. */
  crossesLonLat(lon0: number, lat0: number, lon1: number, lat1: number): boolean;
  /** Built lines only: walls, quays, breakwaters. A cliff is the ground itself. */
  crossesWallLonLat(lon0: number, lat0: number, lon1: number, lat1: number): boolean;
  /** The same, counting built lines inside the land only: a retaining wall, not a quay or a cliff. */
  crossesRetainingLonLat(lon0: number, lat0: number, lon1: number, lat1: number): boolean;
  /** Is any surveyed line inside this box? Answered from the index alone. */
  near(col0: number, row0: number, col1: number, row1: number): boolean;
  /** How many segments were indexed. Zero means the filter behaves as a box. */
  readonly count: number;
}

/** Field cells per index bucket. Small enough to stay sparse, big enough to hold. */
const BUCKET = 8;

function orient(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/** Quays and breakwaters are walls with ground on both sides; a coastline is the sea's edge. */
const SHORE_BREAKLINES = new Set<ShoreWay["kind"]>(["quay", "breakwater"]);

export function buildBreaklines(
  /** The grid the lines are indexed on: the field, or the raster it is built from. */
  field: Pick<HeightField, "bbox" | "width" | "height">,
  breaklineWays: BreaklineWay[],
  shoreWays: ShoreWay[],
): Breaklines {
  const { minLon, maxLon, minLat, maxLat } = field.bbox;
  const toCol = (lon: number) => ((lon - minLon) / (maxLon - minLon)) * (field.width - 1);
  const toRow = (lat: number) => ((maxLat - lat) / (maxLat - minLat)) * (field.height - 1);

  const segments: Segment[] = [];
  const addLine = (points: [number, number][], cliff: boolean, shore: boolean) => {
    for (let i = 1; i < points.length; i++) {
      const segment: Segment = {
        cliff,
        shore,
        c0: toCol(points[i - 1][0]),
        r0: toRow(points[i - 1][1]),
        c1: toCol(points[i][0]),
        r1: toRow(points[i][1]),
      };
      // A way can run well past the field — OSM answers a bbox, not a circuit.
      // A segment wholly outside is dropped rather than indexed, because the
      // index clamps to the grid and would cut the edge where nothing runs.
      const outside =
        (segment.c0 < 0 && segment.c1 < 0) ||
        (segment.r0 < 0 && segment.r1 < 0) ||
        (segment.c0 > field.width - 1 && segment.c1 > field.width - 1) ||
        (segment.r0 > field.height - 1 && segment.r1 > field.height - 1);
      if (!outside) segments.push(segment);
    }
  };
  for (const way of breaklineWays) addLine(way.points, way.kind === "cliff", false);
  for (const way of shoreWays) if (SHORE_BREAKLINES.has(way.kind)) addLine(way.points, false, true);

  const bucketCols = Math.ceil(field.width / BUCKET);
  const bucketRows = Math.ceil(field.height / BUCKET);
  const buckets: Segment[][] = Array.from({ length: bucketCols * bucketRows }, () => []);
  for (const segment of segments) {
    // One bucket of margin: a segment is tested from a bucket a query may touch
    // without either endpoint landing in it.
    const c0 = Math.max(0, Math.floor(Math.min(segment.c0, segment.c1) / BUCKET) - 1);
    const c1 = Math.min(bucketCols - 1, Math.floor(Math.max(segment.c0, segment.c1) / BUCKET) + 1);
    const r0 = Math.max(0, Math.floor(Math.min(segment.r0, segment.r1) / BUCKET) - 1);
    const r1 = Math.min(bucketRows - 1, Math.floor(Math.max(segment.r0, segment.r1) / BUCKET) + 1);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) buckets[row * bucketCols + col].push(segment);
    }
  }

  const crosses = (
    col0: number,
    row0: number,
    col1: number,
    row1: number,
    builtOnly = false,
    inlandOnly = false,
  ): boolean => {
    if (!segments.length) return false;
    const bc0 = Math.max(0, Math.floor(Math.min(col0, col1) / BUCKET));
    const bc1 = Math.min(bucketCols - 1, Math.floor(Math.max(col0, col1) / BUCKET));
    const br0 = Math.max(0, Math.floor(Math.min(row0, row1) / BUCKET));
    const br1 = Math.min(bucketRows - 1, Math.floor(Math.max(row0, row1) / BUCKET));
    for (let br = br0; br <= br1; br++) {
      for (let bc = bc0; bc <= bc1; bc++) {
        for (const s of buckets[br * bucketCols + bc]) {
          if (builtOnly && s.cliff) continue;
          if (inlandOnly && s.shore) continue;
          const d1 = orient(col0, row0, col1, row1, s.c0, s.r0);
          const d2 = orient(col0, row0, col1, row1, s.c1, s.r1);
          if (d1 > 0 === d2 > 0) continue;
          const d3 = orient(s.c0, s.r0, s.c1, s.r1, col0, row0);
          const d4 = orient(s.c0, s.r0, s.c1, s.r1, col1, row1);
          if (d3 > 0 === d4 > 0) continue;
          return true;
        }
      }
    }
    return false;
  };

  const crossesLonLat = (lon0: number, lat0: number, lon1: number, lat1: number): boolean =>
    crosses(toCol(lon0), toRow(lat0), toCol(lon1), toRow(lat1));

  const crossesWallLonLat = (lon0: number, lat0: number, lon1: number, lat1: number): boolean =>
    crosses(toCol(lon0), toRow(lat0), toCol(lon1), toRow(lat1), true);

  const crossesRetainingLonLat = (lon0: number, lat0: number, lon1: number, lat1: number): boolean =>
    crosses(toCol(lon0), toRow(lat0), toCol(lon1), toRow(lat1), true, true);

  const near = (col0: number, row0: number, col1: number, row1: number): boolean => {
    const bc0 = Math.max(0, Math.floor(Math.min(col0, col1) / BUCKET));
    const bc1 = Math.min(bucketCols - 1, Math.floor(Math.max(col0, col1) / BUCKET));
    const br0 = Math.max(0, Math.floor(Math.min(row0, row1) / BUCKET));
    const br1 = Math.min(bucketRows - 1, Math.floor(Math.max(row0, row1) / BUCKET));
    for (let br = br0; br <= br1; br++) {
      for (let bc = bc0; bc <= bc1; bc++) if (buckets[br * bucketCols + bc].length) return true;
    }
    return false;
  };

  return { crosses, crossesLonLat, crossesWallLonLat, crossesRetainingLonLat, near, count: segments.length };
}
