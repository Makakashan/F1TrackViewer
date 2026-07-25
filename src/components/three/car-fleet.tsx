"use client";

import { useGLTF } from "@react-three/drei";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import * as THREE from "three";
import { GRID_SPACING } from "@/lib/car-config";
import { buildCarMesh, disposeCarMesh, type CarPart } from "@/lib/car-mesh";
import { buildGrid, GRID_SIZE, type GridEntry } from "@/lib/f1-teams";

/** Instances are placed, never resized; one shared vector avoids the churn. */
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

export interface CarFleetStats {
  cars: number;
  /** One per material — the whole fleet costs this many, not this many each. */
  drawCalls: number;
  /** Triangles for a single car. */
  trianglesPerCar: number;
  /** Half-extent of the default formation, so a caller can frame it. */
  formationRadius: number;
  parts: { name: string; triangles: number; slot: string | null }[];
}

export interface CarFleetHandle {
  count: number;
  /**
   * Place one car. Cheap: writes into a matrix array, uploads nothing.
   * Follow a batch of these with commit().
   */
  setCar(
    index: number,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
  ): void;
  /** Upload the frame's placements. Call once, after the last setCar. */
  commit(): void;
}

export interface CarFleetProps {
  url: string;
  /** How many cars to render. Defaults to a full twenty-car grid. */
  count?: number;
  /** Livery assignment per slot; defaults to the 2025 grid. */
  grid?: GridEntry[];
  onStats?: (stats: CarFleetStats) => void;
}

/**
 * A whole grid of cars, drawn as one InstancedMesh per material.
 *
 * The point is that cost is independent of car count. Twenty cars share one
 * geometry per part and one draw call per part; only a matrix and a colour
 * differ per car. Rendering them as twenty scene graphs instead would be
 * roughly 1520 draw calls a frame, which no amount of tuning recovers.
 *
 * Per-car colour rides on instanceColor, so each material is created white and
 * the instance attribute supplies everything — including for parts that are the
 * same colour on every car. Uniform handling is simpler than branching on
 * whether a part happens to be team-coloured.
 */
const CarFleet = forwardRef<CarFleetHandle, CarFleetProps>(function CarFleet(
  { url, count = GRID_SIZE, grid, onStats },
  ref,
) {
  const { scene } = useGLTF(url);

  const car = useMemo(() => buildCarMesh(scene), [scene]);
  useEffect(() => () => disposeCarMesh(car), [car]);

  const entries = useMemo(() => grid ?? buildGrid(count), [grid, count]);

  const materials = useMemo(
    () =>
      car.parts.map(
        (part) =>
          new THREE.MeshStandardMaterial({
            // White, because instanceColor multiplies into it.
            color: 0xffffff,
            metalness: part.metalness,
            roughness: part.roughness,
          }),
      ),
    [car],
  );
  useEffect(
    () => () => {
      for (const material of materials) material.dispose();
    },
    [materials],
  );

  const meshRefs = useRef<(THREE.InstancedMesh | null)[]>([]);

  /**
   * Starting placements: a staggered grid, so the fleet is visible before
   * anything drives it. Built here rather than in an effect because it is a
   * pure function of `count`.
   *
   * Centred on the origin rather than running off in one direction, so a
   * caller that has not placed the cars itself can frame them by looking at
   * 0,0,0 — and so the extent below is symmetric and easy to derive a camera
   * distance from.
   */
  const matrices = useMemo(() => {
    const list = Array.from({ length: count }, () => new THREE.Matrix4());
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const rows = Math.ceil(count / 2);
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      position.set((row - (rows - 1) / 2) * GRID_SPACING, 0, side * 4);
      list[i].compose(position, quaternion, UNIT_SCALE);
    }
    return list;
  }, [count]);

  /** Half-extent of the default formation, for framing. */
  const formationRadius = useMemo(
    () => (Math.ceil(count / 2) * GRID_SPACING) / 2 + 6,
    [count],
  );

  /**
   * One-time per-instance setup, run when an InstancedMesh attaches.
   *
   * Done in the ref callback rather than an effect: matrices and colours are
   * properties of the instance buffers, which only exist once the mesh does,
   * and colour never changes afterwards — a car does not switch teams.
   */
  const attachPart = useCallback(
    (mesh: THREE.InstancedMesh | null, partIndex: number) => {
      meshRefs.current[partIndex] = mesh;
      if (!mesh) return;

      const part: CarPart = car.parts[partIndex];
      const colour = new THREE.Color();
      for (let i = 0; i < count; i++) {
        mesh.setMatrixAt(i, matrices[i]);
        const entry = entries[i % entries.length];
        if (part.slot) colour.set(entry.team.livery[part.slot]);
        else colour.copy(part.color);
        mesh.setColorAt(i, colour);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Covers every instance, so the fleet can be frustum-culled normally.
      // The alternative — disabling culling because the geometry's own sphere
      // describes a single car at the origin — means every part of every car
      // is submitted every frame no matter where the camera looks.
      mesh.computeBoundingSphere();
    },
    [car, count, entries, matrices],
  );

  useEffect(() => {
    onStats?.({
      cars: count,
      drawCalls: car.parts.length,
      trianglesPerCar: car.triangles,
      formationRadius,
      parts: car.parts.map((part) => ({
        name: part.name,
        triangles: part.triangles,
        slot: part.slot,
      })),
    });
  }, [car, count, formationRadius, onStats]);

  useImperativeHandle(
    ref,
    () => ({
      count,
      setCar(index, position, quaternion) {
        if (index < 0 || index >= count) return;
        matrices[index].compose(position, quaternion, UNIT_SCALE);
      },
      commit() {
        for (const mesh of meshRefs.current) {
          if (!mesh) continue;
          for (let i = 0; i < count; i++) mesh.setMatrixAt(i, matrices[i]);
          mesh.instanceMatrix.needsUpdate = true;
          // Cars move, so the sphere that covers them has to be rebuilt. It is
          // one pass over `count` matrices — cheap next to letting culling go
          // stale and having the fleet blink out mid-lap.
          mesh.computeBoundingSphere();
        }
      },
    }),
    [count, matrices],
  );

  return (
    <group>
      {car.parts.map((part, index) => (
        <instancedMesh
          key={part.name}
          ref={(mesh) => attachPart(mesh, index)}
          args={[part.geometry, materials[index], count]}
          castShadow
        />
      ))}
    </group>
  );
});

export default CarFleet;
