"use client";

import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { GridSlot } from "@/lib/start-grid";

export interface RaceCameraRigProps {
  slots: GridSlot[];
  /** Index into `slots` — which car the camera is on. */
  focusIndex: number;
}

/** How far ahead of the car the camera sits, and how high. ~18° above the road. */
const DISTANCE_M = 13;
const HEIGHT_M = 4.2;
/** Sideways offset, for a three-quarter view rather than a head-on one. */
const LATERAL_M = 5;
/** Aim a little above the floor — the car's body, not the tarmac under it. */
const TARGET_HEIGHT_M = 0.9;

/**
 * Puts the camera on a car, looking at it from the front quarter.
 *
 * It only moves the camera when the focused car changes, never per frame: the
 * user still owns the orbit, and a rig that re-asserted itself every frame
 * would fight them for the mouse. When the simulation lands, the same target
 * will simply start moving, and this becomes a chase camera without changing
 * shape.
 */
export default function RaceCameraRig({ slots, focusIndex }: RaceCameraRigProps) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | (THREE.EventDispatcher & { target: THREE.Vector3; update: () => void })
    | null;
  const invalidate = useThree((state) => state.invalidate);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const slot = slots[focusIndex];
    if (!slot || !controls) return;

    // Re-framing on every render would undo the user's own orbit; key on the
    // car and its position so a circuit change reframes but a re-render does
    // not.
    const key = `${focusIndex}:${slot.position.toArray().join(",")}`;
    if (lastKey.current === key) return;
    lastKey.current = key;

    const target = slot.position
      .clone()
      .addScaledVector(new THREE.Vector3(0, 1, 0), TARGET_HEIGHT_M);

    // Offset toward the centerline rather than the verge: the gantry posts and
    // the barriers live at the edges, and a camera set down beside one frames
    // the post instead of the car.
    camera.position
      .copy(slot.position)
      .addScaledVector(slot.forward, DISTANCE_M)
      .addScaledVector(slot.across, -slot.side * LATERAL_M)
      .addScaledVector(new THREE.Vector3(0, 1, 0), HEIGHT_M);
    camera.lookAt(target);

    controls.target.copy(target);
    controls.update();
    invalidate();
  }, [slots, focusIndex, camera, controls, invalidate]);

  return null;
}
