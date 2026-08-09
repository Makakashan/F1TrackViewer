/**
 * Collapse a loaded car glTF into a handful of instanceable parts.
 *
 * A grid is twenty cars. The model as exported is 76 separate meshes, so drawn
 * naively that is 1520 draw calls a frame before the track itself is
 * considered — not a tuning problem, a structural one. Merging by material
 * takes one car to roughly a dozen parts, and rendering each part as a single
 * InstancedMesh takes the whole grid to the same dozen: twenty cars cost what
 * one costs.
 *
 * Normalization is baked into the merged geometry rather than applied as a
 * parent transform, so an instance matrix is a plain world placement — position,
 * heading, nothing else. That keeps the per-frame work to writing one matrix
 * per car.
 */

import * as THREE from "three";
import { CAR_LENGTH } from "@/lib/cars/car-config";
import { liverySlotFor, type LiverySlot } from "@/lib/race/f1-teams";

export interface CarPart {
  /** Source material name — what decides the livery slot. */
  name: string;
  /** Merged, normalized geometry. Position and normal only. */
  geometry: THREE.BufferGeometry;
  /** The part's own colour, used when no livery slot applies. */
  color: THREE.Color;
  metalness: number;
  roughness: number;
  /** Which livery colour tints this part, or null for fixed hardware. */
  slot: LiverySlot | null;
  triangles: number;
}

export interface CarMesh {
  parts: CarPart[];
  triangles: number;
  /** Bounding size after normalization, in metres. */
  size: THREE.Vector3;
}

interface Bucket {
  name: string;
  material: THREE.MeshStandardMaterial;
  positions: number[];
  normals: number[];
  indices: number[];
  vertexCount: number;
}

/**
 * Merge one mesh into its material's bucket, in world space.
 *
 * Indices are re-based rather than the geometry being converted to
 * non-indexed: a car is heavily indexed, and dropping the index would roughly
 * triple the vertex data for no benefit.
 */
function appendMesh(bucket: Bucket, mesh: THREE.Mesh) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  if (!position) return;

  let normal = geometry.getAttribute("normal");
  if (!normal) {
    geometry.computeVertexNormals();
    normal = geometry.getAttribute("normal");
  }

  const matrix = mesh.matrixWorld;
  // Normals transform by the inverse transpose; using the model matrix
  // directly would skew them wherever a node carries a non-uniform scale, and
  // these models do.
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);

  const vertex = new THREE.Vector3();
  const base = bucket.vertexCount;

  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
    bucket.positions.push(vertex.x, vertex.y, vertex.z);

    vertex.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
    bucket.normals.push(vertex.x, vertex.y, vertex.z);
  }
  bucket.vertexCount += position.count;

  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i++) {
      bucket.indices.push(base + index.getX(i));
    }
  } else {
    for (let i = 0; i < position.count; i++) bucket.indices.push(base + i);
  }
}

export function buildCarMesh(scene: THREE.Object3D): CarMesh {
  scene.updateWorldMatrix(true, true);

  // Keyed by material name, not identity: the same logical part can arrive as
  // several material instances, and merging them is the entire point.
  const buckets = new Map<string, Bucket>();

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    // A mesh split across several materials would need per-group extraction;
    // the optimized cars have one material per mesh, so take the first and
    // stay simple rather than build machinery for a case that does not occur.
    const material = materials[0] as THREE.MeshStandardMaterial | undefined;
    if (!material) return;

    const name = material.name || material.uuid;
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = {
        name,
        material,
        positions: [],
        normals: [],
        indices: [],
        vertexCount: 0,
      };
      buckets.set(name, bucket);
    }
    appendMesh(bucket, mesh);
  });

  // One pass over the merged data to find the whole car's bounds, so every
  // part is normalized by the same transform.
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.positions.length; i += 3) {
      point.set(
        bucket.positions[i],
        bucket.positions[i + 1],
        bucket.positions[i + 2],
      );
      bounds.expandByPoint(point);
    }
  }

  const rawSize = bounds.isEmpty()
    ? new THREE.Vector3(1, 1, 1)
    : bounds.getSize(new THREE.Vector3());
  const longest = Math.max(rawSize.x, rawSize.z) || 1;
  const scale = CAR_LENGTH / longest;
  const centre = bounds.isEmpty()
    ? new THREE.Vector3()
    : bounds.getCenter(new THREE.Vector3());

  const parts: CarPart[] = [];
  let triangles = 0;

  for (const bucket of buckets.values()) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(bucket.positions, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(bucket.normals, 3),
    );
    geometry.setIndex(bucket.indices);

    // Centre horizontally, sit the wheels on y=0, then scale to a real car.
    geometry.translate(-centre.x, -bounds.min.y, -centre.z);
    geometry.scale(scale, scale, scale);
    geometry.computeBoundingSphere();

    const partTriangles = bucket.indices.length / 3;
    triangles += partTriangles;

    parts.push({
      name: bucket.name,
      geometry,
      color: bucket.material.color?.clone() ?? new THREE.Color("#ffffff"),
      metalness: bucket.material.metalness ?? 0.2,
      roughness: bucket.material.roughness ?? 0.5,
      slot: liverySlotFor(bucket.name),
      triangles: partTriangles,
    });
  }

  // Largest parts first. Sorting is not required for correctness, but it makes
  // the part list readable when it is shown in a debug panel.
  parts.sort((a, b) => b.triangles - a.triangles);

  return {
    parts,
    triangles,
    size: rawSize.multiplyScalar(scale),
  };
}

export function disposeCarMesh(car: CarMesh) {
  for (const part of car.parts) part.geometry.dispose();
}
