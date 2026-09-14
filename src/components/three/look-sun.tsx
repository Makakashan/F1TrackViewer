"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useLookLab } from "@/lib/look-lab";
import { DEFAULT_EXPOSURE } from "@/lib/scene-config";

/** Half the side of the shadow box: a helicopter frame and a margin round it. */
const SHADOW_EXTENT_M = 110;
const SUN_DISTANCE_M = 400;
const SHADOW_MAP_SIZE = 2048;

type Targeted = { target: THREE.Vector3 };

/**
 * The spike's light: sky fill and one sun whose shadow box rides along with what
 * the camera is looking at, so a single map stays sharp in the helicopter frame.
 */
export default function LookSun() {
  const light = useRef<THREE.DirectionalLight>(null);
  const controls = useThree((state) => state.controls) as Targeted | null;
  const get = useThree((state) => state.get);
  const invalidate = useThree((state) => state.invalidate);
  const azimuth = useLookLab((s) => s.sunAzimuthDeg);
  const elevation = useLookLab((s) => s.sunElevationDeg);
  const sunIntensity = useLookLab((s) => s.sunIntensity);
  const skyIntensity = useLookLab((s) => s.skyIntensity);
  const exposure = useLookLab((s) => s.exposure);
  const softness = useLookLab((s) => s.shadowSoftness);
  const normalBias = useLookLab((s) => s.shadowNormalBias);

  const direction = useMemo(() => {
    const az = THREE.MathUtils.degToRad(azimuth);
    const el = THREE.MathUtils.degToRad(elevation);
    return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  }, [azimuth, elevation]);

  useEffect(() => {
    const { gl } = get();
    gl.toneMappingExposure = exposure;
    invalidate();
    return () => {
      gl.toneMappingExposure = DEFAULT_EXPOSURE;
    };
  }, [get, exposure, invalidate]);

  useEffect(() => {
    const camera = light.current?.shadow.camera;
    if (!camera) return;
    camera.left = -SHADOW_EXTENT_M;
    camera.right = SHADOW_EXTENT_M;
    camera.top = SHADOW_EXTENT_M;
    camera.bottom = -SHADOW_EXTENT_M;
    camera.near = 1;
    camera.far = SUN_DISTANCE_M * 2;
    camera.updateProjectionMatrix();
  }, []);

  useEffect(() => {
    invalidate();
  }, [direction, sunIntensity, skyIntensity, softness, normalBias, invalidate]);

  useFrame(() => {
    const sun = light.current;
    if (!sun || !controls) return;
    sun.position.copy(controls.target).addScaledVector(direction, SUN_DISTANCE_M);
    sun.target.position.copy(controls.target);
    sun.target.updateMatrixWorld();
  });

  return (
    <>
      <hemisphereLight args={["#d6e6ff", "#5d564c", skyIntensity]} />
      <directionalLight
        ref={light}
        castShadow
        color="#fff3e0"
        intensity={sunIntensity}
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
        shadow-radius={softness}
        shadow-bias={-0.0003}
        shadow-normalBias={normalBias}
      />
    </>
  );
}
