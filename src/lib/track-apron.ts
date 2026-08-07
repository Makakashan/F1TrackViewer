import * as THREE from "three";
import { sampleCurvature } from "./track-curvature";
import type { HalfWidth } from "./track-geometry";

/**
 * The apron — the paved strip just outside the white line.
 *
 * Kerbs used to be cut out of the ribbon itself, which is why a circuit with
 * kerbs read as a narrower circuit: two and a bit meters of racing surface
 * disappeared into stripes at every corner. A real kerb is not part of the
 * road, it is bolted to the edge of it, and beyond it there is more tarmac
 * before the run-off begins.
 *
 * So the strip is generated rather than carved. The catch is that this app does
 * not know where the run-off actually is — it only has terrain and building
 * footprints — so the apron is laid only where there is room for it: no
 * building standing on it, and no hillside where flat asphalt would either
 * bury itself or hang in the air. Everywhere else it fades out, and the kerb
 * fades with it.
 */

/** How far the paving reaches past the white line where nothing is in the way. */
export const APRON_WIDTH_M = 4;

/**
 * How far the ground may sit from the track surface before the apron gives up.
 *
 * Generous on purpose: a circuit is graded, so its verges are within a meter or
 * so of the road for most of a lap, and the cases worth catching are cuttings
 * and embankments, which are several meters out.
 */
export const APRON_GROUND_TOLERANCE_M = 1.6;

/** Distance over which a blocked stretch fades back to full width. */
const ROOM_SMOOTH_M = 12;

/**
 * How much of the room left inside a corner the apron may take.
 *
 * Inside a corner the strip is offset toward the centre of the turn, so its
 * width is capped by how far that centre is: at a 10 m hairpin the inner edge
 * of the road already sits on a 2.5 m radius, and a 4 m strip laid on it passes
 * through the middle and folds through itself. Kept under one so the innermost
 * ring never collapses to a point.
 */
const CORNER_ROOM_SHARE = 0.7;

export interface ApronRoom {
  /** Full width, in meters, that the fractions below are measured against. */
  widthMeters: number;
  /** Per-sample fraction of `widthMeters` available on the +side. */
  plus: Float32Array;
  /** Per-sample fraction of `widthMeters` available on the -side. */
  minus: Float32Array;
}

/**
 * Whether the apron may be paved at a point.
 *
 * `point` is where the outer lip would land and `centre` is the centreline
 * beside it — both are needed because the honest terrain test compares ground
 * against ground. The rendered track surface is not the ground: it is the
 * terrain maximum over a neighbourhood, smoothed along the lap and lifted clear
 * of it, so measuring the verge against the road rejects every sample on a
 * circuit with any relief at all.
 *
 * Returning false takes that sample out, and the smoothing turns the gap into a
 * taper rather than a step.
 */
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

/**
 * Walk both edges and ask `clearance` whether the strip fits, then blur the
 * answer along the lap.
 *
 * The blur is what makes this usable: the raw test flickers wherever a footprint
 * clips a corner of the strip, and a strip that switches on and off every few
 * meters reads worse than no strip at all.
 */
export function sampleApronRoom(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  samples: number,
  clearance: ApronClearance | null,
  widthMeters = APRON_WIDTH_M,
): ApronRoom {
  const room = fullApronRoom(samples, widthMeters);
  const total = curve.getLength();
  if (!(total > 0) || samples < 2) return room;

  // The geometric limit comes first and applies whether or not anything is
  // standing in the way: it is a fact about the curve, not about the scenery.
  const profile = sampleCurvature(curve, samples);

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

    // Positive curvature turns toward -side, so the inside of the corner is
    // the side whose sign matches it.
    const curvature = profile ? profile.curvature[i] : 0;
    const radius = 1 / Math.max(Math.abs(curvature), 1e-9);
    const insideSign = Math.sign(curvature);
    const insideLimit = Math.max(0, (radius - edge) * CORNER_ROOM_SHARE);

    for (const sign of [1, -1] as const) {
      const target = sign > 0 ? room.plus : room.minus;
      const limit =
        sign === insideSign ? Math.min(widthMeters, insideLimit) : widthMeters;
      if (limit <= 0.05) {
        target[i] = 0;
        continue;
      }
      // Probed at the outer lip: if the far edge fits, everything between it
      // and the white line does too.
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

/**
 * The apron itself: one quad per sample per side, from the white line out to
 * whatever room the sample has.
 *
 * Flat, and at the surface height rather than sloping away — this is the paved
 * verge, not the run-off, and the run-off is somebody else's geometry.
 */
export function buildTrackApronGeometry(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  raise: number,
  samples: number,
  room: ApronRoom,
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

/**
 * "Is this point inside a building?", asked a few thousand times.
 *
 * A uniform grid over footprint bounding boxes: the apron probes every sample
 * on both sides, and testing each of those against four hundred polygons is
 * long enough to be felt when the environment is switched on.
 */
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
