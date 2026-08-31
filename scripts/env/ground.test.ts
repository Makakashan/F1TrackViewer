/**
 * Layer A of `scene-goals.md` §3: the ground's invariants on ground we wrote
 * ourselves. A plane, a 30° slope, a vertical cut, a terrace, a ravine — no
 * network, no cache, milliseconds.
 *
 * The numbers here are arithmetic, not a previous run's output: a box filter of
 * a linear ramp is the ramp, a window that stops at a wall keeps the whole
 * step, and a query has to answer about the triangle the mesher draws.
 */

import { describe, expect, test } from "bun:test";
import { BELT_ORDER, type Belt } from "./belts";
import { buildSurfaceIndex, type SurfaceMesh } from "./baked-scene";
import type { BeltGrid, Ground } from "./ground";
import { breaklinesOf, cliffThrough, syntheticGround } from "./synthetic";

const MM = 1e-3;

/** Every node of a belt's grid, margin excluded. */
function nodes(ground: Ground, belt: Belt): { row: number; col: number; x: number; z: number }[] {
  const grid = ground.gridFor(belt);
  const out: { row: number; col: number; x: number; z: number }[] = [];
  for (let row = 0; row <= grid.rows; row++) {
    for (let col = 0; col <= grid.cols; col++) {
      out.push({ row, col, x: grid.minX + col * grid.cell, z: grid.minZ + row * grid.cell });
    }
  }
  return out;
}

/** The belt as the mesher draws it: a cell split across its main diagonal. */
function meshOf(ground: Ground, belt: Belt): SurfaceMesh {
  const grid = ground.gridFor(belt);
  const width = grid.cols + 1;
  const positions = new Float32Array(width * (grid.rows + 1) * 3);
  for (let row = 0; row <= grid.rows; row++) {
    for (let col = 0; col <= grid.cols; col++) {
      const at = (row * width + col) * 3;
      positions[at] = grid.minX + col * grid.cell;
      positions[at + 1] = ground.nodeAt(belt, row, col);
      positions[at + 2] = grid.minZ + row * grid.cell;
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const a = row * width + col;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      if (![a, b, c, d].every((i) => Number.isFinite(positions[i * 3 + 1]))) continue;
      indices.push(a, c, d, a, d, b); // the main diagonal, a to d
    }
  }
  return { positions, indices: new Uint32Array(indices) };
}

/** RMS of `2h − h₋ − h₊` along the rows — I7's kink, in metres. */
function kinkOf(grid: BeltGrid, heightAt: (row: number, col: number) => number): number {
  let sum = 0;
  let count = 0;
  // The outer ring is left out: there the window clamps at the field's edge and
  // a one-sided mean of sloping ground is biased, which is not what is measured.
  for (let row = 1; row < grid.rows; row++) {
    for (let col = 2; col < grid.cols - 1; col++) {
      const h = heightAt(row, col);
      const before = heightAt(row, col - 1);
      const after = heightAt(row, col + 1);
      if (!Number.isFinite(h + before + after)) continue;
      sum += (2 * h - before - after) ** 2;
      count++;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}

const kinkAlongRows = (ground: Ground, belt: Belt) =>
  kinkOf(ground.gridFor(belt), (row, col) => ground.nodeAt(belt, row, col));

describe("a plane", () => {
  const { ground } = syntheticGround({ cols: 65, rows: 65, at: () => 100 });

  test("every belt reads the plane's own height at every node", () => {
    for (const belt of BELT_ORDER) {
      for (const { row, col } of nodes(ground, belt)) {
        expect(ground.nodeAt(belt, row, col)).toBe(100);
      }
    }
  });

  test("and between the nodes as well", () => {
    for (const belt of BELT_ORDER) {
      for (const x of [-100.5, -3.25, 0, 17.75, 96]) {
        for (const z of [-90.5, -1.5, 0, 22.25, 88]) {
          expect(ground.at(x, z, belt)).toBeCloseTo(100, 9);
        }
      }
    }
  });
});

describe("a 30° slope", () => {
  const slope = Math.tan((30 * Math.PI) / 180);
  const cellM = 4;
  // Height depends on x alone, so the analytic answer at any scene point is a
  // line — which a symmetric box filter reproduces exactly away from the edge.
  const { ground } = syntheticGround({ cols: 65, rows: 65, cellM, at: (col) => col * cellM * slope });
  const heightAtX = (x: number) => (x + (64 * cellM) / 2) * slope;

  test("the filter does not flatten it — nodes sit on the ramp to the millimetre", () => {
    for (const belt of BELT_ORDER) {
      const grid = ground.gridFor(belt);
      for (const { row, col, x } of nodes(ground, belt)) {
        // The window clamps at the field's edge, where a symmetric mean is no
        // longer symmetric; the interior is what the invariant is about.
        const margin = grid.radius * cellM + grid.cell;
        if (x < grid.minX + margin || x > -grid.minX - margin) continue;
        expect(ground.nodeAt(belt, row, col)).toBeCloseTo(heightAtX(x), 3);
      }
    }
  });

  test("and the drawn surface keeps the same gradient", () => {
    for (const belt of BELT_ORDER) {
      const rise = ground.at(40, 0, belt) - ground.at(-40, 0, belt);
      expect(rise / 80).toBeCloseTo(slope, 6);
    }
  });
});

describe("a vertical cut", () => {
  const cellM = 4;
  // A 10 m wall between field columns 33 and 34, so it falls between belt nodes
  // rather than on one: the far belt's nodes at x = 0 and x = 16 are columns 32
  // and 36, and the raw step between them is the whole 10 m.
  const options = { cols: 65, rows: 65, cellM, at: (col: number) => (col >= 34 ? 10 : 0) };
  const wall = (field: Parameters<typeof cliffThrough>[0]) =>
    breaklinesOf(field, [cliffThrough(field, [[33.5, -2], [33.5, 66]])]);

  const smoothed = syntheticGround(options).ground;
  const kept = syntheticGround({ ...options, breaklines: wall }).ground;

  const stepOf = (ground: Ground) => {
    const grid = ground.gridFor("far");
    const col = Math.round((0 - grid.minX) / grid.cell);
    const row = Math.round((0 - grid.minZ) / grid.cell);
    return ground.nodeAt("far", row, col + 1) - ground.nodeAt("far", row, col);
  };

  test("a plain window ramps the wall — this is why breaklines exist", () => {
    expect(stepOf(smoothed) / 10).toBeLessThan(0.9);
  });

  test("a window that stops at the surveyed line keeps the step (I7)", () => {
    expect(stepOf(kept) / 10).toBeGreaterThanOrEqual(0.95);
  });

  test("and keeps each side flat at its own level", () => {
    const grid = kept.gridFor("far");
    const row = Math.round((0 - grid.minZ) / grid.cell);
    const col = Math.round((0 - grid.minX) / grid.cell);
    expect(kept.nodeAt("far", row, col)).toBeCloseTo(0, 6);
    expect(kept.nodeAt("far", row, col + 1)).toBeCloseTo(10, 6);
  });
});

describe("a terrace", () => {
  const cellM = 4;
  // Three levels, each 40 field cells wide, with a retaining wall at each riser.
  const levelOf = (col: number) => (col < 21 ? 0 : col < 41 ? 5 : 10);
  const { ground } = syntheticGround({
    cols: 65,
    rows: 65,
    cellM,
    at: (col) => levelOf(col),
    breaklines: (field) =>
      breaklinesOf(field, [
        cliffThrough(field, [[20.5, -2], [20.5, 66]], "retaining_wall"),
        cliffThrough(field, [[40.5, -2], [40.5, 66]], "retaining_wall"),
      ]),
  });

  test("every node keeps the level of the terrace it stands on", () => {
    for (const belt of BELT_ORDER) {
      const grid = ground.gridFor(belt);
      for (const { row, col, x } of nodes(ground, belt)) {
        const fieldCol = Math.round((x - grid.minX) / cellM);
        expect(ground.nodeAt(belt, row, col)).toBeCloseTo(levelOf(fieldCol), 6);
      }
    }
  });
});

describe("a ravine", () => {
  const cellM = 4;
  // One field cell wide and 10 m deep: narrower than the 16 m belt's window,
  // which is the case a box filter cannot see.
  const options = { cols: 65, rows: 65, cellM, at: (col: number) => (col === 32 ? -10 : 0) };
  const banks = (field: Parameters<typeof cliffThrough>[0]) =>
    breaklinesOf(field, [
      cliffThrough(field, [[31.5, -2], [31.5, 66]]),
      cliffThrough(field, [[32.5, -2], [32.5, 66]]),
    ]);

  const depthOf = (ground: Ground) => {
    const grid = ground.gridFor("far");
    const row = Math.round((0 - grid.minZ) / grid.cell);
    const col = Math.round((0 - grid.minX) / grid.cell); // x = 0 is field column 32
    return -ground.nodeAt("far", row, col);
  };

  test("a plain window fills it in", () => {
    expect(depthOf(syntheticGround(options).ground)).toBeLessThan(4);
  });

  test("banks surveyed on both sides keep the floor at its own depth", () => {
    // Both neighbours are cut off, so the window is left with the ravine's own
    // column — the unfiltered sample on a knife edge that `ground.ts` describes.
    expect(depthOf(syntheticGround({ ...options, breaklines: banks }).ground)).toBeCloseTo(10, 6);
  });

  test("a node fenced on all four sides keeps its raw value", () => {
    const { ground } = syntheticGround({
      ...options,
      at: (col, row) => (col === 32 && row === 32 ? -10 : 0),
      breaklines: (field) =>
        breaklinesOf(field, [
          cliffThrough(field, [[31.5, 31.5], [32.5, 31.5], [32.5, 32.5], [31.5, 32.5], [31.5, 31.5]]),
        ]),
    });
    const grid = ground.gridFor("far");
    const row = Math.round((0 - grid.minZ) / grid.cell);
    const col = Math.round((0 - grid.minX) / grid.cell);
    expect(ground.nodeAt("far", row, col)).toBeCloseTo(-10, 6);
  });
});

describe("ripple", () => {
  // ±1 m of deterministic noise on the 30° slope: what the DTM's own
  // high-frequency content does to a belt coarser than it (I7).
  const cellM = 4;
  const slope = Math.tan((30 * Math.PI) / 180);
  // A hash, not Math.random: the same grid every run, and — unlike a sine
  // hash — no structure of its own for the filter to leave standing.
  const noise = (col: number, row: number) => {
    let h = (col * 374_761_393 + row * 668_265_263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296 - 0.5;
  };
  const at = (col: number, row: number) => col * cellM * slope + 2 * noise(col, row);
  const { field, plane, ground } = syntheticGround({ cols: 65, rows: 65, cellM, at });

  test("averaging the field kinks less than sampling it", () => {
    // Against the same relief read straight off the field at the belt's own
    // step — point sampling, which is the aliasing the filter exists to remove.
    const grid = ground.gridFor("far");
    const sampled = (row: number, col: number) =>
      field.heightAt(plane.lon(grid.minX + col * grid.cell), plane.lat(grid.minZ + row * grid.cell));
    expect(kinkAlongRows(ground, "far")).toBeLessThan(kinkOf(grid, sampled) / 2);
  });

  test("and the mean gradient survives it", () => {
    const rise = ground.at(60, 0, "far") - ground.at(-60, 0, "far");
    expect(rise / 120).toBeCloseTo(slope, 1);
  });
});

describe("water", () => {
  const { ground } = syntheticGround({
    cols: 65,
    rows: 65,
    // The western third is sea. NaN is nodata, and nodata is water.
    at: (col) => (col < 20 ? Number.NaN : 10),
  });

  test("a wet node is NaN rather than the datum", () => {
    const grid = ground.gridFor("city");
    const row = Math.round((0 - grid.minZ) / grid.cell);
    expect(ground.nodeAt("city", row, 0)).toBeNaN();
  });

  test("a query over a cell with a wet corner answers nothing at all", () => {
    const grid = ground.gridFor("city");
    // Field column 20 is the first land: x = minX + 20 · 4.
    const shoreX = grid.minX + 20 * 4;
    expect(ground.at(shoreX - grid.cell / 2, 0, "city")).toBeNaN();
  });

  test("land beside water is not dragged toward it", () => {
    const grid = ground.gridFor("far");
    const row = Math.round((0 - grid.minZ) / grid.cell);
    for (let col = 0; col <= grid.cols; col++) {
      const h = ground.nodeAt("far", row, col);
      if (Number.isNaN(h)) continue;
      expect(h).toBeCloseTo(10, 6);
    }
  });
});

describe("one surface (I1)", () => {
  const cellM = 4;
  // Non-separable on purpose: a surface of f(col) + g(row) has no twist in a
  // cell, and there the two triangles and the bilinear patch are one plane.
  const at = (col: number, row: number) =>
    20 + col * 0.7 + row * 0.35 + Math.sin(col * 0.4 + row * 0.9) * 3;
  const { ground } = syntheticGround({ cols: 65, rows: 65, cellM, at });

  test("a placement query lands on the triangle the mesher drew", () => {
    for (const belt of BELT_ORDER) {
      const drawn = buildSurfaceIndex([[meshOf(ground, belt)]]);
      const grid = ground.gridFor(belt);
      for (let i = 1; i < 40; i++) {
        // Points scattered inside the grid, none of them on a node.
        const x = grid.minX + grid.cell * (((i * 1.37 + 0.21) % (grid.cols - 1)) + 0.5);
        const z = grid.minZ + grid.cell * (((i * 0.83 + 0.61) % (grid.rows - 1)) + 0.5);
        expect(ground.at(x, z, belt)).toBeCloseTo(drawn.at(x, z), 3);
      }
    }
  });

  test("a node answers its own height exactly", () => {
    for (const belt of BELT_ORDER) {
      const grid = ground.gridFor(belt);
      for (const { row, col, x, z } of nodes(ground, belt)) {
        // The last row and column are the grid's own edge: the cell a query
        // there would land in is outside the field, and has no height.
        if (row === grid.rows || col === grid.cols) continue;
        expect(ground.at(x, z, belt)).toBeCloseTo(ground.nodeAt(belt, row, col), 6);
      }
    }
  });

  test("and not about the bilinear surface nobody drew", () => {
    // Teeth for the test above: on a cell with any twist the two differ, so a
    // query that quietly went bilinear would be caught.
    const grid = ground.gridFor("city");
    let worst = 0;
    for (let i = 1; i < 40; i++) {
      const col = 10 + (i % 20);
      const row = 10 + ((i * 3) % 20);
      const x = grid.minX + grid.cell * (col + 0.8);
      const z = grid.minZ + grid.cell * (row + 0.2);
      const h00 = ground.nodeAt("city", row, col);
      const h10 = ground.nodeAt("city", row, col + 1);
      const h01 = ground.nodeAt("city", row + 1, col);
      const h11 = ground.nodeAt("city", row + 1, col + 1);
      const top = h00 + (h10 - h00) * 0.8;
      const bottom = h01 + (h11 - h01) * 0.8;
      worst = Math.max(worst, Math.abs(ground.at(x, z, "city") - (top + (bottom - top) * 0.2)));
    }
    expect(worst).toBeGreaterThan(MM);
  });
});

describe("belt grids", () => {
  const { ground } = syntheticGround({ cols: 65, rows: 65, at: (col, row) => col + row });

  test("share an origin, so a coarse node lands on a fine one", () => {
    const core = ground.gridFor("core");
    for (const belt of BELT_ORDER) {
      const grid = ground.gridFor(belt);
      expect(grid.minX).toBe(core.minX);
      expect(grid.minZ).toBe(core.minZ);
      expect(grid.cell % core.cell).toBe(0);
    }
  });

  test("and a belt's own filter width follows its cell", () => {
    expect(ground.gridFor("core").radius).toBe(0);
    expect(ground.gridFor("city").radius).toBe(1);
    expect(ground.gridFor("far").radius).toBe(2);
  });
});
