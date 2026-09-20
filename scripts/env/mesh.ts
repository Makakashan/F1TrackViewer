/**
 * Geometry accumulation for the bake.
 *
 * Two shapes of surface come out of the generator and they want different
 * treatment: terrain is a grid whose vertices are shared and whose normals are
 * averaged, while a wall or a roof reads better with a hard edge. So a mesh
 * takes triangles either way and the caller picks.
 */

export interface Mesh {
  positions: number[];
  normals: number[];
  indices: number[];
  /** Baked shade per vertex, written by the AO pass (D9). */
  colors?: number[];
  /**
   * A merged model's own colour per vertex, read off its material or its
   * texture. Kept apart from `colors` because the AO pass writes that array
   * from scratch; the two are multiplied together after it runs.
   */
  albedo?: number[];
  /**
   * The tone every triangle added from now on is painted with, into `albedo`.
   *
   * Set by the caller around a run of geometry — a band of wall, a box on a
   * roof — so the colour follows the triangle rather than a count of them.
   * Counting is what a parallel array cannot survive: a degenerate triangle is
   * dropped, and from there the two arrays are one wall apart for good.
   */
  tone?: number;
}

export function createMesh(): Mesh {
  return { positions: [], normals: [], indices: [] };
}

export function isEmpty(mesh: Mesh): boolean {
  return mesh.indices.length === 0;
}

export function triangleCount(mesh: Mesh): number {
  return mesh.indices.length / 3;
}

/**
 * A triangle with its own three vertices, so the face keeps a hard edge.
 *
 * Returns whether it was kept: a degenerate triangle is dropped, and a caller
 * writing a parallel per-vertex array has to know that to stay in step.
 */
export function addFlatTriangle(
  mesh: Mesh,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): boolean {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-12) return false; // degenerate: a footprint with a repeated vertex
  nx /= length;
  ny /= length;
  nz /= length;

  const base = mesh.positions.length / 3;
  mesh.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  mesh.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  mesh.indices.push(base, base + 1, base + 2);
  if (mesh.tone !== undefined) {
    mesh.albedo ??= [];
    // Catch up over anything added before the first tone was set.
    while (mesh.albedo.length < base * 3) mesh.albedo.push(1);
    for (let i = 0; i < 3; i++) mesh.albedo.push(mesh.tone, mesh.tone, mesh.tone);
  }
  return true;
}

export function addFlatQuad(
  mesh: Mesh,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): void {
  addFlatTriangle(mesh, ax, ay, az, bx, by, bz, cx, cy, cz);
  addFlatTriangle(mesh, ax, ay, az, cx, cy, cz, dx, dy, dz);
}

/**
 * A grid surface: vertices are added once and reused, and normals accumulate
 * across the faces that touch them, so a hillside shades as one surface rather
 * than as a field of facets.
 */
export class GridMesh {
  readonly mesh = createMesh();
  private readonly index = new Map<number, number>();

  vertex(key: number, x: number, y: number, z: number): number {
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;
    const id = this.mesh.positions.length / 3;
    this.mesh.positions.push(x, y, z);
    this.mesh.normals.push(0, 0, 0);
    this.index.set(key, id);
    return id;
  }

  triangle(a: number, b: number, c: number): void {
    const { positions, normals, indices } = this.mesh;
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    for (const v of [a, b, c]) {
      normals[v * 3] += nx;
      normals[v * 3 + 1] += ny;
      normals[v * 3 + 2] += nz;
    }
    indices.push(a, b, c);
  }

  /**
   * Call once, after every triangle: face normals were summed, not averaged.
   *
   * `creaseDeg` splits a vertex whose faces disagree by more than that angle,
   * so a hillside still shades as one surface while a cliff edge, a quay top
   * and a terrace riser keep their edge. Averaging across those is what makes a
   * 8 m belt read as poured wax: the cliff face and the ground above it share a
   * vertex, and the normal that comes out points at neither.
   */
  finish(creaseDeg = 0): Mesh {
    if (creaseDeg > 0) this.splitCreases(Math.cos((creaseDeg * Math.PI) / 180));
    const { normals } = this.mesh;
    for (let i = 0; i < normals.length; i += 3) {
      const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
      if (length < 1e-12) {
        normals[i + 1] = 1;
        continue;
      }
      normals[i] /= length;
      normals[i + 1] /= length;
      normals[i + 2] /= length;
    }
    return this.mesh;
  }

  /**
   * One vertex per group of faces that agree, rather than one per position.
   *
   * The faces at a vertex are gathered into groups whose normals are within the
   * crease angle of the group's first face; the first group keeps the vertex
   * and the rest get a copy of it at the same position. Nothing moves and no
   * triangle is added — only how many normals a corner is allowed to have.
   */
  private splitCreases(cosCrease: number): void {
    const { positions, normals, indices } = this.mesh;
    const faces = indices.length / 3;
    const faceNormals = new Float64Array(faces * 3);
    for (let f = 0; f < faces; f++) {
      const a = indices[f * 3] * 3;
      const b = indices[f * 3 + 1] * 3;
      const c = indices[f * 3 + 2] * 3;
      const ux = positions[b] - positions[a];
      const uy = positions[b + 1] - positions[a + 1];
      const uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a];
      const vy = positions[c + 1] - positions[a + 1];
      const vz = positions[c + 2] - positions[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      // Kept unnormalised: the length is twice the area, which is the weight a
      // vertex normal should give the face, and `finish` normalises at the end.
      faceNormals[f * 3] = nx;
      faceNormals[f * 3 + 1] = ny;
      faceNormals[f * 3 + 2] = nz;
    }

    const vertices = positions.length / 3;
    const corners: number[][] = Array.from({ length: vertices }, () => []);
    for (let f = 0; f < faces; f++) {
      for (let k = 0; k < 3; k++) corners[indices[f * 3 + k]].push(f * 3 + k);
    }

    // Rewritten from nothing: a vertex may end up carrying one group's faces
    // and the copies carry the rest, so the sums have to start again.
    normals.fill(0);
    const unit = (f: number): [number, number, number] => {
      const length = Math.hypot(faceNormals[f * 3], faceNormals[f * 3 + 1], faceNormals[f * 3 + 2]) || 1;
      return [faceNormals[f * 3] / length, faceNormals[f * 3 + 1] / length, faceNormals[f * 3 + 2] / length];
    };
    const addTo = (vertex: number, f: number): void => {
      normals[vertex * 3] += faceNormals[f * 3];
      normals[vertex * 3 + 1] += faceNormals[f * 3 + 1];
      normals[vertex * 3 + 2] += faceNormals[f * 3 + 2];
    };

    for (let v = 0; v < vertices; v++) {
      const groups: { normal: [number, number, number]; vertex: number }[] = [];
      for (const corner of corners[v]) {
        const face = (corner - (corner % 3)) / 3;
        const n = unit(face);
        let group = groups.find(
          (candidate) =>
            candidate.normal[0] * n[0] + candidate.normal[1] * n[1] + candidate.normal[2] * n[2] >= cosCrease,
        );
        if (!group) {
          let vertex = v;
          if (groups.length) {
            // A copy of the corner, so this face can hold its own normal.
            vertex = positions.length / 3;
            positions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
            normals.push(0, 0, 0);
          }
          group = { normal: n, vertex };
          groups.push(group);
        }
        indices[corner] = group.vertex;
        addTo(group.vertex, face);
      }
    }
  }
}

/**
 * Evens the light out where the ground is gentle: a vertex there takes the
 * area-weighted normal of the ground faces within `radius`, whatever the crease
 * pass gave it. A DTM's ripple bends neighbouring faces past the crease angle on
 * flat ground too, and each such corner drew as a hard edge. Returns how many
 * vertices it rewrote.
 */
export function smoothGentleNormals(
  mesh: Mesh,
  options: {
    /** How far the averaged normal reaches: wider than the ripple it removes. */
    radius: number;
    /** How far the slope that decides "gentle" is read: wider than the ripple too. */
    slopeRadius: number;
    gentleDeg: number;
    /** Corners that keep their own normal whatever the slope, such as a wall's foot. */
    keep: (x: number, z: number) => boolean;
  },
): number {
  const { positions, normals, indices } = mesh;
  const { radius, slopeRadius, gentleDeg, keep } = options;
  const faces = indices.length / 3;
  const face = new Float64Array(faces * 5);
  const bucket = new Map<number, number[]>();
  const bucketKey = (bx: number, bz: number) => bx * 100_003 + bz;
  for (let f = 0; f < faces; f++) {
    const a = indices[f * 3] * 3;
    const b = indices[f * 3 + 1] * 3;
    const c = indices[f * 3 + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    // A wall is not ground, and its normal would tip the average sideways.
    if (ny < 0.3 * Math.hypot(nx, ny, nz)) continue;
    const cx = (positions[a] + positions[b] + positions[c]) / 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    face.set([nx, ny, nz, cx, cz], f * 5);
    const k = bucketKey(Math.floor(cx / radius), Math.floor(cz / radius));
    const list = bucket.get(k);
    if (list) list.push(f);
    else bucket.set(k, [f]);
  }

  const cosGentle = Math.cos((gentleDeg * Math.PI) / 180);
  const reach = Math.ceil(slopeRadius / radius);
  let rewritten = 0;
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[v * 3];
    const z = positions[v * 3 + 2];
    if (keep(x, z)) continue;
    let sx = 0, sy = 0, sz = 0;
    let nx = 0, ny = 0, nz = 0;
    const bx = Math.floor(x / radius);
    const bz = Math.floor(z / radius);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const list = bucket.get(bucketKey(bx + dx, bz + dz));
        if (!list) continue;
        for (const f of list) {
          const d = Math.hypot(face[f * 5 + 3] - x, face[f * 5 + 4] - z);
          if (d > slopeRadius) continue;
          sx += face[f * 5];
          sy += face[f * 5 + 1];
          sz += face[f * 5 + 2];
          if (d > radius) continue;
          nx += face[f * 5];
          ny += face[f * 5 + 1];
          nz += face[f * 5 + 2];
        }
      }
    }
    const slopeLength = Math.hypot(sx, sy, sz);
    if (slopeLength === 0 || sy / slopeLength < cosGentle) continue;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0) continue;
    normals[v * 3] = nx / length;
    normals[v * 3 + 1] = ny / length;
    normals[v * 3 + 2] = nz / length;
    rewritten++;
  }
  return rewritten;
}
