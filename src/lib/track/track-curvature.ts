import * as THREE from "three";

/** Signed curvature of a closed track centerline, sampled at even arc length. */
export interface CurvatureProfile {
  /** Number of samples; sample i sits at s = i / samples. */
  samples: number;
  /** Arc length between samples, in meters. */
  ds: number;
  /** Total centerline length, in meters. */
  totalLength: number;
  /** Unit tangents at each sample. */
  tangents: THREE.Vector3[];
  /** Signed curvature in 1/m, smoothed. */
  curvature: number[];
}

/** Smoothing window radius, in meters. */
const SMOOTH_RADIUS_M = 6;

export function sampleCurvature(
  curve: THREE.CatmullRomCurve3,
  samples: number,
  smoothRadiusMeters: number = SMOOTH_RADIUS_M,
): CurvatureProfile | null {
  const n = samples;
  if (n < 8) return null;

  const totalLength = curve.getLength();
  const ds = totalLength / n;
  if (!(ds > 0)) return null;

  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) tangents.push(curve.getTangentAt(i / n));

  const raw = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = tangents[(i - 1 + n) % n];
    const b = tangents[(i + 1) % n];
    const cross = a.x * b.z - a.z * b.x;
    const dot = a.x * b.x + a.z * b.z;
    raw[i] = Math.atan2(cross, dot) / (2 * ds);
  }

  // One noisy sample must not spawn a kerb fragment or a braking event.
  const smoothRadius = Math.max(1, Math.round(smoothRadiusMeters / ds));
  const curvature = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let o = -smoothRadius; o <= smoothRadius; o++) {
      sum += raw[(i + o + n) % n];
    }
    curvature[i] = sum / (2 * smoothRadius + 1);
  }

  return { samples: n, ds, totalLength, tangents, curvature };
}
