import * as THREE from "three";
import type { HalfWidth } from "@/lib/track/track-geometry";

/** Starting grid markings — the staggered boxes behind the start/finish line. */

const GRID_SLOTS = 20;
/** Longitudinal gap between consecutive (staggered) boxes. Same-side rows end up 16 m apart. */
const SLOT_PITCH_M = 8;
/** Gap between the start line and the front of the pole box. */
const FIRST_SLOT_SETBACK_M = 6;
const BOX_LENGTH_M = 5;
const BOX_WIDTH_M = 2.4;
/** Painted line thickness. */
const LINE_M = 0.14;
/** Box center offset from the centerline, as a fraction of the half-width. */
const LATERAL_FRACTION = 0.45;

function wrap01(value: number): number {
  return ((value % 1) + 1) % 1;
}

function halfWidthAt(halfWidth: HalfWidth, s: number): number {
  return typeof halfWidth === "function" ? halfWidth(s) : halfWidth;
}

/** How far behind the start line a grid box sits. */
export function gridSetbackMeters(place: number): number {
  return FIRST_SLOT_SETBACK_M + (place - 1) * SLOT_PITCH_M;
}

export interface GridSlot {
  /** Center of the painted box, on the track surface. */
  position: THREE.Vector3;
  /** Unit vector along the direction of travel. */
  forward: THREE.Vector3;
  /** Unit vector across the track, to the left of `forward`. */
  across: THREE.Vector3;
  /** Normalized curve position of the box center. */
  s: number;
  /** Which side of the centerline the box sits on, along `across`. */
  side: 1 | -1;
  /** Signed distance from the centerline along `across`, in meters. */
  lateralOffset: number;
  /** 1 for pole, 2 for second, and so on. */
  place: number;
}

/** Where each car stands on the grid — shared by the painted boxes and by whatever is placed in them. */
export function startGridSlots(
  curve: THREE.CatmullRomCurve3,
  startFinishS: number,
  halfWidth: HalfWidth,
  directionSign: 1 | -1 = 1,
  slots: number = GRID_SLOTS,
): GridSlot[] {
  const totalLength = curve.getLength();
  if (!(totalLength > 0)) return [];

  const up = new THREE.Vector3(0, 1, 0);
  const result: GridSlot[] = [];

  for (let slot = 0; slot < slots; slot++) {
    const distanceBehind = FIRST_SLOT_SETBACK_M + slot * SLOT_PITCH_M;
    // Behind the line means against the direction of travel.
    const s = wrap01(
      startFinishS - (directionSign * distanceBehind) / totalLength,
    );

    const center = curve.getPointAt(s);
    const forward = curve
      .getTangentAt(s)
      .normalize()
      .multiplyScalar(directionSign);
    const across = new THREE.Vector3().crossVectors(forward, up);
    if (across.lengthSq() < 1e-6) across.set(1, 0, 0);
    across.normalize();

    const sideSign: 1 | -1 = slot % 2 === 0 ? 1 : -1;
    const localHalfWidth = halfWidthAt(halfWidth, s);
    const lateralOffset = sideSign * localHalfWidth * LATERAL_FRACTION;
    result.push({
      position: center.clone().addScaledVector(across, lateralOffset),
      forward,
      across,
      s,
      side: sideSign,
      lateralOffset,
      place: slot + 1,
    });
  }

  return result;
}

/** The grid boxes as flat white quads. */
export function buildStartGridGeometry(
  curve: THREE.CatmullRomCurve3,
  startFinishS: number,
  halfWidth: HalfWidth,
  topRaise: number,
  directionSign: 1 | -1 = 1,
): THREE.BufferGeometry | null {
  const totalLength = curve.getLength();
  if (!(totalLength > 0)) return null;

  // Grid needs ~170 m of track behind the line.
  const gridLength = FIRST_SLOT_SETBACK_M + GRID_SLOTS * SLOT_PITCH_M;
  if (totalLength < gridLength * 1.5) return null;

  const positions: number[] = [];
  const indices: number[] = [];
  const point = new THREE.Vector3();

  /** One painted rectangle in the local frame of the box center. */
  function pushRect(
    center: THREE.Vector3,
    forward: THREE.Vector3,
    sideVec: THREE.Vector3,
    y: number,
    alongCenter: number,
    lateralCenter: number,
    alongSize: number,
    lateralSize: number,
  ) {
    const base = positions.length / 3;
    const halfAlong = alongSize / 2;
    const halfLateral = lateralSize / 2;

    for (const [da, dl] of [
      [-halfAlong, -halfLateral],
      [halfAlong, -halfLateral],
      [-halfAlong, halfLateral],
      [halfAlong, halfLateral],
    ]) {
      point
        .copy(center)
        .addScaledVector(forward, alongCenter + da)
        .addScaledVector(sideVec, lateralCenter + dl);
      positions.push(point.x, y, point.z);
    }

    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  for (const { position, forward, across } of startGridSlots(
    curve,
    startFinishS,
    halfWidth,
    directionSign,
  )) {
    // Paint sits on the asphalt: a physical lift reads as levitating markings from inside the car.
    const y = position.y + topRaise;

    // Front transverse line plus two longitudinal sides — an open-backed box.
    pushRect(position, forward, across, y, BOX_LENGTH_M / 2, 0, LINE_M, BOX_WIDTH_M);
    for (const edge of [-1, 1]) {
      pushRect(
        position,
        forward,
        across,
        y,
        0,
        (edge * BOX_WIDTH_M) / 2,
        BOX_LENGTH_M,
        LINE_M,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
