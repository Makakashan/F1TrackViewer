import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { fullApronRoom, apronRoomAt } from "@/lib/track/track-apron";
import { BARRIER_SETBACK_M } from "@/lib/track/track-barriers";
import { halfWidthAt } from "@/lib/track/track-geometry";
import {
  OVERRIDE_TAPER_M,
  overrideAt,
  withCentrelineOverrides,
  withBarrierOverrides,
  withWidthOverrides,
  type TrackOverrides,
} from "@/lib/track/track-overrides";

const LAP_M = 1000;

function overrides(points: TrackOverrides["points"]): TrackOverrides {
  return { version: 1, circuitId: "xx-0000", points };
}

describe("overrideAt", () => {
  const edits = overrides([{ id: "p1", s: 0.5, lengthM: 40, widthM: 9 }]);

  test("holds in full over the stretch, fades across the taper, and lets go past it", () => {
    expect(overrideAt(edits, "widthM", 0.5 + 15 / LAP_M, LAP_M)?.weight).toBe(1);
    const halfway = overrideAt(edits, "widthM", 0.5 + (20 + OVERRIDE_TAPER_M / 2) / LAP_M, LAP_M);
    expect(halfway?.weight).toBeCloseTo(0.5, 5);
    expect(overrideAt(edits, "widthM", 0.5 + (20 + OVERRIDE_TAPER_M + 1) / LAP_M, LAP_M)).toBeNull();
  });

  test("a point near the start holds across the line", () => {
    const atStart = overrides([{ id: "p1", s: 0.005, lengthM: 40, kerbPlusM: 0 }]);
    expect(overrideAt(atStart, "kerbPlusM", 0.995, LAP_M)?.weight).toBe(1);
  });

  test("a key a point does not set is left to the automatic value", () => {
    expect(overrideAt(edits, "barrierPlusM", 0.5, LAP_M)).toBeNull();
  });
});

describe("applying overrides", () => {
  test("the road takes half the edited width inside the stretch", () => {
    const halfWidth = withWidthOverrides(7, overrides([{ id: "p1", s: 0.5, lengthM: 40, widthM: 9 }]), LAP_M);
    expect(halfWidthAt(halfWidth, 0.5)).toBe(4.5);
    expect(halfWidthAt(halfWidth, 0.1)).toBe(7);
  });

  test("the paving reaches to where the barrier was put, less the barrier's setback", () => {
    const room = withBarrierOverrides(
      fullApronRoom(100, 4),
      overrides([{ id: "p1", s: 0.5, lengthM: 40, barrierMinusM: 12 }]),
      LAP_M,
      7,
      null,
    );
    expect(apronRoomAt(room, 0.5, -1)).toBeCloseTo(12 - BARRIER_SETBACK_M, 4);
    expect(apronRoomAt(room, 0.5, 1)).toBe(4);
  });
});

/** A ring with the survey's wobble on it: every other point pushed in and out. */
function wobblyRing(radius: number): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    const r = radius + (i % 2 === 0 ? 1.5 : -1.5);
    points.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  return new THREE.CatmullRomCurve3(points, true, "centripetal", 0.5);
}

describe("withCentrelineOverrides", () => {
  /** How far the line strays from the ring it should be, averaged over a stretch. */
  function wobble(curve: THREE.CatmullRomCurve3, radius: number, from: number, to: number): number {
    let sum = 0;
    let count = 0;
    for (let s = from; s < to; s += 0.002) {
      const p = curve.getPointAt(s);
      sum += Math.abs(Math.hypot(p.x, p.z) - radius);
      count++;
    }
    return sum / count;
  }

  test("the wobble goes where the editor asked", () => {
    const curve = wobblyRing(200);
    const smoothed = withCentrelineOverrides(
      curve,
      overrides([{ id: "p1", s: 0.25, lengthM: 200, smoothM: 40 }]),
    );
    expect(wobble(smoothed, 200, 0.24, 0.26)).toBeLessThan(wobble(curve, 200, 0.24, 0.26) * 0.7);
  });

  test("outside the stretch the line keeps the very points it was given", () => {
    const curve = wobblyRing(200);
    const smoothed = withCentrelineOverrides(
      curve,
      overrides([{ id: "p1", s: 0.25, lengthM: 200, smoothM: 40 }]),
    );
    const lap = curve.getLength();
    let compared = 0;
    for (let i = 0; i < curve.points.length; i++) {
      const apart = Math.abs(i / curve.points.length - 0.25);
      // Past the stretch and its taper, nothing may have moved at all.
      if (Math.min(apart, 1 - apart) * lap < 100 + OVERRIDE_TAPER_M) continue;
      expect(smoothed.points[i].distanceTo(curve.points[i])).toBe(0);
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
  });

  test("a circuit with no smoothing keeps the very curve it was given", () => {
    const curve = wobblyRing(200);
    expect(withCentrelineOverrides(curve, overrides([{ id: "p1", s: 0.5, lengthM: 40, widthM: 9 }]))).toBe(curve);
  });
});
