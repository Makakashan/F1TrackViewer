import { describe, expect, test } from "bun:test";
import { DEFAULT_HALF_WIDTH_M } from "@/lib/track/track-geometry";
import { buildRibbon, clipToCell } from "./ribbon";
import type { ScenePlane } from "./plane";

// Metres straight through: lon is x, lat is z.
const plane = { x: (lon: number) => lon, z: (lat: number) => lat, lon: (x: number) => x, lat: (z: number) => z } as ScenePlane;

describe("the ribbon's edges", () => {
  // A circle of 300 m: nothing pinches it, and its edges have a known place.
  const R = 300;
  const coords: [number, number][] = Array.from({ length: 73 }, (_, i) => {
    const a = (2 * Math.PI * i) / 72;
    return [R * Math.cos(a), R * Math.sin(a)];
  });
  const elevations = coords.slice(0, 72).map(() => 10);
  const lap = 2 * Math.PI * R;

  test("stand the viewer's half width either side of the centre", () => {
    const ribbon = buildRibbon(coords, elevations, plane, lap, () => false);
    const radii = ribbon.edges.flat().map((p) => Math.hypot(p.x, p.z));
    expect(radii.length).toBeGreaterThan(100);
    for (const r of radii) {
      expect(Math.min(Math.abs(r - (R - DEFAULT_HALF_WIDTH_M)), Math.abs(r - (R + DEFAULT_HALF_WIDTH_M)))).toBeLessThan(0.1);
    }
  });

  test("break where the ribbon is hidden", () => {
    const whole = buildRibbon(coords, elevations, plane, lap, () => false);
    const cut = buildRibbon(coords, elevations, plane, lap, (x, z) => x > 0 && z > 0);
    expect(whole.edges.length).toBe(2);
    expect(cut.edges.length).toBeGreaterThanOrEqual(2);
    expect(cut.edges.flat().some((p) => p.x > 20 && p.z > 20)).toBe(false);
  });
});

describe("an edge clipped to a cell", () => {
  const at = (x: number, z: number) => ({ x, y: x, z });

  test("keeps the piece inside, on the rim where it crosses, and its height", () => {
    const piece = clipToCell(at(-2, 1), at(6, 1), 0, 0, 4)!;
    expect(piece).toEqual([0, 0, 1, 4, 4, 1]);
  });

  test("gives two cells the same point on the side they share", () => {
    const a = clipToCell(at(0.3, 0.7), at(7.9, 3.1), 0, 0, 4)!;
    const b = clipToCell(at(0.3, 0.7), at(7.9, 3.1), 4, 0, 4)!;
    expect([a[3], a[5]]).toEqual([b[0], b[2]]);
  });

  test("misses a cell it does not reach", () => {
    expect(clipToCell(at(-5, 9), at(-1, 9), 0, 0, 4)).toBeNull();
  });
});
