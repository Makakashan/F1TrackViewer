/**
 * The index that tells the ground filter where it may not average across.
 *
 * Everything here is geometry in field-node coordinates, so the answers are
 * the ones a pencil gives.
 */

import { describe, expect, test } from "bun:test";
import type { ShoreWay } from "./overpass";
import { breaklinesOf, cliffThrough, lonLatOfNode, syntheticField } from "./synthetic";

const field = syntheticField({ cols: 65, rows: 65, at: () => 0 });
/** A wall down the middle, between field columns 33 and 34. */
const wall = () => breaklinesOf(field, [cliffThrough(field, [[33.5, -2], [33.5, 66]])]);

describe("with nothing surveyed", () => {
  const none = breaklinesOf(field);

  test("the filter is told so, and behaves as a plain box", () => {
    expect(none.count).toBe(0);
    expect(none.crosses(0, 0, 64, 64)).toBe(false);
    expect(none.near(0, 0, 64, 64)).toBe(false);
  });
});

describe("a wall down the middle", () => {
  const lines = wall();

  test("a step across it crosses", () => {
    expect(lines.crosses(32, 10, 35, 10)).toBe(true);
    expect(lines.crosses(33, 10, 34, 10)).toBe(true);
  });

  test("a step on one side does not", () => {
    expect(lines.crosses(34, 10, 36, 10)).toBe(false);
    expect(lines.crosses(20, 10, 33, 40)).toBe(false);
  });

  test("nor does one running along it", () => {
    // Collinear is not crossing: a window either side of a wall still averages
    // along the wall, which is the direction that has ground on both ends.
    expect(lines.crosses(33.5, 5, 33.5, 40)).toBe(false);
  });

  test("the same question in degrees gives the same answer", () => {
    const [lonA, latA] = lonLatOfNode(field, 32, 10);
    const [lonB, latB] = lonLatOfNode(field, 35, 10);
    expect(lines.crossesLonLat(lonA, latA, lonB, latB)).toBe(true);
    const [lonC, latC] = lonLatOfNode(field, 36, 10);
    expect(lines.crossesLonLat(lonB, latB, lonC, latC)).toBe(false);
  });

  test("a window is near it when the line only clips a corner", () => {
    // What the fast path is for: `crosses` on the window's diagonal would miss
    // a wall that cuts one corner off, so the question asked first is whether
    // any line is inside the window at all.
    expect(lines.near(30, 0, 36, 8)).toBe(true);
    expect(lines.near(0, 0, 8, 8)).toBe(false);
  });
});

describe("a way that runs past the field", () => {
  test("is kept for the part that is inside", () => {
    const half = breaklinesOf(field, [cliffThrough(field, [[-200, 32], [32, 32]])]);
    expect(half.count).toBe(1);
    expect(half.crosses(20, 30, 20, 34)).toBe(true);
  });

  test("and is dropped when none of it is", () => {
    // The index clamps to the grid, so a segment kilometres away would
    // otherwise cut the field's own edge where nothing runs.
    const outside = breaklinesOf(field, [cliffThrough(field, [[-400, -300], [-200, -300]])]);
    expect(outside.count).toBe(0);
    expect(outside.crosses(0, 0, 5, 5)).toBe(false);
  });
});

describe("the shore", () => {
  const shoreWay = (kind: ShoreWay["kind"]): ShoreWay => ({
    id: `synthetic-${kind}`,
    kind,
    points: [lonLatOfNode(field, 33.5, -2), lonLatOfNode(field, 33.5, 66)],
  });

  test("a quay and a breakwater are walls the filter stops at", () => {
    expect(breaklinesOf(field, [], [shoreWay("quay")]).count).toBe(1);
    expect(breaklinesOf(field, [], [shoreWay("breakwater")]).count).toBe(1);
  });

  test("a coastline is not — the terrain is already cut against it", () => {
    for (const kind of ["coastline", "pier", "groyne", "water"] as const) {
      expect(breaklinesOf(field, [], [shoreWay(kind)]).count).toBe(0);
    }
  });
});
