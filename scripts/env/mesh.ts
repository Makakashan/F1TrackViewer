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

  /** Call once, after every triangle: face normals were summed, not averaged. */
  finish(): Mesh {
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
}
