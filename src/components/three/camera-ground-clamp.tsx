"use client";

/**
 * Keeps the camera out of the hill. Ground is read once into a coarse max-height grid
 * instead of raycasting 400k triangles per move, so it errs upwards.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";

/** How far above the ground the camera is held. Street level, not a helicopter. */
const CLEARANCE_M = 2;
/** Grid step. Fine enough to follow a street, coarse enough to stay small. */
const CELL_M = 8;
/** The datum the water quad lies on. Under it, the sea is a one-way surface too. */
const SEA_Y = 0;
/** The names the bake gives the ground. Buildings are not in it: they are scenery. */
const GROUND_MESHES = new Set(["terrain", "pier"]);
/** The tunnel's own body: under its roof the road runs below the hill, and the camera follows it in. */
const TUNNEL_MESHES = new Set(["tunnel", "portal"]);

interface GroundGrid {
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** Highest ground in each cell, or `-Infinity` where the belts have none. */
  height: Float32Array;
  /** Highest tunnel in each cell, or `-Infinity` where there is no tunnel. */
  tunnelTop: Float32Array;
}

function sampleGround(scene: THREE.Object3D): GroundGrid | null {
  const meshes: { mesh: THREE.Mesh; tunnel: boolean }[] = [];
  const box = new THREE.Box3();
  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const kind = node.name.replace(/_\d+$/, "");
    const tunnel = TUNNEL_MESHES.has(kind);
    if (!tunnel && !GROUND_MESHES.has(node.name)) return;
    meshes.push({ mesh: node, tunnel });
    box.expandByObject(node);
  });
  if (!meshes.length || box.isEmpty()) return null;

  const cols = Math.max(1, Math.ceil((box.max.x - box.min.x) / CELL_M));
  const rows = Math.max(1, Math.ceil((box.max.z - box.min.z) / CELL_M));
  const height = new Float32Array(cols * rows).fill(-Infinity);
  const tunnelTop = new Float32Array(cols * rows).fill(-Infinity);

  const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const { mesh, tunnel } of meshes) {
    const into = tunnel ? tunnelTop : height;
    const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!position) continue;
    mesh.updateWorldMatrix(true, false);
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      let top = -Infinity;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let c = 0; c < 3; c++) {
        const at = index ? index.getX(i + c) : i + c;
        const point = corner[c].fromBufferAttribute(position, at).applyMatrix4(mesh.matrixWorld);
        if (point.y > top) top = point.y;
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.z < minZ) minZ = point.z;
        if (point.z > maxZ) maxZ = point.z;
      }
      const colFrom = Math.max(0, Math.floor((minX - box.min.x) / CELL_M));
      const colTo = Math.min(cols - 1, Math.floor((maxX - box.min.x) / CELL_M));
      const rowFrom = Math.max(0, Math.floor((minZ - box.min.z) / CELL_M));
      const rowTo = Math.min(rows - 1, Math.floor((maxZ - box.min.z) / CELL_M));
      for (let row = rowFrom; row <= rowTo; row++) {
        for (let col = colFrom; col <= colTo; col++) {
          const at = row * cols + col;
          if (top > into[at]) into[at] = top;
        }
      }
    }
  }

  return { minX: box.min.x, minZ: box.min.z, cols, rows, height, tunnelTop };
}

/**
 * The ground under a point: the cell it stands in, which already holds the
 * highest corner of every triangle that touches the cell.
 */
function groundAt(grid: GroundGrid, x: number, y: number, z: number): number {
  const col = Math.floor((x - grid.minX) / CELL_M);
  const row = Math.floor((z - grid.minZ) / CELL_M);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return -Infinity;
  // Under a tunnel's roof the hill above is not the floor: the road inside is.
  if (y <= grid.tunnelTop[row * grid.cols + col] + CLEARANCE_M) return -Infinity;
  // Off the land is the sea, and the sea is one quad at the datum: from below it
  // is culled and the whole diorama shows through it.
  return Math.max(grid.height[row * grid.cols + col], SEA_Y);
}

export interface CameraGroundClampProps {
  /** Bumped when a belt lands, so the grid is read again over the new ground. */
  version: number;
}

export default function CameraGroundClamp({ version }: CameraGroundClampProps) {
  const scene = useThree((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);
  const gridRef = useRef<GroundGrid | null>(null);

  useEffect(() => {
    gridRef.current = sampleGround(scene);
    invalidate();
  }, [scene, version, invalidate]);

  // After `OrbitControls`, which runs at priority -1 and writes the position
  // this corrects. The next update reads the corrected position back, so the
  // controls follow the clamp rather than fighting it.
  useFrame((state) => {
    const grid = gridRef.current;
    if (!grid) return;
    const { camera, controls } = state;
    const target = (controls as { target?: THREE.Vector3 } | null)?.target;

    const floor = groundAt(grid, camera.position.x, camera.position.y, camera.position.z);
    if (Number.isFinite(floor) && camera.position.y < floor + CLEARANCE_M) {
      camera.position.y = floor + CLEARANCE_M;
    }
    // A target inside the hill drags the camera back in on the next orbit.
    if (target) {
      const under = groundAt(grid, target.x, target.y, target.z);
      if (Number.isFinite(under) && target.y < under) target.y = under;
    }
  });

  return null;
}
