import * as THREE from "three";

/** Extruded track mesh — top surface + side walls down to groundY. Flat-shaded quads. */
export function buildExtrudedTrack(
  curve: THREE.CatmullRomCurve3,
  halfWidth: number,
  topRaise: number,
  groundY: number,
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

    const topY = p.y + topRaise;
    const lx = p.x + side.x * halfWidth;
    const lz = p.z + side.z * halfWidth;
    const rx = p.x - side.x * halfWidth;
    const rz = p.z - side.z * halfWidth;
    const wallTopY = topY - 0.08;

    pushV(lx, topY, lz, 0, 0, 0);
    pushV(rx, topY, rz, 0, 0, 0);
    pushV(lx, wallTopY, lz, 0, 0, 0);
    pushV(rx, wallTopY, rz, 0, 0, 0);
    pushV(lx, groundY, lz, 0, 0, 0);
    pushV(rx, groundY, rz, 0, 0, 0);
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
  halfWidth: number,
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
    const topY = p.y + topRaise;
    leftPts.push(p.x + side.x * halfWidth, topY, p.z + side.z * halfWidth);
    rightPts.push(p.x - side.x * halfWidth, topY, p.z - side.z * halfWidth);
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
