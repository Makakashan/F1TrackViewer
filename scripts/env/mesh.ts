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
  /** Texture coordinates, one pair per vertex, where a mesh has them. */
  uv?: number[];
  /**
   * What to give a vertex nobody named a coordinate for — a roof, a chimney,
   * anything on a textured mesh that is not a wall. Blank part of the tile.
   */
  uvPad?: [number, number];
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
  /**
   * Where each of the four corners lands on the material's texture, in the
   * same order. Passed here rather than pushed by the caller afterwards
   * because a degenerate triangle is dropped, and a parallel array that counts
   * on it having been kept is a wall out of step from then on.
   */
  uv?: readonly [number, number][],
): void {
  if (addFlatTriangle(mesh, ax, ay, az, bx, by, bz, cx, cy, cz) && uv) {
    pushUV(mesh, uv[0], uv[1], uv[2]);
  }
  if (addFlatTriangle(mesh, ax, ay, az, cx, cy, cz, dx, dy, dz) && uv) {
    pushUV(mesh, uv[0], uv[2], uv[3]);
  }
}

function pushUV(
  mesh: Mesh,
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): void {
  mesh.uv ??= [];
  // Catch up over anything added before the first textured triangle.
  const pad = mesh.uvPad ?? [0, 0];
  while (mesh.uv.length < (mesh.positions.length / 3 - 3) * 2) mesh.uv.push(pad[0], pad[1]);
  mesh.uv.push(a[0], a[1], b[0], b[1], c[0], c[1]);
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
