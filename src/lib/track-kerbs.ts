import * as THREE from "three";
import type { HalfWidth } from "./track-geometry";

/**
 * Kerbs — the red/white striped strips lining the inside of every corner.
 *
 * Circuit GeoJSON carries no kerb data, so they are derived from the geometry
 * itself: sample the centerline curvature, call anything tighter than
 * `maxCornerRadiusMeters` a corner, and lay a strip along the inner edge of
 * each corner run. That reproduces the real layout closely enough at circuit
 * scale, and works for all 31 circuits without a per-track table.
 */

/** FIA kerb red and white, muted slightly so they don't bloom under emissive lighting. */
const KERB_RED = new THREE.Color("#d8302a");
const KERB_WHITE = new THREE.Color("#eceff3");

export interface KerbOptions {
  /** A sample is "in a corner" when its radius drops below this. */
  maxCornerRadiusMeters?: number;
  /** Lateral width of the strip, measured outward from the track edge. */
  widthMeters?: number;
  /** Arc length of one red or white block. */
  stripeMeters?: number;
  /** Corner runs are grown by this much at each end, as real kerbs are. */
  runPaddingMeters?: number;
  /** A run shorter than this is curvature noise, not a corner. */
  minRunMeters?: number;
  /** Height of the strip's outer lip above its inner edge — kerbs are ramped. */
  liftMeters?: number;
}

const DEFAULTS = {
  maxCornerRadiusMeters: 260,
  widthMeters: 1.6,
  stripeMeters: 1.8,
  runPaddingMeters: 10,
  minRunMeters: 18,
  liftMeters: 0.09,
} satisfies Required<KerbOptions>;

function halfWidthAt(halfWidth: HalfWidth, s: number): number {
  return typeof halfWidth === "function" ? halfWidth(s) : halfWidth;
}

/**
 * Contiguous index ranges where `flags` is true, as [start, count] pairs over a
 * circular array. A run that straddles index 0 is returned as one range whose
 * start is near the end of the array — callers must read indices modulo n.
 */
function circularRuns(flags: boolean[]): Array<[number, number]> {
  const n = flags.length;
  if (n === 0) return [];
  if (flags.every(Boolean)) return [[0, n]];
  if (!flags.some(Boolean)) return [];

  // Start scanning from a false element so no run is split across the wrap.
  const origin = flags.indexOf(false);
  const runs: Array<[number, number]> = [];
  let start = -1;

  for (let step = 0; step <= n; step++) {
    const i = (origin + step) % n;
    const on = step < n && flags[i];
    if (on && start < 0) {
      start = i;
    } else if (!on && start >= 0) {
      const count = (i - start + n) % n;
      runs.push([start, count]);
      start = -1;
    }
  }

  return runs;
}

/**
 * Build the kerb strips for a track. Returns null when the circuit has no
 * corner tight enough to qualify, so callers can skip the mesh entirely.
 *
 * `raise` is the Y offset above the centerline, matching the track surface.
 */
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
    minRunMeters,
    liftMeters,
  } = { ...DEFAULTS, ...options };

  const n = samples;
  if (n < 8) return null;

  const pts = curve.getSpacedPoints(n);
  const totalLength = curve.getLength();
  const ds = totalLength / n;
  if (!(ds > 0)) return null;

  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) tangents.push(curve.getTangentAt(i / n));

  // Signed curvature in the XZ plane. Positive and negative distinguish left
  // from right turns; the sign picks which edge the kerb belongs to.
  const rawCurvature = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = tangents[(i - 1 + n) % n];
    const b = tangents[(i + 1) % n];
    const cross = a.x * b.z - a.z * b.x;
    const dot = a.x * b.x + a.z * b.z;
    rawCurvature[i] = Math.atan2(cross, dot) / (2 * ds);
  }

  // A single noisy sample must not spawn a two-meter kerb fragment.
  const smoothRadius = Math.max(1, Math.round(6 / ds));
  const curvature = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let o = -smoothRadius; o <= smoothRadius; o++) {
      sum += rawCurvature[(i + o + n) % n];
    }
    curvature[i] = sum / (2 * smoothRadius + 1);
  }

  const curvatureThreshold = 1 / maxCornerRadiusMeters;
  const isCorner = curvature.map((k) => Math.abs(k) > curvatureThreshold);

  const padSamples = Math.round(runPaddingMeters / ds);
  const minRunSamples = Math.max(2, Math.round(minRunMeters / ds));

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  const side = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();

  // Vertices are emitted per quad rather than shared between them so each
  // stripe keeps a single flat color instead of gradient-blending into its
  // neighbour.
  function pushVertex(
    p: THREE.Vector3,
    sideVec: THREE.Vector3,
    offset: number,
    y: number,
  ) {
    positions.push(p.x + sideVec.x * offset, y, p.z + sideVec.z * offset);
    normals.push(0, 1, 0);
    colors.push(color.r, color.g, color.b);
  }

  for (const [start, count] of circularRuns(isCorner)) {
    if (count < minRunSamples) continue;

    // One direction for the whole corner: the sign at its sharpest point.
    // Sampling per vertex would flip the kerb across the track at the
    // inflection where a corner's curvature crosses zero.
    let peak = 0;
    for (let step = 0; step < count; step++) {
      const k = curvature[(start + step) % n];
      if (Math.abs(k) > Math.abs(peak)) peak = k;
    }
    // side = tangent × up, so a turn toward -side reads as a negative cross
    // product: the inner edge lies at sign(curvature) * halfWidth.
    const innerSign = Math.sign(peak) || 1;

    const paddedStart = start - padSamples;
    const paddedCount = Math.min(n, count + padSamples * 2);

    for (let step = 0; step < paddedCount; step++) {
      const i = (paddedStart + step + n * 2) % n;
      const j = (i + 1) % n;
      const p0 = pts[i];
      const p1 = pts[j];
      const s0 = i / n;
      const s1 = j / n;

      // Stripe index from absolute arc position, so the pattern stays put
      // when the run's padding changes and never restarts mid-corner.
      const stripe = Math.floor((i * ds) / stripeMeters);
      color.copy(stripe % 2 === 0 ? KERB_RED : KERB_WHITE);

      const inner0 = halfWidthAt(halfWidth, s0) * innerSign;
      const inner1 = halfWidthAt(halfWidth, s1) * innerSign;
      const outer0 = inner0 + widthMeters * innerSign;
      const outer1 = inner1 + widthMeters * innerSign;

      const t0 = tangents[i];
      const t1 = tangents[j];
      const yInner0 = p0.y + raise;
      const yInner1 = p1.y + raise;
      const yOuter0 = yInner0 + liftMeters;
      const yOuter1 = yInner1 + liftMeters;

      side.crossVectors(t0, up);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      const sideA = side.clone();
      side.crossVectors(t1, up);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      const sideB = side.clone();

      // Two triangles, wound so the strip faces up for either turn direction.
      const a = () => pushVertex(p0, sideA, inner0, yInner0);
      const b = () => pushVertex(p0, sideA, outer0, yOuter0);
      const c = () => pushVertex(p1, sideB, inner1, yInner1);
      const d = () => pushVertex(p1, sideB, outer1, yOuter1);

      if (innerSign > 0) {
        a(); c(); b();
        b(); c(); d();
      } else {
        a(); b(); c();
        b(); d(); c();
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
