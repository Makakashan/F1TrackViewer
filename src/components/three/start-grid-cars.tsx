"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import CarFleet, { type CarFleetHandle } from "@/components/three/car-fleet";
import {
  carModelUrl,
  fetchCarLibrary,
  type CarModelEntry,
} from "@/lib/car-library";
import { startGridSlots } from "@/lib/start-grid";

export interface StartGridCarsProps {
  curve: THREE.CatmullRomCurve3;
  startFinishS: number;
  halfWidth: number;
  directionSign: 1 | -1;
  /** Y offset of the track surface, so the tyres sit on it rather than in it. */
  surfaceRaise: number;
  count?: number;
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
}: {
  url: string;
  slots: ReturnType<typeof startGridSlots>;
  surfaceRaise: number;
}) {
  const fleet = useRef<CarFleetHandle | null>(null);

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
  }, [slots, surfaceRaise, url]);

  return <CarFleet ref={fleet} url={url} count={slots.length} />;
}

/**
 * Twenty cars standing on the grid, one InstancedMesh per part.
 *
 * Placement comes from startGridSlots, the same source the painted boxes use,
 * so the cars are in their boxes by construction rather than by matching
 * numbers in two places.
 */
export default function StartGridCars({
  curve,
  startFinishS,
  halfWidth,
  directionSign,
  surfaceRaise,
  count,
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

  const slots = useMemo(
    () => startGridSlots(curve, startFinishS, halfWidth, directionSign, count),
    [curve, startFinishS, halfWidth, directionSign, count],
  );

  if (!url || slots.length === 0) return null;

  return (
    <Suspense fallback={null}>
      <GridFleet url={url} slots={slots} surfaceRaise={surfaceRaise} />
    </Suspense>
  );
}
