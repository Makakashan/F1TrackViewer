/**
 * The two questions asked of a shipped mesh: how high is the ground under a
 * point (I1), and which of these triangles are one building (I2).
 *
 * Both are pure functions over geometry, so the meshes here are written by
 * hand — a slab, a box, a roof on it — and the expected answers are the
 * geometry's own.
 */

import { describe, expect, test } from "bun:test";
import { buildSurfaceIndex, buildingPieces, connectedComponents, type BakedMesh } from "./baked-scene";

/** A flat-shaded box, corner to corner, as the bake ships one. */
function box(min: [number, number, number], max: [number, number, number]): BakedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const corners: [number, number, number][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) {
    // Every face carries its own copy of each corner, which is what makes the
    // weld-by-position step in `connectedComponents` necessary.
    const first = positions.length / 3;
    for (const corner of [a, b, c, d]) positions.push(...corners[corner]);
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return {
    name: "buildings",
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    colors: null,
    triangles: indices.length / 3,
  };
}

/** One quad of ground, tilted, split across its main diagonal. */
function slab(size: number, heightAt: (x: number, z: number) => number) {
  const positions = new Float32Array([
    0, heightAt(0, 0), 0,
    size, heightAt(size, 0), 0,
    0, heightAt(0, size), size,
    size, heightAt(size, size), size,
  ]);
  return { positions, indices: new Uint32Array([0, 2, 3, 0, 3, 1]) };
}

function merge(meshes: BakedMesh[]): BakedMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of meshes) {
    const base = positions.length / 3;
    positions.push(...mesh.positions);
    for (const index of mesh.indices) indices.push(base + index);
  }
  return {
    name: "buildings",
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    colors: null,
    triangles: indices.length / 3,
  };
}

describe("the ground as drawn (I1)", () => {
  const plane = (x: number, z: number) => 10 + x * 0.25 - z * 0.1;
  const index = buildSurfaceIndex([[slab(64, plane)]]);

  test("a query inside a triangle answers that triangle's own plane", () => {
    for (const [x, z] of [[1, 1], [10.5, 3.25], [31.5, 40.75], [63, 62]] as const) {
      expect(index.at(x, z)).toBeCloseTo(plane(x, z), 6);
    }
  });

  test("a query off the mesh answers nothing rather than the datum", () => {
    expect(index.at(-5, 10)).toBeNaN();
    expect(index.at(10, 200)).toBeNaN();
  });

  test("where two surfaces overlap the finer one wins", () => {
    const fine = slab(64, () => 30);
    const coarse = slab(64, () => 5);
    expect(buildSurfaceIndex([[fine], [coarse]]).at(10, 10)).toBe(30);
    expect(buildSurfaceIndex([[coarse], [fine]]).at(10, 10)).toBe(5);
  });

  test("a vertical skirt is not ground", () => {
    // A wall hanging off a belt's edge: no footprint, and two answers for one
    // point. Asking it for a height is the question it cannot answer.
    const skirt = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, -20, 0, 10, -20, 0]),
      indices: new Uint32Array([0, 2, 3, 0, 3, 1]),
    };
    expect(buildSurfaceIndex([[skirt]]).at(5, 0)).toBeNaN();
  });
});

describe("buildings out of one merged mesh (I2)", () => {
  test("a flat-shaded box is one piece, not twelve faces", () => {
    expect(connectedComponents(box([0, 0, 0], [10, 12, 10])).count).toBe(1);
  });

  test("two blocks apart stay two buildings", () => {
    const mesh = merge([box([0, 0, 0], [10, 12, 10]), box([40, 0, 40], [50, 15, 50])]);
    expect(buildingPieces(mesh).count).toBe(2);
  });

  test("a roof sharing no vertex with its walls is welded to them", () => {
    // The bug this rule exists for: the roof measures as a building floating at
    // its own storey height, and the walls below it are what reaches the ground.
    const mesh = merge([box([0, 0, 0], [10, 12, 10]), box([-0.3, 12, -0.3], [10.3, 12.6, 10.3])]);
    expect(connectedComponents(mesh).count).toBe(2);
    expect(buildingPieces(mesh).count).toBe(1);
  });

  test("a roof left hanging above its walls is not", () => {
    const mesh = merge([box([0, 0, 0], [10, 12, 10]), box([0, 15, 0], [10, 15.6, 10])]);
    expect(buildingPieces(mesh).count).toBe(2);
  });

  test("a slab hanging inside a tower's plan is missed, and that is known", () => {
    // The documented hole in the rule (scene-goals.md §2): overlapping in plan
    // and meeting in height is enough to weld, so a balcony with nothing under
    // it joins the tower and never reports as floating. §4's cameras cover it.
    const mesh = merge([box([0, 0, 0], [10, 40, 10]), box([2, 20, 2], [8, 20.5, 8])]);
    expect(buildingPieces(mesh).count).toBe(1);
  });
});
