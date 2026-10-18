import { describe, expect, test } from "bun:test";
import { splitTerraces } from "./buildings";

const rect = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

const rangeOf = (shape: { x: number; z: number }[], groundAt: (x: number, z: number) => number): number => {
  const hs = shape.map((p) => groundAt(p.x, p.z));
  return Math.max(...hs) - Math.min(...hs);
};

describe("a footprint split along its fall line", () => {
  const anywhere = () => true;
  test("stays whole on flat ground", () => {
    expect(splitTerraces(rect(0, 0, 20, 12), () => 10, anywhere)).toHaveLength(1);
  });

  test("steps down a slope, each terrace spanning less than the whole", () => {
    const slope = (x: number) => x * 0.5;
    const pieces = splitTerraces(
      rect(0, 0, 20, 12),
      (x) => slope(x),
      anywhere,
    );
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.length).toBeLessThanOrEqual(4);
    for (const piece of pieces) {
      expect(piece.length).toBeGreaterThanOrEqual(3);
      expect(rangeOf(piece, (x) => slope(x))).toBeLessThan(10);
    }
  });

  test("stays whole when narrower than a terrace along the fall", () => {
    expect(splitTerraces(rect(0, 0, 3, 12), (x) => x * 2, anywhere)).toHaveLength(1);
  });

  test("stays whole where the ground is unknown", () => {
    expect(splitTerraces(rect(0, 0, 20, 12), () => Number.NaN, anywhere)).toHaveLength(1);
  });

  test("stays whole where the cut would enter the track corridor", () => {
    const slope = (x: number) => x * 0.5;
    expect(splitTerraces(rect(0, 0, 20, 12), (x) => slope(x), (x) => x > 4)).toHaveLength(1);
  });
});
