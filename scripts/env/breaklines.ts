/**
 * The lines the ground is allowed to break along — breaklines, in the surveying
 * sense: a line a surface is not interpolated across.
 *
 * A belt coarser than the height field has to average it or it aliases
 * (`ground.ts`), and averaging is indiscriminate: a 6 m quay wall inside the
 * window comes out as a ramp across it. Measured on Monaco's city belt, the box
 * filter keeps 85% of the step across a surveyed cliff or retaining wall — a
 * 10 m drop arrives 1.5 m short, twice, once on each side.
 *
 * Softer kernels do not fix this. A bilateral weighted against the raw centre
 * keeps the centre's own noise and filters nothing; weighted against the local
 * mean it lands on the same noise-against-edges curve the box is already on —
 * at equal kink the two keep the same fraction of the step. The DTM smears a
 * wall over two or three of its own cells, so at a window of two or three cells
 * there is no height gap left to separate.
 *
 * What works is knowing where the wall is. OSM surveyed these lines; a window
 * that refuses to reach across one averages each side against itself, and the
 * step comes back — to 125% of what the raw samples show, because the samples
 * were smeared too.
 */

import type { BreaklineWay, ShoreWay } from "./overpass";
import type { HeightField } from "./heightfield";

/** A breakline segment in field-node space: column is x, row is y. */
interface Segment {
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
  /**
   * Is any surveyed line inside this box of field nodes? Answered from the
   * index alone, so a filter can ask before it decides how hard to work.
   */
  near(col0: number, row0: number, col1: number, row1: number): boolean;
  /** How many segments were indexed. Zero means the filter behaves as a box. */
  readonly count: number;
}

/** Field cells per index bucket. Small enough to stay sparse, big enough to hold. */
const BUCKET = 8;

function orient(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/**
 * Which shore lines are walls rather than water.
 *
 * A coastline is the edge of the sea and the terrain is already cut against it,
 * so averaging across it reaches into nodata and is handled by the valid-node
 * count. A quay or a breakwater is a built vertical face with ground on both
 * sides, which is exactly what the filter must not smooth away.
 */
const SHORE_BREAKLINES = new Set<ShoreWay["kind"]>(["quay", "breakwater"]);

export function buildBreaklines(
  field: HeightField,
  breaklineWays: BreaklineWay[],
  shoreWays: ShoreWay[],
): Breaklines {
  const { minLon, maxLon, minLat, maxLat } = field.bbox;
  const toCol = (lon: number) => ((lon - minLon) / (maxLon - minLon)) * (field.width - 1);
  const toRow = (lat: number) => ((maxLat - lat) / (maxLat - minLat)) * (field.height - 1);

  const segments: Segment[] = [];
  const addLine = (points: [number, number][]) => {
    for (let i = 1; i < points.length; i++) {
      const segment: Segment = {
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
  for (const way of breaklineWays) addLine(way.points);
  for (const way of shoreWays) if (SHORE_BREAKLINES.has(way.kind)) addLine(way.points);

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

  const crosses = (col0: number, row0: number, col1: number, row1: number): boolean => {
    if (!segments.length) return false;
    const bc0 = Math.max(0, Math.floor(Math.min(col0, col1) / BUCKET));
    const bc1 = Math.min(bucketCols - 1, Math.floor(Math.max(col0, col1) / BUCKET));
    const br0 = Math.max(0, Math.floor(Math.min(row0, row1) / BUCKET));
    const br1 = Math.min(bucketRows - 1, Math.floor(Math.max(row0, row1) / BUCKET));
    for (let br = br0; br <= br1; br++) {
      for (let bc = bc0; bc <= bc1; bc++) {
        for (const s of buckets[br * bucketCols + bc]) {
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

  return { crosses, crossesLonLat, near, count: segments.length };
}
