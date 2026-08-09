"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import CarFleet, { type CarFleetHandle } from "@/components/three/car-fleet";
import {
  carModelUrl,
  fetchCarLibrary,
  type CarModelEntry,
} from "@/lib/cars/car-library";
import { TRACK_PROP_RENDER_ORDER } from "@/lib/scene-config";
import type { GridSlot } from "@/lib/race/start-grid";
import type { GridEntry } from "@/lib/race/f1-teams";
import { interpolateCarPose } from "@/lib/race/race-sim";
import type { RaceController } from "@/hooks/use-race-simulation";

/** Places a car on the track: how far round it is, how far off the centerline. */
export type PoseAt = (
  s: number,
  lateral: number,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
) => void;

export interface StartGridCarsProps {
  /** Where each car stands. */
  slots: GridSlot[];
  /** Y offset of the track surface, so the tyres sit on it rather than in it. */
  surfaceRaise: number;
  /** Livery per grid slot. */
  entries?: GridEntry[];
  /** The running race, if there is one. Without it the cars just stand. */
  raceSim?: RaceController | null;
  poseAt?: PoseAt;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Point a car along `forward`. */
function headingQuaternion(
  forward: THREE.Vector3,
  target: THREE.Quaternion,
): THREE.Quaternion {
  return target.setFromAxisAngle(UP, Math.atan2(forward.x, forward.z));
}

/** Pick the model the fleet is drawn from. */
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
  raceSim,
  poseAt,
}: {
  url: string;
  slots: GridSlot[];
  surfaceRaise: number;
  entries?: GridEntry[];
  raceSim?: RaceController | null;
  poseAt?: PoseAt;
}) {
  const fleet = useRef<CarFleetHandle | null>(null);
  const invalidate = useThree((state) => state.invalidate);
  const scratch = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  });

  const phase = raceSim?.phase;

  // Standing on the grid is a state the cars return to, not just the one they start in.
  useEffect(() => {
    const handle = fleet.current;
    if (!handle) return;
    if (phase && phase !== "standby") return;

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();

    slots.forEach((slot, index) => {
      if (index >= handle.count) return;
      position.copy(slot.position);
      // buildCarMesh puts the wheels at y=0, so the model sits on whatever Y it is given.
      position.y += surfaceRaise;
      handle.setCar(index, position, headingQuaternion(slot.forward, quaternion));
    });
    handle.commit();
    // Placing cars writes instance matrices directly, which r3f cannot see.
    invalidate();
  }, [slots, surfaceRaise, url, invalidate, phase]);

  // The race runs from here because this is where the frame clock is.
  useFrame((_, delta) => {
    if (!raceSim || !poseAt) return;
    raceSim.step(delta);

    const handle = fleet.current;
    const state = raceSim.stateRef.current;
    if (!handle || !state) return;
    if (raceSim.phase === "standby" || raceSim.phase === "lights") return;

    const alpha = raceSim.alphaRef.current;
    const { position, quaternion } = scratch.current;
    for (const car of state.cars) {
      if (car.index >= handle.count) continue;
      const pose = interpolateCarPose(car, alpha);
      poseAt(pose.s, pose.lateral, position, quaternion);
      position.y += surfaceRaise;
      handle.setCar(car.index, position, quaternion);
    }
    handle.commit();
  });

  return (
    <CarFleet
      ref={fleet}
      url={url}
      count={slots.length}
      grid={entries}
      renderOrder={TRACK_PROP_RENDER_ORDER}
    />
  );
}

/** Twenty cars standing on the grid, one InstancedMesh per part. */
export default function StartGridCars({
  slots,
  surfaceRaise,
  entries,
  raceSim,
  poseAt,
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
        // No manifest means the fleet was never generated; the track still renders, just without cars on it.
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
        raceSim={raceSim}
        poseAt={poseAt}
      />
    </Suspense>
  );
}
