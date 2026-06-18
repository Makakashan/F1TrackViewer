import * as THREE from "three";

export type StartFinishSource = "manual" | "estimated";

export interface StartFinishPlacement {
  s: number;
  source: StartFinishSource;
}

export const START_FINISH_OVERRIDES: Record<string, number> = {
  // Position values are normalized along the rendered closed curve.
  // Add verified entries here as tracks are calibrated.
  "mc-1929": 0.74108,
  "br-1940": 0,
  "be-1925": 0,
  "ca-1978": 0,
  "us-2012": 0,
  "fr-1969": 0,
  "us-2023": 0,
  "us-2022": 0,
  "sg-2008": 0,
  "au-1953": 0,
  "pt-1972": 0,
  "it-1953": 0,
  "mx-1962": 0,
  "pt-2008": 0,
  "br-1977": 0,
  "it-1914": 0,
  "it-1922": 0,
  "ar-1952": 0,
  "az-2016": 0,
  "es-1991": 0.032,
  "fr-1960": 0,
  "nl-1948": 0,
  "es-2026": 0,
  "de-1932": 0,
  "hu-1986": 0,
  "us-1909": 0,
  "tr-2005": 0,
  "sa-2021": 0,
  "za-1961": 0,
  "qa-2004": 0,
  "de-1927": 0,
  "at-1969": 0,
  "my-1999": 0,
  "cn-2004": 0.9469,
  "gb-1948": 0.53798,
  "ru-2014": 0,
  "jp-1962": 0,
  "us-1956": 0,
  "ae-2009": 0,
};

function wrap01(value: number): number {
  return ((value % 1) + 1) % 1;
}

function tangentAt(curve: THREE.CatmullRomCurve3, s: number): THREE.Vector3 {
  return curve.getTangentAt(wrap01(s)).normalize();
}

function angleBetween(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
}

/**
 * Estimate the start/finish position from geometry only.
 *
 * This deliberately avoids using the first GeoJSON point: source ordering is
 * not a racing semantic. The marker is placed in the middle of the longest
 * low-curvature run, which is usually a better approximation of the main
 * straight until a circuit-specific override is verified.
 */
export function estimateStartFinishS(
  curve: THREE.CatmullRomCurve3,
  samples: number,
): number {
  const n = Math.max(240, Math.min(1200, Math.round(samples / 2)));
  const window = Math.max(3, Math.round(n / 160));
  const straightAngleLimit = THREE.MathUtils.degToRad(2.8);

  const straight: boolean[] = [];
  const angles: number[] = [];

  for (let i = 0; i < n; i++) {
    const s = i / n;
    const before = tangentAt(curve, s - window / n);
    const after = tangentAt(curve, s + window / n);
    const angle = angleBetween(before, after);
    angles.push(angle);
    straight.push(angle <= straightAngleLimit);
  }

  let bestStart = 0;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;

  for (let i = 0; i < n * 2; i++) {
    const idx = i % n;
    if (straight[idx]) {
      if (runStart < 0) runStart = i;
      runLen += 1;
      const cappedLen = Math.min(runLen, n);
      if (cappedLen > bestLen) {
        bestLen = cappedLen;
        bestStart = i - cappedLen + 1;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }

  if (bestLen > 0) {
    return wrap01((bestStart + bestLen / 2) / n);
  }

  let bestAngleIndex = 0;
  for (let i = 1; i < angles.length; i++) {
    if (angles[i] < angles[bestAngleIndex]) bestAngleIndex = i;
  }
  return bestAngleIndex / n;
}

export function resolveStartFinishPlacement(
  circuitId: string,
  _curve: THREE.CatmullRomCurve3,
  _samples: number,
  calibratedOverride?: number | null,
): StartFinishPlacement {
  if (calibratedOverride != null) {
    return { s: wrap01(calibratedOverride), source: "manual" };
  }

  const override = START_FINISH_OVERRIDES[circuitId];
  if (override != null) {
    return { s: wrap01(override), source: "manual" };
  }

  return {
    s: 0,
    source: "estimated",
  };
}

export function findNearestCurveS(
  curve: THREE.CatmullRomCurve3,
  point: THREE.Vector3,
  samples: number,
): number {
  const n = Math.max(600, Math.min(3000, samples * 2));
  let bestS = 0;
  let bestDist = Infinity;

  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const candidate = curve.getPointAt(s);
    const dist = candidate.distanceToSquared(point);
    if (dist < bestDist) {
      bestDist = dist;
      bestS = s;
    }
  }

  const refineStep = 1 / n;
  for (let pass = 0; pass < 4; pass++) {
    const step = refineStep / 2 ** pass;
    for (const s of [bestS - step, bestS, bestS + step]) {
      const wrapped = wrap01(s);
      const candidate = curve.getPointAt(wrapped);
      const dist = candidate.distanceToSquared(point);
      if (dist < bestDist) {
        bestDist = dist;
        bestS = wrapped;
      }
    }
  }

  return wrap01(bestS);
}

export function buildStartFinishGeometry(
  curve: THREE.CatmullRomCurve3,
  s: number,
  halfWidth: number,
  topRaise: number,
): THREE.BufferGeometry {
  const center = curve.getPointAt(wrap01(s));
  const tangent = curve.getTangentAt(wrap01(s)).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const across = new THREE.Vector3().crossVectors(tangent, up);
  if (across.lengthSq() < 1e-6) across.set(1, 0, 0);
  across.normalize();

  const markerLength = halfWidth * 2.15;
  const markerDepth = Math.max(2.4, halfWidth * 0.34);
  const cells = 10;
  const y = center.y + topRaise + 0.09;
  const start = -markerLength / 2;
  const cellLength = markerLength / cells;

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  function pushVertex(acrossOffset: number, depthOffset: number, color: number[]) {
    const p = center
      .clone()
      .addScaledVector(across, acrossOffset)
      .addScaledVector(tangent, depthOffset);
    positions.push(p.x, y, p.z);
    colors.push(color[0], color[1], color[2]);
  }

  for (let i = 0; i < cells; i++) {
    const x0 = start + i * cellLength;
    const x1 = x0 + cellLength;
    const base = positions.length / 3;
    const color = i % 2 === 0 ? [1, 1, 1] : [0.02, 0.02, 0.025];

    pushVertex(x0, -markerDepth / 2, color);
    pushVertex(x1, -markerDepth / 2, color);
    pushVertex(x0, markerDepth / 2, color);
    pushVertex(x1, markerDepth / 2, color);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
