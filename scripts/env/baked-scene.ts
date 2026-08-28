/**
 * Reads a baked circuit back — the GLBs as the browser gets them.
 *
 * Every check that asks "does this stand on the ground" has to ask it of the
 * geometry that ships, not of the field the bake read on the way there. The two
 * are not the same surface: the field is sampled at 3.9 m and the belts mesh it
 * at 4, 8 and 16, so a wall placed from the field can miss the triangle drawn
 * under it by metres. An audit that reads the field is measuring the bake's
 * intention; this reads its result.
 *
 * The reader is shared rather than living inside the audit, because the tests
 * have to see exactly what the audit sees or they are two opinions about one
 * file.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

import { BELT_ORDER, type Belt } from "./belts";

export interface BakedMesh {
  name: string;
  /** World-space, with the node's quantisation transform already applied. */
  positions: Float32Array;
  indices: Uint32Array;
  colors: Float32Array | null;
  triangles: number;
}

export interface BakedBelt {
  belt: Belt;
  bytes: number;
  meshes: BakedMesh[];
}

export async function readBakedBelt(
  environmentsDir: string,
  circuitId: string,
  belt: Belt,
): Promise<BakedBelt> {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
  const path = join(environmentsDir, circuitId, `${belt}.glb`);
  const bytes = (await readFile(path)).byteLength;
  const document = await io.read(path);

  const meshes: BakedMesh[] = [];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const translation = node.getTranslation();
    const scale = node.getScale();
    for (const primitive of mesh.listPrimitives()) {
      const attribute = primitive.getAttribute("POSITION");
      if (!attribute) continue;
      const count = attribute.getCount();
      const positions = new Float32Array(count * 3);
      const element = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        attribute.getElement(i, element);
        // Quantised meshes carry their world placement on the node.
        positions[i * 3] = element[0] * scale[0] + translation[0];
        positions[i * 3 + 1] = element[1] * scale[1] + translation[1];
        positions[i * 3 + 2] = element[2] * scale[2] + translation[2];
      }

      const indexed = primitive.getIndices();
      const indices = new Uint32Array(indexed?.getCount() ?? count);
      if (indexed) {
        for (let i = 0; i < indexed.getCount(); i++) indices[i] = indexed.getScalar(i);
      } else {
        for (let i = 0; i < count; i++) indices[i] = i;
      }

      const colorAttribute = primitive.getAttribute("COLOR_0");
      let colors: Float32Array | null = null;
      if (colorAttribute) {
        colors = new Float32Array(count * 3);
        const rgba = [0, 0, 0, 0];
        for (let i = 0; i < count; i++) {
          colorAttribute.getElement(i, rgba);
          colors[i * 3] = rgba[0];
          colors[i * 3 + 1] = rgba[1];
          colors[i * 3 + 2] = rgba[2];
        }
      }

      meshes.push({
        name: mesh.getName(),
        positions,
        indices,
        colors,
        triangles: indices.length / 3,
      });
    }
  }
  return { belt, bytes, meshes };
}

export async function readBakedCircuit(
  environmentsDir: string,
  circuitId: string,
): Promise<BakedBelt[]> {
  const belts: BakedBelt[] = [];
  for (const belt of BELT_ORDER) belts.push(await readBakedBelt(environmentsDir, circuitId, belt));
  return belts;
}

// ─── the ground, as drawn ──────────────────────────────────────────────────

/**
 * Bucket size for the triangle index. A far-belt cell is 16 m and its triangles
 * are the largest here, so a bucket that size holds a handful each.
 */
const BUCKET_M = 16;
/**
 * A triangle whose footprint is thinner than this is a skirt hanging off an
 * edge, not ground: it is vertical, so nothing stands on it and asking it for a
 * height is asking which of two answers a wall has.
 */
const MIN_FOOTPRINT_M2 = 0.05;

export interface GroundIndex {
  /** Height of the drawn terrain under a point, or NaN where none is drawn. */
  at(x: number, z: number): number;
  triangles: number;
}

interface Bucketed {
  /** Triangle corner positions, nine floats per triangle. */
  corners: Float32Array;
  buckets: Map<number, number[]>;
  cols: number;
  minX: number;
  minZ: number;
}

function bucketTerrain(meshes: BakedMesh[]): Bucketed | null {
  const terrain = meshes.filter((mesh) => mesh.name === "terrain");
  if (!terrain.length) return null;

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let count = 0;
  for (const mesh of terrain) {
    count += mesh.indices.length / 3;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] < minX) minX = mesh.positions[i];
      if (mesh.positions[i] > maxX) maxX = mesh.positions[i];
      if (mesh.positions[i + 2] < minZ) minZ = mesh.positions[i + 2];
      if (mesh.positions[i + 2] > maxZ) maxZ = mesh.positions[i + 2];
    }
  }
  if (!count) return null;

  const cols = Math.max(1, Math.ceil((maxX - minX) / BUCKET_M) + 1);
  const corners = new Float32Array(count * 9);
  const buckets = new Map<number, number[]>();
  let written = 0;

  for (const mesh of terrain) {
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t] * 3;
      const b = mesh.indices[t + 1] * 3;
      const c = mesh.indices[t + 2] * 3;
      const ax = mesh.positions[a];
      const az = mesh.positions[a + 2];
      const bx = mesh.positions[b];
      const bz = mesh.positions[b + 2];
      const cx = mesh.positions[c];
      const cz = mesh.positions[c + 2];
      const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
      if (area < MIN_FOOTPRINT_M2) continue;

      const at = written * 9;
      corners[at] = ax;
      corners[at + 1] = mesh.positions[a + 1];
      corners[at + 2] = az;
      corners[at + 3] = bx;
      corners[at + 4] = mesh.positions[b + 1];
      corners[at + 5] = bz;
      corners[at + 6] = cx;
      corners[at + 7] = mesh.positions[c + 1];
      corners[at + 8] = cz;

      const colFrom = Math.floor((Math.min(ax, bx, cx) - minX) / BUCKET_M);
      const colTo = Math.floor((Math.max(ax, bx, cx) - minX) / BUCKET_M);
      const rowFrom = Math.floor((Math.min(az, bz, cz) - minZ) / BUCKET_M);
      const rowTo = Math.floor((Math.max(az, bz, cz) - minZ) / BUCKET_M);
      for (let row = rowFrom; row <= rowTo; row++) {
        for (let col = colFrom; col <= colTo; col++) {
          const key = row * cols + col;
          const list = buckets.get(key);
          if (list) list.push(written);
          else buckets.set(key, [written]);
        }
      }
      written++;
    }
  }

  return { corners: corners.subarray(0, written * 9), buckets, cols, minX, minZ };
}

function heightIn(bucketed: Bucketed, x: number, z: number): number {
  const col = Math.floor((x - bucketed.minX) / BUCKET_M);
  const row = Math.floor((z - bucketed.minZ) / BUCKET_M);
  const list = bucketed.buckets.get(row * bucketed.cols + col);
  if (!list) return Number.NaN;

  let best = Number.NaN;
  for (const index of list) {
    const at = index * 9;
    const ax = bucketed.corners[at];
    const az = bucketed.corners[at + 2];
    const bx = bucketed.corners[at + 3];
    const bz = bucketed.corners[at + 5];
    const cx = bucketed.corners[at + 6];
    const cz = bucketed.corners[at + 8];
    const twice = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(twice) < 1e-9) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / twice;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / twice;
    const w = 1 - u - v;
    // A point on a shared edge belongs to both triangles and to neither's
    // interior in exact arithmetic, so the test is inclusive by a hair.
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const y = u * bucketed.corners[at + 1] + v * bucketed.corners[at + 4] + w * bucketed.corners[at + 7];
    // Belts overlap by a seam's width, and where two surfaces answer, the
    // higher one is the one a wall would be standing on.
    if (Number.isNaN(best) || y > best) best = y;
  }
  return best;
}

/**
 * The drawn ground, finest belt first. Where belts meet, the core's 4 m answer
 * beats the far belt's 16 m one — that is the surface the camera sees there.
 */
export function buildGroundIndex(belts: BakedBelt[]): GroundIndex {
  const ordered: Bucketed[] = [];
  let triangles = 0;
  for (const belt of BELT_ORDER) {
    const found = belts.find((candidate) => candidate.belt === belt);
    if (!found) continue;
    const bucketed = bucketTerrain(found.meshes);
    if (!bucketed) continue;
    triangles += bucketed.corners.length / 9;
    ordered.push(bucketed);
  }

  return {
    triangles,
    at(x: number, z: number): number {
      for (const bucketed of ordered) {
        const y = heightIn(bucketed, x, z);
        if (!Number.isNaN(y)) return y;
      }
      return Number.NaN;
    },
  };
}

// ─── one merged mesh, many buildings ───────────────────────────────────────

/**
 * Labels every vertex with the piece it belongs to. A belt ships one merged
 * mesh per kind, so "does this building float" is a question about a connected
 * component of that mesh rather than about the mesh.
 *
 * Vertices at the same position are welded first. The meshes are flat-shaded,
 * so every face carries its own copy of each corner and walking the indices
 * alone finds 61,358 pieces in a belt that holds about 1,200 buildings — one
 * per face, and a roof face measures as a building floating twelve storeys up.
 */
export function connectedComponents(mesh: BakedMesh): { labels: Int32Array; count: number } {
  const vertices = mesh.positions.length / 3;
  const parent = new Int32Array(vertices);
  for (let i = 0; i < vertices; i++) parent[i] = i;

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // Path compression: a merged city is one long chain otherwise.
    let walk = i;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const atPosition = new Map<string, number>();
  for (let i = 0; i < vertices; i++) {
    const key = `${mesh.positions[i * 3].toFixed(3)},${mesh.positions[i * 3 + 1].toFixed(3)},${mesh.positions[i * 3 + 2].toFixed(3)}`;
    const first = atPosition.get(key);
    if (first === undefined) atPosition.set(key, i);
    else union(first, i);
  }

  for (let i = 0; i < mesh.indices.length; i += 3) {
    union(mesh.indices[i], mesh.indices[i + 1]);
    union(mesh.indices[i], mesh.indices[i + 2]);
  }

  const labels = new Int32Array(vertices);
  const labelOf = new Map<number, number>();
  let count = 0;
  for (let i = 0; i < vertices; i++) {
    const root = find(i);
    let label = labelOf.get(root);
    if (label === undefined) {
      label = count++;
      labelOf.set(root, label);
    }
    labels[i] = label;
  }
  return { labels, count };
}
