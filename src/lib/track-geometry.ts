import * as THREE from "three";
import { distanceToCurveS, sectorArcFraction } from "./track-markers";
import type { SectorDefinition, TrackMarkers } from "./track-markers";

/**
 * Half-width may be a constant (manual slider) or a function of normalized
 * arc position s ∈ [0, 1] for real, per-point track widths.
 */
export type HalfWidth = number | ((s: number) => number);

function halfWidthAt(halfWidth: HalfWidth, s: number): number {
  return typeof halfWidth === "function" ? halfWidth(s) : halfWidth;
}

/** Extruded track mesh — top surface + side walls down to groundY. Flat-shaded quads. */
export function buildExtrudedTrack(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  topRaise: number,
  groundY: number,
  samples: number,
  wallDepth?: number,
): THREE.BufferGeometry {
  const N = samples;
  const pts = curve.getSpacedPoints(N);
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    tangents.push(curve.getTangentAt(i / N));
  }

  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const binorm = new THREE.Vector3();

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  function pushV(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ) {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  }

  function pushQuad(i1: number, i2: number, i3: number, i4: number) {
    indices.push(i1, i3, i2, i2, i3, i4);
  }

  for (let i = 0; i <= N; i++) {
    const p = pts[i];
    const t = tangents[i];

    side.crossVectors(t, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    binorm.crossVectors(side, t).normalize();

    const hw = halfWidthAt(halfWidth, i / N);
    const topY = p.y + topRaise;
    const lx = p.x + side.x * hw;
    const lz = p.z + side.z * hw;
    const rx = p.x - side.x * hw;
    const rz = p.z - side.z * hw;
    const wallTopY = topY - 0.08;
    const bottomY = wallDepth == null ? groundY : topY - wallDepth;

    pushV(lx, topY, lz, 0, 0, 0);
    pushV(rx, topY, rz, 0, 0, 0);
    pushV(lx, wallTopY, lz, 0, 0, 0);
    pushV(rx, wallTopY, rz, 0, 0, 0);
    pushV(lx, bottomY, lz, 0, 0, 0);
    pushV(rx, bottomY, rz, 0, 0, 0);
  }

  const stride = 6;

  function patchQuadNormal(
    i1: number,
    i2: number,
    i3: number,
    i4: number,
  ) {
    a.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    b.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
    c.set(positions[i3 * 3], positions[i3 * 3 + 1], positions[i3 * 3 + 2]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac).normalize();
    for (const idx of [i1, i2, i3, i4]) {
      normals[idx * 3] = n.x;
      normals[idx * 3 + 1] = n.y;
      normals[idx * 3 + 2] = n.z;
    }
  }

  for (let i = 0; i < N; i++) {
    const base0 = i * stride;
    const base1 = (i + 1) * stride;
    const tL0 = base0 + 0;
    const tR0 = base0 + 1;
    const wL0 = base0 + 2;
    const wR0 = base0 + 3;
    const bL0 = base0 + 4;
    const bR0 = base0 + 5;
    const tL1 = base1 + 0;
    const tR1 = base1 + 1;
    const wL1 = base1 + 2;
    const wR1 = base1 + 3;
    const bL1 = base1 + 4;
    const bR1 = base1 + 5;

    pushQuad(tL0, tR0, tL1, tR1);
    patchQuadNormal(tL0, tR0, tL1, tR1);

    pushQuad(wL0, bL0, wL1, bL1);
    patchQuadNormal(wL0, bL0, wL1, bL1);

    pushQuad(wR1, bR1, wR0, bR0);
    patchQuadNormal(wR1, bR1, wR0, bR0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Build a line-segments geometry tracing both top edges of the ribbon.
 * Used as a thin black outline on top of the track surface for visual
 * definition.
 */
export function buildTrackOutline(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  topRaise: number,
  samples: number,
): THREE.BufferGeometry {
  const N = samples;
  const pts = curve.getSpacedPoints(N);
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    tangents.push(curve.getTangentAt(i / N));
  }

  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();

  const leftPts: number[] = [];
  const rightPts: number[] = [];
  for (let i = 0; i <= N; i++) {
    const p = pts[i];
    const t = tangents[i];
    side.crossVectors(t, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const hw = halfWidthAt(halfWidth, i / N);
    const topY = p.y + topRaise;
    leftPts.push(p.x + side.x * hw, topY, p.z + side.z * hw);
    rightPts.push(p.x - side.x * hw, topY, p.z - side.z * hw);
  }

  const positions: number[] = [];
  for (let i = 0; i < N; i++) {
    positions.push(leftPts[i * 3], leftPts[i * 3 + 1], leftPts[i * 3 + 2]);
    positions.push(
      leftPts[(i + 1) * 3],
      leftPts[(i + 1) * 3 + 1],
      leftPts[(i + 1) * 3 + 2],
    );
    positions.push(
      rightPts[i * 3],
      rightPts[i * 3 + 1],
      rightPts[i * 3 + 2],
    );
    positions.push(
      rightPts[(i + 1) * 3],
      rightPts[(i + 1) * 3 + 1],
      rightPts[(i + 1) * 3 + 2],
    );
  }

  const outlineGeo = new THREE.BufferGeometry();
  outlineGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  return outlineGeo;
}

// ─── Sector-colored track mesh ────────────────────────────────────────

function wrap01(value: number): number {
  return ((value % 1) + 1) % 1;
}

/**
 * Build an extruded track ribbon for a single sector.
 * Works just like buildExtrudedTrack but only spans the sector's portion
 * of the curve.
 */
export function buildSectorMesh(
  curve: THREE.CatmullRomCurve3,
  sector: SectorDefinition,
  markers: TrackMarkers,
  halfWidth: HalfWidth,
  topRaise: number,
  groundY: number,
  totalSamples: number,
  wallDepth?: number,
): THREE.BufferGeometry {
  const fromS = distanceToCurveS(
    sector.fromDistance,
    markers.lapLengthMeters,
    markers.startFinish.s,
    markers.directionSign,
  );
  const toS = distanceToCurveS(
    sector.toDistance,
    markers.lapLengthMeters,
    markers.startFinish.s,
    markers.directionSign,
  );

  const fraction = sectorArcFraction(fromS, toS, markers.directionSign);
  const N = Math.max(20, Math.round(totalSamples * fraction));

  // Sample points along the sector
  const pts: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  const arcS: number[] = [];

  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let s: number;
    if (markers.directionSign === 1) {
      const span = wrap01(toS - fromS);
      s = wrap01(fromS + span * t);
    } else {
      const span = wrap01(fromS - toS);
      s = wrap01(fromS - span * t);
    }
    pts.push(curve.getPointAt(s));
    tangents.push(curve.getTangentAt(s));
    arcS.push(s);
  }

  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const binorm = new THREE.Vector3();

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  function pushV(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ) {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  }

  function pushQuad(i1: number, i2: number, i3: number, i4: number) {
    indices.push(i1, i3, i2, i2, i3, i4);
  }

  for (let i = 0; i <= N; i++) {
    const p = pts[i];
    const t = tangents[i];

    side.crossVectors(t, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    binorm.crossVectors(side, t).normalize();

    const hw = halfWidthAt(halfWidth, arcS[i]);
    const topY = p.y + topRaise;
    const lx = p.x + side.x * hw;
    const lz = p.z + side.z * hw;
    const rx = p.x - side.x * hw;
    const rz = p.z - side.z * hw;
    const wallTopY = topY - 0.08;
    const bottomY = wallDepth == null ? groundY : topY - wallDepth;

    pushV(lx, topY, lz, 0, 0, 0);
    pushV(rx, topY, rz, 0, 0, 0);
    pushV(lx, wallTopY, lz, 0, 0, 0);
    pushV(rx, wallTopY, rz, 0, 0, 0);
    pushV(lx, bottomY, lz, 0, 0, 0);
    pushV(rx, bottomY, rz, 0, 0, 0);
  }

  const stride = 6;

  function patchQuadNormal(
    i1: number,
    i2: number,
    i3: number,
    i4: number,
  ) {
    a.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    b.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
    c.set(positions[i3 * 3], positions[i3 * 3 + 1], positions[i3 * 3 + 2]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac).normalize();
    for (const idx of [i1, i2, i3, i4]) {
      normals[idx * 3] = n.x;
      normals[idx * 3 + 1] = n.y;
      normals[idx * 3 + 2] = n.z;
    }
  }

  for (let i = 0; i < N; i++) {
    const base0 = i * stride;
    const base1 = (i + 1) * stride;
    const tL0 = base0 + 0;
    const tR0 = base0 + 1;
    const wL0 = base0 + 2;
    const wR0 = base0 + 3;
    const bL0 = base0 + 4;
    const bR0 = base0 + 5;
    const tL1 = base1 + 0;
    const tR1 = base1 + 1;
    const wL1 = base1 + 2;
    const wR1 = base1 + 3;
    const bL1 = base1 + 4;
    const bR1 = base1 + 5;

    pushQuad(tL0, tR0, tL1, tR1);
    patchQuadNormal(tL0, tR0, tL1, tR1);

    pushQuad(wL0, bL0, wL1, bL1);
    patchQuadNormal(wL0, bL0, wL1, bL1);

    pushQuad(wR1, bR1, wR0, bR0);
    patchQuadNormal(wR1, bR1, wR0, bR0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Build a white sector split line — a thin line across the track at a
 * sector boundary distance, similar to start/finish but simpler (no
 * checker pattern).
 */
export function buildSectorSplitLineGeometry(
  curve: THREE.CatmullRomCurve3,
  distance: number,
  markers: TrackMarkers,
  halfWidth: number,
  topRaise: number,
): THREE.BufferGeometry {
  const s = distanceToCurveS(
    distance,
    markers.lapLengthMeters,
    markers.startFinish.s,
    markers.directionSign,
  );

  const center = curve.getPointAt(wrap01(s));
  const tangent = curve.getTangentAt(wrap01(s)).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const across = new THREE.Vector3().crossVectors(tangent, up);
  if (across.lengthSq() < 1e-6) across.set(1, 0, 0);
  across.normalize();

  const markerLength = halfWidth * 2.15;
  const markerDepth = Math.max(2.0, halfWidth * 0.28);
  const y = center.y + topRaise + 0.09;

  // Two triangles forming a thin white rectangle across the track
  const positions: number[] = [];
  const indices: number[] = [];

  function pushVertex(acrossOffset: number, depthOffset: number) {
    const p = center
      .clone()
      .addScaledVector(across, acrossOffset)
      .addScaledVector(tangent, depthOffset);
    positions.push(p.x, y, p.z);
  }

  pushVertex(-markerLength / 2, -markerDepth / 2); // 0
  pushVertex(markerLength / 2, -markerDepth / 2);  // 1
  pushVertex(-markerLength / 2, markerDepth / 2);   // 2
  pushVertex(markerLength / 2, markerDepth / 2);    // 3

  indices.push(0, 2, 1, 1, 2, 3);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
