import * as THREE from "three";
import { sampleCurvature } from "@/lib/track/track-curvature";
import { racingLineOffsetAt, type RacingLine } from "@/lib/track/racing-line";

/** The dark band cars lay down along the racing line, heavier where they turn. */

const BAND_HALF_WIDTH_M = 1.3;
/** Even a straight carries some rubber. */
const BASE_ALPHA = 0.09;
const CORNER_ALPHA = 0.26;
/** Curvature at which a corner's rubber is at full strength, in 1/m. */
const FULL_CORNER_CURVATURE = 1 / 60;

export function buildRubberGeometry(
  curve: THREE.CatmullRomCurve3,
  samples: number,
  line: RacingLine,
  raise: number,
  /** The way the cars drive the curve; `poseAt` flips `across` by it, so the band must too. */
  directionSign: number,
  hiddenAt?: (s: number) => boolean,
): THREE.BufferGeometry | null {
  const profile = sampleCurvature(curve, samples);
  if (!profile) return null;
  const n = profile.samples;
  const points = curve.getSpacedPoints(n);
  const up = new THREE.Vector3(0, 1, 0);
  const across = new THREE.Vector3();

  const centre: THREE.Vector3[] = [];
  const side: THREE.Vector3[] = [];
  const alpha: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    across.crossVectors(curve.getTangentAt(s % 1), up);
    if (across.lengthSq() < 1e-6) across.set(1, 0, 0);
    across.normalize().multiplyScalar(directionSign);
    const offset = racingLineOffsetAt(line, s);
    centre.push(points[i].clone().addScaledVector(across, offset));
    side.push(across.clone());
    const bend = Math.min(1, Math.abs(profile.curvature[i % n]) / FULL_CORNER_CURVATURE);
    alpha.push(BASE_ALPHA + CORNER_ALPHA * bend);
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const push = (i: number, lateral: number, a: number) => {
    const p = centre[i];
    const v = side[i];
    positions.push(p.x + v.x * lateral, p.y + raise, p.z + v.z * lateral);
    colors.push(0, 0, 0, a);
  };

  for (let i = 0; i < n; i++) {
    if (hiddenAt?.((i + 0.5) / n)) continue;
    const j = i + 1;
    // Two quads per station, fading to nothing at both edges.
    for (const edge of [-BAND_HALF_WIDTH_M, BAND_HALF_WIDTH_M]) {
      push(i, 0, alpha[i]);
      push(j, 0, alpha[j]);
      push(i, edge, 0);
      push(i, edge, 0);
      push(j, 0, alpha[j]);
      push(j, edge, 0);
    }
  }

  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  geometry.computeBoundingSphere();
  return geometry;
}
