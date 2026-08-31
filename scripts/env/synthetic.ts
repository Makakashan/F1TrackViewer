/**
 * Synthetic ground for the invariant tests (`scene-goals.md` §3, layer A).
 *
 * A plane, a slope, a cut, a terrace, a ravine — grids small enough that the
 * expected answer is arithmetic rather than a previous run's output. The field
 * is built through `heightFieldFrom`, so a test reads heights through the same
 * interpolation the bake does; nothing here reimplements what it checks.
 *
 * The grid is placed on the equator with the field's own centre as the scene
 * origin, so one field cell is `cellM` metres in both axes exactly and scene X
 * and Z are metres east and south of the middle node.
 */

import { heightFieldFrom, type HeightField } from "./heightfield";
import { scenePlaneFor, type ScenePlane } from "./plane";
import type { BreaklineWay, ShoreWay } from "./overpass";
import { buildBreaklines, type Breaklines } from "./breaklines";
import { buildGround, type Ground } from "./ground";

const METERS_PER_DEG_LAT = 111_320;

export interface SyntheticFieldOptions {
  cols: number;
  rows: number;
  /** Field cell, in metres. Monaco's is 3.9; the default rounds it. */
  cellM?: number;
  /** Height at a node, in metres above the datum. NaN is water. */
  at(col: number, row: number): number;
}

/** A height field over a grid the caller writes by hand. Row 0 is the north edge. */
export function syntheticField(options: SyntheticFieldOptions): HeightField {
  const { cols, rows, at } = options;
  const cellM = options.cellM ?? 4;
  // Latitude 0: a degree of longitude is a degree of latitude in metres, so the
  // bbox that makes the cell square is the same span in both axes.
  const spanLat = ((rows - 1) * cellM) / METERS_PER_DEG_LAT;
  const spanLon = ((cols - 1) * cellM) / METERS_PER_DEG_LAT;
  const bbox = { minLon: -spanLon / 2, maxLon: spanLon / 2, minLat: -spanLat / 2, maxLat: spanLat / 2 };

  const data = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) data[row * cols + col] = at(col, row);
  }

  return heightFieldFrom({ bbox, width: cols, height: rows, data });
}

/** The scene plane a synthetic field sits on: its centre node is the origin. */
export function planeFor(field: HeightField): ScenePlane {
  const { minLon, maxLon, minLat, maxLat } = field.bbox;
  return scenePlaneFor([
    [minLon, minLat],
    [maxLon, maxLat],
  ]);
}

/** Degrees of the node at (col, row), for writing a breakline through the grid. */
export function lonLatOfNode(field: HeightField, col: number, row: number): [number, number] {
  const { minLon, maxLon, minLat, maxLat } = field.bbox;
  return [
    minLon + ((maxLon - minLon) * col) / (field.width - 1),
    maxLat - ((maxLat - minLat) * row) / (field.height - 1),
  ];
}

/** A cliff drawn through the field in node coordinates. */
export function cliffThrough(
  field: HeightField,
  nodes: [number, number][],
  kind: BreaklineWay["kind"] = "cliff",
): BreaklineWay {
  return {
    id: `synthetic-${kind}`,
    kind,
    points: nodes.map(([col, row]) => lonLatOfNode(field, col, row)),
  };
}

export function breaklinesOf(
  field: HeightField,
  ways: BreaklineWay[] = [],
  shore: ShoreWay[] = [],
): Breaklines {
  return buildBreaklines(field, ways, shore);
}

/** Field, plane and ground in one call — what most of the tests want. */
export function syntheticGround(
  options: SyntheticFieldOptions & { breaklines?: (field: HeightField) => Breaklines },
): { field: HeightField; plane: ScenePlane; ground: Ground } {
  const field = syntheticField(options);
  const plane = planeFor(field);
  const ground = buildGround(field, plane, options.breaklines?.(field));
  return { field, plane, ground };
}
