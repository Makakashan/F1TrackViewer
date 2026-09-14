import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { fullApronRoom } from "@/lib/track/track-apron";
import {
  BARRIER_MIN_CLEARANCE_M,
  buildBarrierGeometry,
} from "@/lib/track/track-barriers";

const RADIUS_M = 200;
const HALF_WIDTH_M = 5;
const SAMPLES = 400;

function ring(): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * RADIUS_M, 0, Math.sin(a) * RADIUS_M));
  }
  return new THREE.CatmullRomCurve3(points, true);
}

/** How far each wall vertex stands from the centreline of the ring, in metres. */
function lateralDistances(geometry: THREE.BufferGeometry): number[] {
  const position = geometry.getAttribute("position");
  const out: number[] = [];
  for (let i = 0; i < position.count; i++) {
    out.push(Math.abs(Math.hypot(position.getX(i), position.getZ(i)) - RADIUS_M));
  }
  return out;
}

describe("buildBarrierGeometry", () => {
  test("the wall stands clear of the road on both sides", () => {
    const result = buildBarrierGeometry(ring(), HALF_WIDTH_M, 1, SAMPLES, null);
    expect(result).not.toBeNull();
    const distances = lateralDistances(result!.wall);
    // The curve is a polygon through the ring, so allow its sag between control points.
    expect(Math.min(...distances)).toBeGreaterThan(HALF_WIDTH_M + BARRIER_MIN_CLEARANCE_M - 0.2);
  });

  test("the wall stands behind the paving, not on the road side of it", () => {
    const room = fullApronRoom(SAMPLES, 4);
    const result = buildBarrierGeometry(ring(), HALF_WIDTH_M, 1, SAMPLES, room);
    const distances = lateralDistances(result!.wall);
    expect(Math.min(...distances)).toBeGreaterThan(HALF_WIDTH_M + 4 - 0.2);
  });

  test("nothing is built where the ribbon is hidden", () => {
    expect(buildBarrierGeometry(ring(), HALF_WIDTH_M, 1, SAMPLES, null, () => true)).toBeNull();
  });
});
