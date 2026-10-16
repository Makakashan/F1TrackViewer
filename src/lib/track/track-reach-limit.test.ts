import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { halfWidthAt } from "@/lib/track/track-geometry";
import {
  limitHalfWidth,
  reachLimitAt,
  sampleLegGaps,
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

/** Two straights 13 m apart, joined by tight ends: a hairpin stretched out. */
function stadium(): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  for (let x = -200; x <= 200; x += 10) points.push(new THREE.Vector3(x, 0, 0));
  for (let a = -Math.PI / 2 + 0.3; a < Math.PI / 2; a += 0.3)
    points.push(new THREE.Vector3(200 + Math.cos(a) * 6.5, 0, 6.5 + Math.sin(a) * 6.5));
  for (let x = 200; x >= -200; x -= 10) points.push(new THREE.Vector3(x, 0, 13));
  for (let a = Math.PI / 2 + 0.3; a < (3 * Math.PI) / 2; a += 0.3)
    points.push(new THREE.Vector3(-200 + Math.cos(a) * 6.5, 0, 6.5 + Math.sin(a) * 6.5));
  return new THREE.CatmullRomCurve3(points, true);
}

function sampleNearest(curve: THREE.CatmullRomCurve3, samples: number, x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples; i++) {
    const p = curve.getPointAt(i / samples);
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

describe("sampleLegGaps", () => {
  test("a leg running alongside is found on the side it is on", () => {
    const curve = stadium();
    const samples = Math.round(curve.getLength() / 2);
    const gaps = sampleLegGaps(curve, samples);
    const i = sampleNearest(curve, samples, 0, 0);
    const near = Math.min(gaps.plus[i], gaps.minus[i]);
    expect(near).toBeGreaterThan(12);
    expect(near).toBeLessThan(14);
    expect(Math.max(gaps.plus[i], gaps.minus[i])).toBe(Infinity);
  });

  test("a crossing on a bridge is not a neighbour", () => {
    const points: THREE.Vector3[] = [];
    for (let k = 0; k < 96; k++) {
      const t = (k / 96) * Math.PI * 2;
      points.push(new THREE.Vector3(300 * Math.sin(t), 0, 150 * Math.sin(t) * Math.cos(t)));
    }
    const curve = new THREE.CatmullRomCurve3(points, true);
    const samples = Math.round(curve.getLength() / 2);
    const gaps = sampleLegGaps(curve, samples);
    const i = sampleNearest(curve, samples, 0, 0);
    expect(gaps.plus[i]).toBe(Infinity);
    expect(gaps.minus[i]).toBe(Infinity);
  });
});
