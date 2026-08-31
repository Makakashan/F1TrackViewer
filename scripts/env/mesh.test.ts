/**
 * The grid surface, and the one thing it decides: how many normals a corner is
 * allowed to have.
 */

import { describe, expect, test } from "bun:test";
import { GridMesh } from "./mesh";

/** A square of `size` cells, with the height at each node from `heightAt`. */
function sheet(size: number, heightAt: (col: number, row: number) => number): GridMesh {
  const grid = new GridMesh();
  const key = (col: number, row: number) => row * (size + 1) + col;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const corners = [
        [col, row], [col + 1, row], [col + 1, row + 1], [col, row + 1],
      ].map(([c, r]) => grid.vertex(key(c, r), c * 10, heightAt(c, r), r * 10));
      grid.triangle(corners[0], corners[3], corners[2]);
      grid.triangle(corners[0], corners[2], corners[1]);
    }
  }
  return grid;
}

const normalAt = (mesh: { normals: number[] }, vertex: number) =>
  [mesh.normals[vertex * 3], mesh.normals[vertex * 3 + 1], mesh.normals[vertex * 3 + 2]];

describe("a flat sheet", () => {
  test("keeps one vertex per node, whatever the crease angle", () => {
    const plain = sheet(4, () => 5).finish();
    const creased = sheet(4, () => 5).finish(25);
    expect(creased.positions.length).toBe(plain.positions.length);
    expect(creased.indices).toEqual(plain.indices);
    for (let v = 0; v < creased.positions.length / 3; v++) {
      expect(normalAt(creased, v)).toEqual([0, 1, 0]);
    }
  });
});

describe("a fold", () => {
  // Flat for two cells, then a wall: the fold is 90°, which no crease angle
  // worth having lets through.
  const heightAt = (col: number) => (col <= 2 ? 0 : (col - 2) * 40);

  test("without a crease angle the corner averages across it", () => {
    const mesh = sheet(4, heightAt).finish();
    const onFold: number[][] = [];
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      if (Math.abs(mesh.positions[v * 3] - 20) < 1e-6) onFold.push(normalAt(mesh, v));
    }
    expect(onFold.length).toBeGreaterThan(0);
    // Tilted: the flat half and the steep half were summed into one answer.
    for (const [, up] of onFold.map((n) => [n[0], n[1]])) expect(up).toBeLessThan(0.95);
  });

  test("with one, the flat side stays flat and the wall keeps its own normal", () => {
    const mesh = sheet(4, heightAt).finish(25);
    let flat = 0;
    let steep = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      if (Math.abs(mesh.positions[v * 3] - 20) > 1e-6) continue;
      const [, up] = normalAt(mesh, v);
      if (up > 0.999) flat++;
      else if (up < 0.8) steep++;
    }
    expect(flat).toBeGreaterThan(0);
    expect(steep).toBeGreaterThan(0);
  });

  test("and nothing moves: same triangles, same positions", () => {
    const plain = sheet(4, heightAt).finish();
    const creased = sheet(4, heightAt).finish(25);
    expect(creased.indices.length).toBe(plain.indices.length);
    expect(creased.positions.length).toBeGreaterThan(plain.positions.length);
    // Every added vertex is a copy of one that was already there.
    const there = new Set<string>();
    for (let v = 0; v < plain.positions.length / 3; v++) {
      there.add(plain.positions.slice(v * 3, v * 3 + 3).join(","));
    }
    for (let v = 0; v < creased.positions.length / 3; v++) {
      expect(there.has(creased.positions.slice(v * 3, v * 3 + 3).join(","))).toBe(true);
    }
  });
});
