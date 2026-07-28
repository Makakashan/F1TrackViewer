"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import CarFleet, { type CarFleetHandle } from "@/components/three/car-fleet";
import {
  carModelUrl,
  fetchCarLibrary,
  type CarModelEntry,
} from "@/lib/car-library";
import type { GridSlot } from "@/lib/start-grid";
import type { GridEntry } from "@/lib/f1-teams";

export interface StartGridCarsProps {
  /**
   * Where each car stands. Computed by the caller rather than here, because
   * the camera rig has to look at the same positions — deriving them twice is
   * how a camera ends up aimed next to the car it is following.
   */
  slots: GridSlot[];
  /** Y offset of the track surface, so the tyres sit on it rather than in it. */
  surfaceRaise: number;
  /**
   * Livery per grid slot. Comes from the same running order the timing tower
   * renders, so the car on pole wears the colours of the driver listed P1.
   */
  entries?: GridEntry[];
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Point a car along `forward`.
 *
 * The normalized model's nose runs down +Z, so this is the Y rotation taking
 * +Z there. (car-fleet.tsx's default formation spaces its rows along X, which
 * looks like the opposite convention — that formation is a placeholder for the
 * admin preview and never claimed to face the cars anywhere in particular.)
 */
function headingQuaternion(
  forward: THREE.Vector3,
  target: THREE.Quaternion,
): THREE.Quaternion {
  return target.setFromAxisAngle(UP, Math.atan2(forward.x, forward.z));
}

/**
 * Pick the model the fleet is drawn from.
 *
 * One model serves the whole grid: liveries ride on instanceColor, so the
 * team a file was generated for doesn't matter. The simplified `_lod` build is
 * preferred — twenty full-detail cars are several times the triangle budget.
 */
function pickFleetModel(models: CarModelEntry[]): CarModelEntry | null {
  return (
    models.find((m) => m.id.startsWith("f1_") && m.id.endsWith("_lod")) ??
    models.find((m) => m.id.startsWith("f1_")) ??
    null
  );
}

function GridFleet({
  url,
  slots,
  surfaceRaise,
  entries,
}: {
  url: string;
  slots: GridSlot[];
  surfaceRaise: number;
  entries?: GridEntry[];
}) {
  const fleet = useRef<CarFleetHandle | null>(null);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const handle = fleet.current;
    if (!handle) return;

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();

    slots.forEach((slot, index) => {
      if (index >= handle.count) return;
      position.copy(slot.position);
      // buildCarMesh puts the wheels at y=0, so the model sits on whatever Y
      // it is given; the tyre radius is already accounted for by the mesh.
      position.y += surfaceRaise;
      handle.setCar(index, position, headingQuaternion(slot.forward, quaternion));
    });
    handle.commit();
    // Placing cars writes instance matrices directly, which r3f cannot see —
    // it only redraws on its own commits, and on demand that means a grid
    // filled after the last frame stays invisible until something else moves.
    invalidate();
  }, [slots, surfaceRaise, url, invalidate]);

  return (
    <CarFleet ref={fleet} url={url} count={slots.length} grid={entries} />
  );
}

/**
 * Twenty cars standing on the grid, one InstancedMesh per part.
 *
 * Placement comes from startGridSlots, the same source the painted boxes use,
 * so the cars are in their boxes by construction rather than by matching
 * numbers in two places.
 */
export default function StartGridCars({
  slots,
  surfaceRaise,
  entries,
}: StartGridCarsProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCarLibrary()
      .then((library) => {
        const model = pickFleetModel(library.models);
        if (!cancelled && model) setUrl(carModelUrl(model));
      })
      .catch(() => {
        // No manifest means the fleet was never generated; the track still
        // renders, just without cars on it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!url || slots.length === 0) return null;

  return (
    <Suspense fallback={null}>
      <GridFleet
        url={url}
        slots={slots}
        surfaceRaise={surfaceRaise}
        entries={entries}
      />
    </Suspense>
  );
}
