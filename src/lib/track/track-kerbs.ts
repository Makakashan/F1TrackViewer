import * as THREE from "three";
import { sampleCurvature } from "@/lib/track/track-curvature";
import { apronRoomAt, type ApronRoom } from "@/lib/track/track-apron";
import type { HalfWidth } from "@/lib/track/track-geometry";
import {
  circularRuns,
  CORNER_ENTER_RADIUS_M,
  CORNER_EXIT_RADIUS_M,
  CORNER_MIN_RUN_M,
  resolveCornerSides,
} from "@/lib/track/track-corners";

/** Kerbs — the red/white striped strips lining the inside of every corner. */

const KERB_RED = new THREE.Color("#cc1120");
const KERB_WHITE = new THREE.Color("#f2f4f7");

export interface KerbOptions {
  /** A sample is "in a corner" when its radius drops below this. */
  maxCornerRadiusMeters?: number;
  /** Lateral width of the strip, measured outward from the track edge. */
  widthMeters?: number;
  /** How much paved verge each sample has. */
  room?: ApronRoom;
  /** Arc length of one red or white block. */
  stripeMeters?: number;
  /** Share of the strip's width to lay on the outside of a corner, where a circuit's exit kerb goes. */
  outerWidthShare?: number;
  /** Corner runs are grown by this much at each end, as real kerbs are. */
  runPaddingMeters?: number;
  /** Distance over which the strip widens from nothing to full at each end. */
  taperMeters?: number;
  /** A run shorter than this is curvature noise, not a corner. */
  minRunMeters?: number;
  /** Radius a corner in progress must open past before it ends. */
  exitRadiusMeters?: number;
  /** Height of the strip's outer lip above its inner edge — kerbs are ramped. */
  liftMeters?: number;
}

const DEFAULTS = {
  maxCornerRadiusMeters: CORNER_ENTER_RADIUS_M,
  widthMeters: 1.9,
  stripeMeters: 1,
  // Real circuits do carry exit kerbs, but not at every corner.
  outerWidthShare: 0,
  runPaddingMeters: 10,
  taperMeters: 14,
  minRunMeters: CORNER_MIN_RUN_M,
  exitRadiusMeters: CORNER_EXIT_RADIUS_M,
  liftMeters: 0.07,
} satisfies Required<Omit<KerbOptions, "room">>;

function halfWidthAt(halfWidth: HalfWidth, s: number): number {
  return typeof halfWidth === "function" ? halfWidth(s) : halfWidth;
}

function wrap01(value: number): number {
  return ((value % 1) + 1) % 1;
}

/** Build the kerb strips for a track. */
export function buildKerbGeometry(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  raise: number,
  samples: number,
  options: KerbOptions = {},
): THREE.BufferGeometry | null {
  const {
    maxCornerRadiusMeters,
    widthMeters,
    stripeMeters,
    runPaddingMeters,
    taperMeters,
    minRunMeters,
    exitRadiusMeters,
    liftMeters,
    outerWidthShare,
    room,
  } = { ...DEFAULTS, ...options };

  const n = samples;
  if (n < 8) return null;

  const totalLength = curve.getLength();
  const ds = totalLength / n;
  if (!(ds > 0)) return null;

  const profile = sampleCurvature(curve, n);
  if (!profile) return null;
  const { tangents, curvature } = profile;

  // side = tangent × up, so the inner edge lies at sign(curvature) * halfWidth.
  const cornerSide = resolveCornerSides(
    curvature,
    1 / maxCornerRadiusMeters,
    1 / exitRadiusMeters,
  );

  const padSamples = Math.round(runPaddingMeters / ds);
  const minRunSamples = Math.max(2, Math.round(minRunMeters / ds));

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();

  const point = new THREE.Vector3();
  const sideVector = new THREE.Vector3();

  // Per quad rather than shared, so each stripe keeps one flat colour.
  function pushVertex(distance: number, offset: number, lift: number) {
    const u = wrap01(distance / totalLength);
    point.copy(curve.getPointAt(u));
    sideVector.crossVectors(curve.getTangentAt(u), up);
    if (sideVector.lengthSq() < 1e-6) sideVector.set(1, 0, 0);
    sideVector.normalize();
    positions.push(
      point.x + sideVector.x * offset,
      point.y + raise + lift,
      point.z + sideVector.z * offset,
    );
    normals.push(0, 1, 0);
    colors.push(color.r, color.g, color.b);
  }

  for (const { start, count, sign: innerSign } of circularRuns(cornerSide)) {
    if (count < minRunSamples) continue;

    // Arc length from here on: one quad per curve sample would clamp the stripe to the sample spacing.
    const runStart =
      Math.floor(((start - padSamples) * ds) / stripeMeters) * stripeMeters;
    const rawEnd = runStart + Math.min(totalLength, (count + padSamples * 2) * ds);
    const runEnd = Math.ceil(rawEnd / stripeMeters) * stripeMeters;

    /** 0 at both ends of the run, 1 once past the taper. */
    const taperAt = (distance: number) =>
      THREE.MathUtils.smoothstep(
        Math.min(distance - runStart, runEnd - distance) / taperMeters,
        0,
        1,
      );

    // Stripe boundaries sit on a global grid rather than at the run's start.
    const firstStripe = Math.floor(runStart / stripeMeters);
    const lastStripe = Math.ceil(runEnd / stripeMeters);

    // A corner is kerbed on both sides, not only at the apex.
    for (const side of [innerSign, -innerSign as 1 | -1]) {
      const inner = side === innerSign;
      const sideWidth = inner ? widthMeters : widthMeters * outerWidthShare;
      if (sideWidth < 0.05) continue;

      for (let stripe = firstStripe; stripe < lastStripe; stripe++) {
        const d0 = Math.max(stripe * stripeMeters, runStart);
        const d1 = Math.min((stripe + 1) * stripeMeters, runEnd);
        if (d1 - d0 < 1e-3) continue;

        const taper0 = taperAt(d0);
        const taper1 = taperAt(d1);
        if (taper0 <= 0 && taper1 <= 0) continue;

        color.copy(stripe % 2 === 0 ? KERB_RED : KERB_WHITE);

        // Bolted to the outside of the road, not carved out of it.
        const s0 = wrap01(d0 / totalLength);
        const s1 = wrap01(d1 / totalLength);
        const edge0 = halfWidthAt(halfWidth, s0) * side;
        const edge1 = halfWidthAt(halfWidth, s1) * side;
        const room0 = room ? apronRoomAt(room, s0, side) : sideWidth;
        const room1 = room ? apronRoomAt(room, s1, side) : sideWidth;
        const reach0 = Math.min(sideWidth, room0) * taper0;
        const reach1 = Math.min(sideWidth, room1) * taper1;
        // Nothing to lay this stretch on: the kerb ends where the paving does.
        if (reach0 < 0.05 && reach1 < 0.05) continue;
        const outer0 = edge0 + reach0 * side;
        const outer1 = edge1 + reach1 * side;

        // Kerbs ramp upward away from the racing line.
        const lift0 = liftMeters * (reach0 / Math.max(sideWidth, 1e-6));
        const lift1 = liftMeters * (reach1 / Math.max(sideWidth, 1e-6));

        // Wound so the strip faces up on either edge.
        if (side > 0) {
          pushVertex(d0, edge0, 0);
          pushVertex(d1, edge1, 0);
          pushVertex(d0, outer0, lift0);
          pushVertex(d0, outer0, lift0);
          pushVertex(d1, edge1, 0);
          pushVertex(d1, outer1, lift1);
        } else {
          pushVertex(d0, edge0, 0);
          pushVertex(d0, outer0, lift0);
          pushVertex(d1, edge1, 0);
          pushVertex(d0, outer0, lift0);
          pushVertex(d1, outer1, lift1);
          pushVertex(d1, edge1, 0);
        }
      }
    }
  }

  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** The continuous white line down both edges of the track. */
export function buildTrackEdgeLineGeometry(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  raise: number,
  samples: number,
  lineWidthMeters = 0.18,
): THREE.BufferGeometry {
  const n = samples;
  const pts = curve.getSpacedPoints(n);
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();

  const positions: number[] = [];
  const normals: number[] = [];

  const sideVectors: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    side.crossVectors(curve.getTangentAt((i % n) / n), up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    sideVectors.push(side.clone().normalize());
  }

  function pushVertex(i: number, offset: number) {
    const p = pts[i];
    const v = sideVectors[i];
    positions.push(p.x + v.x * offset, p.y + raise, p.z + v.z * offset);
    normals.push(0, 1, 0);
  }

  for (const edgeSign of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const j = i + 1;
      const o0 = halfWidthAt(halfWidth, i / n) * edgeSign;
      const o1 = halfWidthAt(halfWidth, j / n) * edgeSign;
      // Pulled just inside the edge, or the line half-hangs off where the ribbon narrows.
      const outer0 = o0 - lineWidthMeters * 0.25 * edgeSign;
      const outer1 = o1 - lineWidthMeters * 0.25 * edgeSign;
      const inner0 = outer0 - lineWidthMeters * edgeSign;
      const inner1 = outer1 - lineWidthMeters * edgeSign;

      if (edgeSign > 0) {
        pushVertex(i, inner0);
        pushVertex(j, inner1);
        pushVertex(i, outer0);
        pushVertex(i, outer0);
        pushVertex(j, inner1);
        pushVertex(j, outer1);
      } else {
        pushVertex(i, inner0);
        pushVertex(i, outer0);
        pushVertex(j, inner1);
        pushVertex(i, outer0);
        pushVertex(j, outer1);
        pushVertex(j, inner1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
