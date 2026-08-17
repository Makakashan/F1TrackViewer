import * as THREE from "three";
import { sampleCurvature } from "@/lib/track/track-curvature";
import { sampleCornerCoverage } from "@/lib/track/track-corners";
import type { HalfWidth } from "@/lib/track/track-geometry";

/** The apron — the paved strip just outside the white line, which the kerb is bolted to. */

/** How far the paving reaches past the white line through a corner. */
export const APRON_WIDTH_M = 4;

/** And down a straight, where a circuit has a verge rather than run-off. */
export const APRON_STRAIGHT_WIDTH_M = 1;

// Generous next to the kerb's own 10 m / 14 m.
const CORNER_PADDING_M = 26;
const CORNER_TAPER_M = 30;

/** How far the ground may sit from the track surface before the apron gives up. */
export const APRON_GROUND_TOLERANCE_M = 1.6;

/** Distance over which a blocked stretch fades back to full width. */
const ROOM_SMOOTH_M = 12;

/** How much of the room left inside a corner the apron may take. */
const CORNER_ROOM_SHARE = 0.7;

export interface ApronRoom {
  /** Full width, in meters, that the fractions below are measured against. */
  widthMeters: number;
  /** Per-sample fraction of `widthMeters` available on the +side. */
  plus: Float32Array;
  /** Per-sample fraction of `widthMeters` available on the -side. */
  minus: Float32Array;
}

/** Whether the apron may be paved at a point. */
export type ApronClearance = (
  point: THREE.Vector3,
  centre: THREE.Vector3,
) => boolean;

function halfWidthAt(halfWidth: HalfWidth, s: number): number {
  return typeof halfWidth === "function" ? halfWidth(s) : halfWidth;
}

/** Room everywhere, for circuits with no environment data to say otherwise. */
export function fullApronRoom(
  samples: number,
  widthMeters = APRON_WIDTH_M,
): ApronRoom {
  const plus = new Float32Array(samples).fill(1);
  const minus = new Float32Array(samples).fill(1);
  return { widthMeters, plus, minus };
}

/** Walk both edges and ask `clearance` whether the strip fits, then blur the answer along the lap. */
export function sampleApronRoom(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  samples: number,
  clearance: ApronClearance | null,
  widthMeters = APRON_WIDTH_M,
  straightWidthMeters = APRON_STRAIGHT_WIDTH_M,
): ApronRoom {
  const room = fullApronRoom(samples, widthMeters);
  const total = curve.getLength();
  if (!(total > 0) || samples < 2) return room;

  const profile = sampleCurvature(curve, samples);
  const coverage = profile
    ? sampleCornerCoverage(profile.curvature, profile.ds, {
        paddingMeters: CORNER_PADDING_M,
        taperMeters: CORNER_TAPER_M,
      })
    : null;

  const up = new THREE.Vector3(0, 1, 0);
  const point = new THREE.Vector3();
  const side = new THREE.Vector3();
  const probe = new THREE.Vector3();

  for (let i = 0; i < samples; i++) {
    const s = i / samples;
    point.copy(curve.getPointAt(s));
    side.crossVectors(curve.getTangentAt(s), up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const edge = halfWidthAt(halfWidth, s);

    // Positive curvature turns toward -side, which is the inside of the corner.
    const curvature = profile ? profile.curvature[i] : 0;
    const radius = 1 / Math.max(Math.abs(curvature), 1e-9);
    const insideSign = Math.sign(curvature);
    const insideLimit = Math.max(0, (radius - edge) * CORNER_ROOM_SHARE);

    const cornerness = coverage ? coverage[i] : 1;
    const paved =
      straightWidthMeters + (widthMeters - straightWidthMeters) * cornerness;

    for (const sign of [1, -1] as const) {
      const target = sign > 0 ? room.plus : room.minus;
      const limit =
        sign === insideSign ? Math.min(paved, insideLimit) : paved;
      if (limit <= 0.05) {
        target[i] = 0;
        continue;
      }
      // If the far edge fits, everything inside it does too.
      probe.copy(point).addScaledVector(side, sign * (edge + limit));
      const open = !clearance || clearance(probe, point);
      target[i] = open ? limit / widthMeters : 0;
    }
  }

  const spanSamples = Math.max(1, Math.round((ROOM_SMOOTH_M / total) * samples));
  return {
    widthMeters,
    plus: smoothCircular(room.plus, spanSamples),
    minus: smoothCircular(room.minus, spanSamples),
  };
}

/** Box blur over a closed loop — the lap has no ends to special-case. */
function smoothCircular(values: Float32Array, span: number): Float32Array {
  const n = values.length;
  if (span < 1 || n === 0) return values;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -span; k <= span; k++) sum += values[(i + k + n * 2) % n];
    out[i] = sum / (span * 2 + 1);
  }
  return out;
}

/** How much apron is available at a distance along the lap, on one side. */
export function apronRoomAt(
  room: ApronRoom,
  s: number,
  sign: number,
): number {
  const values = sign > 0 ? room.plus : room.minus;
  const n = values.length;
  if (n === 0) return 0;
  const x = (((s % 1) + 1) % 1) * n;
  const i = Math.floor(x);
  const t = x - i;
  const a = values[i % n];
  const b = values[(i + 1) % n];
  return (a + (b - a) * t) * room.widthMeters;
}

/** One quad per sample per side, from the white line out to whatever room the sample has. */
export function buildTrackApronGeometry(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  raise: number,
  samples: number,
  room: ApronRoom,
  /** Stretches the ribbon is not drawn on; see `buildExtrudedTrack`. */
  hiddenAt?: (s: number) => boolean,
): THREE.BufferGeometry | null {
  const n = samples;
  if (n < 8) return null;

  const up = new THREE.Vector3(0, 1, 0);
  const point = new THREE.Vector3();
  const side = new THREE.Vector3();

  const positions: number[] = [];
  const normals: number[] = [];

  const points: THREE.Vector3[] = [];
  const sides: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (i % n) / n;
    points.push(curve.getPointAt(s).clone());
    side.crossVectors(curve.getTangentAt(s), up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    sides.push(side.clone().normalize());
  }

  function push(i: number, offset: number) {
    const p = points[i];
    const v = sides[i];
    positions.push(p.x + v.x * offset, p.y + raise, p.z + v.z * offset);
    normals.push(0, 1, 0);
  }

  let any = false;
  for (const sign of [1, -1] as const) {
    for (let i = 0; i < n; i++) {
      if (hiddenAt?.((i + 0.5) / n)) continue;
      const j = i + 1;
      const s0 = i / n;
      const s1 = (j % n) / n;
      const width0 = apronRoomAt(room, s0, sign);
      const width1 = apronRoomAt(room, s1, sign);
      if (width0 < 0.05 && width1 < 0.05) continue;
      any = true;

      const inner0 = halfWidthAt(halfWidth, s0) * sign;
      const inner1 = halfWidthAt(halfWidth, s1) * sign;
      const outer0 = inner0 + width0 * sign;
      const outer1 = inner1 + width1 * sign;

      // Wound so both sides face up.
      if (sign > 0) {
        push(i, inner0);
        push(j, inner1);
        push(i, outer0);
        push(i, outer0);
        push(j, inner1);
        push(j, outer1);
      } else {
        push(i, inner0);
        push(i, outer0);
        push(j, inner1);
        push(i, outer0);
        push(j, outer1);
        push(j, inner1);
      }
    }
  }

  if (!any) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** "Is this point inside a building?", asked a few thousand times. */
export function buildFootprintIndex(
  footprints: [number, number][][],
): (x: number, z: number) => boolean {
  if (footprints.length === 0) return () => false;

  const CELL = 40;
  const grid = new Map<string, number[]>();
  const boxes: Array<[number, number, number, number]> = [];
  const key = (cx: number, cz: number) => `${cx}:${cz}`;

  footprints.forEach((ring, id) => {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    boxes.push([minX, minZ, maxX, maxZ]);
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const bucket = grid.get(key(cx, cz));
        if (bucket) bucket.push(id);
        else grid.set(key(cx, cz), [id]);
      }
    }
  });

  return (x: number, z: number) => {
    const bucket = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!bucket) return false;
    for (const id of bucket) {
      const [minX, minZ, maxX, maxZ] = boxes[id];
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      if (pointInRing(x, z, footprints[id])) return true;
    }
    return false;
  };
}

function pointInRing(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
