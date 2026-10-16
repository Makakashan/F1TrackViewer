import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildKerbGeometry } from "@/lib/track/track-kerbs";
import { kerbOverrides, type TrackOverrides } from "@/lib/track/track-overrides";

function ring(radius: number): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.CatmullRomCurve3(points, true);
}

function edits(points: TrackOverrides["points"]): TrackOverrides {
  return { version: 1, circuitId: "xx-0000", points };
}

describe("buildKerbGeometry with editor widths", () => {
  test("a bend too wide to be a corner gets no kerb, until the editor puts one there", () => {
    const curve = ring(400);
    const lap = curve.getLength();
    expect(buildKerbGeometry(curve, 5, 0, 800)).toBeNull();
    const override = kerbOverrides(edits([{ id: "p1", s: 0.5, lengthM: 40, kerbPlusM: 1.5 }]), lap);
    expect(buildKerbGeometry(curve, 5, 0, 800, { override })).not.toBeNull();
  });

  test("a width of 0 takes a corner's kerb away", () => {
    const curve = ring(60);
    const lap = curve.getLength();
    expect(buildKerbGeometry(curve, 5, 0, 400)).not.toBeNull();
    const override = kerbOverrides(
      edits([{ id: "p1", s: 0, lengthM: lap * 2, kerbPlusM: 0, kerbMinusM: 0 }]),
      lap,
    );
    expect(buildKerbGeometry(curve, 5, 0, 400, { override })).toBeNull();
  });
});
