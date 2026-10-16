"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import type * as THREE from "three";

type OrbitLike = THREE.EventDispatcher<{ change: object }> & { target: THREE.Vector3 };

/**
 * Hands where the camera looks to a label outside the canvas, so a screenshot
 * says where it was taken. The label is written straight into the DOM: the
 * controls fire every frame while they settle, and a render per frame is the cost.
 */
export default function CameraTargetReadout({ onChange }: { onChange: (target: THREE.Vector3) => void }) {
  const controls = useThree((state) => state.controls) as unknown as OrbitLike | null;

  useEffect(() => {
    if (!controls) return;
    const write = () => onChange(controls.target);
    write();
    controls.addEventListener("change", write);
    return () => controls.removeEventListener("change", write);
  }, [controls, onChange]);

  return null;
}
