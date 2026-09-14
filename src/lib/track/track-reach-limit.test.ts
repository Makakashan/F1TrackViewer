import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { halfWidthAt } from "@/lib/track/track-geometry";
import {
  limitHalfWidth,
  reachLimitAt,
  sampleReachLimit,
} from "@/lib/track/track-reach-limit";

function ring(radius: number): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.CatmullRomCurve3(points, true);
}

describe("sampleReachLimit", () => {
  test("only the inside of a bend is limited, and below its radius", () => {
    const limit = sampleReachLimit(ring(40), 400);
    const inside = Math.min(reachLimitAt(limit, 0.3, 1), reachLimitAt(limit, 0.3, -1));
    const outside = Math.max(reachLimitAt(limit, 0.3, 1), reachLimitAt(limit, 0.3, -1));
    expect(inside).toBeLessThan(40);
    expect(outside).toBe(Infinity);
  });

  test("a ribbon wider than a hairpin is pinched to fit inside it", () => {
    const limit = sampleReachLimit(ring(8), 200);
    const pinched = halfWidthAt(limitHalfWidth(7, limit), 0.5);
    expect(pinched).toBeLessThan(7);
    expect(pinched).toBeLessThan(8);
  });

  test("a wide bend leaves the ribbon alone", () => {
    const limit = sampleReachLimit(ring(300), 1200);
    expect(halfWidthAt(limitHalfWidth(7, limit), 0.5)).toBe(7);
  });
});

