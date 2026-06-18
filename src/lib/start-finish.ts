import * as THREE from "three";

export type StartFinishSource = "verified" | "calibrated" | "estimated";

export interface StartFinishPlacement {
  s: number;
  source: StartFinishSource;
  verified: boolean;
  note?: string;
}

export interface CircuitMarkerSchema {
  circuitId: string;
  startFinish: {
    s: number;
    verified: boolean;
    note?: string;
  };
  direction: "clockwise" | "counterclockwise" | "unknown";
  corners: [];
  sectors: [];
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

export function createCircuitMarkerSchema(
  circuitId: string,
  s: number,
  verified = true,
  note = "manual calibrated",
): CircuitMarkerSchema {
  return {
    circuitId,
    startFinish: {
      s: Number(wrap01(s).toFixed(5)),
      verified,
      note,
    },
    direction: "unknown",
    corners: [],
    sectors: [],
  };
}

export function formatMarkerExport(overrides: Record<string, number>): string {
  const markerExport = Object.fromEntries(
    Object.entries(overrides)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([circuitId, s]) => [
        circuitId,
        createCircuitMarkerSchema(circuitId, s),
      ]),
  );

  return JSON.stringify(markerExport, null, 2);
}

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
    return {
      s: wrap01(calibratedOverride),
      source: "calibrated",
      verified: true,
      note: "local admin calibration",
    };
  }

  const override = START_FINISH_OVERRIDES[circuitId];
  if (override != null) {
    return {
      s: wrap01(override),
      source: "verified",
      verified: true,
      note: "checked marker override",
    };
  }

  return {
    s: 0,
    source: "estimated",
    verified: false,
    note: "GeoJSON starts at fallback position",
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
  const y = center.y + topRaise + 0.35;
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

export function buildDirectionArrowGeometry(
  curve: THREE.CatmullRomCurve3,
  startFinishS: number,
  halfWidth: number,
  topRaise: number,
): THREE.BufferGeometry {
  const arrowS = wrap01(startFinishS - 0.012);
  const center = curve.getPointAt(arrowS);
  const tangent = curve.getTangentAt(arrowS).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const across = new THREE.Vector3().crossVectors(tangent, up);
  if (across.lengthSq() < 1e-6) across.set(1, 0, 0);
  across.normalize();

  const length = Math.max(6, halfWidth * 1.35);
  const width = Math.max(5, halfWidth * 1.1);
  const y = center.y + topRaise + 0.45;

  const tip = center
    .clone()
    .addScaledVector(tangent, length / 2)
    .setY(y);
  const left = center
    .clone()
    .addScaledVector(tangent, -length / 2)
    .addScaledVector(across, width / 2)
    .setY(y);
  const right = center
    .clone()
    .addScaledVector(tangent, -length / 2)
    .addScaledVector(across, -width / 2)
    .setY(y);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        tip.x,
        tip.y,
        tip.z,
        left.x,
        left.y,
        left.z,
        right.x,
        right.y,
        right.z,
      ],
      3,
    ),
  );
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

export interface StartFinishGantryGeometries {
  posts: THREE.BufferGeometry;
  beam: THREE.BufferGeometry;
}

export function buildStartFinishGantryGeometry(
  curve: THREE.CatmullRomCurve3,
  s: number,
  halfWidth: number,
  topRaise: number,
): StartFinishGantryGeometries {
  const center = curve.getPointAt(wrap01(s));
  const tangent = curve.getTangentAt(wrap01(s)).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const across = new THREE.Vector3().crossVectors(tangent, up);
  if (across.lengthSq() < 1e-6) across.set(1, 0, 0);
  across.normalize();

  const span = halfWidth * 2.08;
  const postHeight = Math.max(7, halfWidth * 1.05);
  const postWidth = Math.max(0.8, halfWidth * 0.12);
  const beamHeight = Math.max(2.8, halfWidth * 0.42);
  const beamDepth = Math.max(1.6, halfWidth * 0.24);
  const baseY = center.y + topRaise + 0.12;
  const beamCenterY = baseY + postHeight;

  function createBoxGeometry(
    boxCenter: THREE.Vector3,
    widthAcross: number,
    height: number,
    depthAlong: number,
    color?: [number, number, number],
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    const colors: number[] = [];
    const halfAcross = widthAcross / 2;
    const halfHeight = height / 2;
    const halfDepth = depthAlong / 2;

    const corners = [
      [-halfAcross, -halfHeight, -halfDepth],
      [halfAcross, -halfHeight, -halfDepth],
      [halfAcross, halfHeight, -halfDepth],
      [-halfAcross, halfHeight, -halfDepth],
      [-halfAcross, -halfHeight, halfDepth],
      [halfAcross, -halfHeight, halfDepth],
      [halfAcross, halfHeight, halfDepth],
      [-halfAcross, halfHeight, halfDepth],
    ].map(([a, y, d]) =>
      boxCenter
        .clone()
        .addScaledVector(across, a)
        .addScaledVector(up, y)
        .addScaledVector(tangent, d),
    );

    for (const corner of corners) {
      positions.push(corner.x, corner.y, corner.z);
      if (color) colors.push(color[0], color[1], color[2]);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    if (color) {
      geometry.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(colors, 3),
      );
    }
    geometry.setIndex([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6,
      7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
    ]);
    geometry.computeVertexNormals();
    return geometry;
  }

  const postY = baseY + postHeight / 2;
  const postGeometries = [
    createBoxGeometry(
      center.clone().addScaledVector(across, -span / 2).setY(postY),
      postWidth,
      postHeight,
      postWidth,
    ),
    createBoxGeometry(
      center.clone().addScaledVector(across, span / 2).setY(postY),
      postWidth,
      postHeight,
      postWidth,
    ),
  ];
  const postPositions: number[] = [];
  const postIndices: number[] = [];
  for (const geometry of postGeometries) {
    const position = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const base = postPositions.length / 3;
    for (let i = 0; i < position.count; i++) {
      postPositions.push(position.getX(i), position.getY(i), position.getZ(i));
    }
    if (index) {
      for (let i = 0; i < index.count; i++) {
        postIndices.push(base + index.getX(i));
      }
    }
    geometry.dispose();
  }
  const postsGeometry = new THREE.BufferGeometry();
  postsGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(postPositions, 3),
  );
  postsGeometry.setIndex(postIndices);
  postsGeometry.computeVertexNormals();

  const beamCellCount = 14;
  const beamCellWidth = (span + postWidth) / beamCellCount;
  const beamGeometries: THREE.BufferGeometry[] = [];
  for (let i = 0; i < beamCellCount; i++) {
    const offset = -(span + postWidth) / 2 + beamCellWidth * (i + 0.5);
    const color: [number, number, number] =
      i % 2 === 0 ? [0.96, 0.96, 0.92] : [0.015, 0.015, 0.018];
    beamGeometries.push(
      createBoxGeometry(
        center.clone().addScaledVector(across, offset).setY(beamCenterY),
        beamCellWidth,
        beamHeight,
        beamDepth,
        color,
      ),
    );
  }

  const beamPositions: number[] = [];
  const beamColors: number[] = [];
  const beamIndices: number[] = [];
  for (const geometry of beamGeometries) {
    const position = geometry.getAttribute("position");
    const color = geometry.getAttribute("color");
    const index = geometry.getIndex();
    const base = beamPositions.length / 3;
    for (let i = 0; i < position.count; i++) {
      beamPositions.push(position.getX(i), position.getY(i), position.getZ(i));
      beamColors.push(color.getX(i), color.getY(i), color.getZ(i));
    }
    if (index) {
      for (let i = 0; i < index.count; i++) {
        beamIndices.push(base + index.getX(i));
      }
    }
    geometry.dispose();
  }
  const beamGeometry = new THREE.BufferGeometry();
  beamGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(beamPositions, 3),
  );
  beamGeometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(beamColors, 3),
  );
  beamGeometry.setIndex(beamIndices);
  beamGeometry.computeVertexNormals();

  return {
    posts: postsGeometry,
    beam: beamGeometry,
  };
}
