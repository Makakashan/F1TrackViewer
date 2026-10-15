/**
 * The track ribbon as the viewer draws it: the same curve through the same
 * heights, at the same half width. The ground is met to this, not to a width
 * of its own, or the two disagree about where the road stops.
 */

import * as THREE from "three";

import { refineArcLengths } from "@/lib/geo-utils";
import { DEFAULT_HALF_WIDTH_M, halfWidthAt } from "@/lib/track/track-geometry";
import { limitHalfWidth, sampleReachLimit } from "@/lib/track/track-reach-limit";

import type { ScenePlane } from "./plane";

export interface RibbonPoint {
  x: number;
  y: number;
  z: number;
}

export interface Ribbon {
  curve: THREE.CatmullRomCurve3;
  samples: number;
  halfWidthAt(u: number): number;
  /** Both edges, as polylines broken wherever the ribbon is hidden (a tunnel). */
  edges: RibbonPoint[][];
}

export function buildRibbon(
  coords: [number, number][],
  /** One per centreline point, as the manifest ships them. */
  elevations: number[],
  plane: ScenePlane,
  /** The circuit's surveyed length, which the viewer sizes its sampling by. */
  lengthM: number,
  hidden: (x: number, z: number) => boolean,
): Ribbon {
  const points = coords
    .slice(0, elevations.length)
    .map(([lon, lat], i) => new THREE.Vector3(plane.x(lon), elevations[i], plane.z(lat)));
  const curve = new THREE.CatmullRomCurve3(points, true, "centripetal", 0.5);
  refineArcLengths(curve);
  const samples = Math.max(400, Math.min(2000, Math.round(lengthM / 4)));
  const halfWidth = limitHalfWidth(DEFAULT_HALF_WIDTH_M, sampleReachLimit(curve, samples));

  const spaced = curve.getSpacedPoints(samples);
  const edges: RibbonPoint[][] = [];
  let left: RibbonPoint[] = [];
  let right: RibbonPoint[] = [];
  const close = () => {
    if (left.length > 1) edges.push(left, right);
    left = [];
    right = [];
  };
  for (let i = 0; i <= samples; i++) {
    const p = spaced[i];
    if (hidden(p.x, p.z)) {
      close();
      continue;
    }
    const t = curve.getTangentAt(i / samples);
    // (t × up), as the extruder takes its side.
    const length = Math.hypot(t.x, t.z) || 1;
    const sx = -t.z / length;
    const sz = t.x / length;
    const hw = halfWidthAt(halfWidth, i / samples);
    left.push({ x: p.x + sx * hw, y: p.y, z: p.z + sz * hw });
    right.push({ x: p.x - sx * hw, y: p.y, z: p.z - sz * hw });
  }
  close();

  return { curve, samples, halfWidthAt: (u) => halfWidthAt(halfWidth, u), edges };
}

/** A segment of a ribbon edge inside one cell, as [ax, ay, az, bx, by, bz], or null. */
export function clipToCell(
  a: RibbonPoint,
  b: RibbonPoint,
  x0: number,
  z0: number,
  cell: number,
): number[] | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x0 + cell - a.x],
    [-dz, a.z - z0],
    [dz, z0 + cell - a.z],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  if ((t1 - t0) * Math.hypot(dx, dz) < 0.05) return null;
  const at = (t: number) => [a.x + dx * t, a.y + (b.y - a.y) * t, a.z + dz * t];
  // Snapped onto the rim it crosses, so both cells compute the same point.
  const snap = (v: number[]) => {
    for (const edge of [x0, x0 + cell]) if (Math.abs(v[0] - edge) < 1e-6) v[0] = edge;
    for (const edge of [z0, z0 + cell]) if (Math.abs(v[2] - edge) < 1e-6) v[2] = edge;
    return v;
  };
  return [...snap(at(t0)), ...snap(at(t1))];
}
