"use client";

import { useMemo, useRef } from "react";
import { useCursor } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

export interface GlobeCircuit {
  id: string;
  name: string;
  shortName: string;
  country: string;
  lat: number;
  lon: number;
  type: string;
  hasEnvironment: boolean;
  hasTerrain: boolean;
}

interface GlobeMarkerProps {
  circuit: GlobeCircuit;
  radius: number;
  visualOffset?: {
    angle: number;
    magnitude: number;
  };
  selected: boolean;
  hovered: boolean;
  onHover: (circuit: GlobeCircuit) => void;
  onSelect: (circuit: GlobeCircuit) => void;
  onBlur: () => void;
}

export function latLonToVector3(lat: number, lon: number, radius: number) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);

  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);

  return new THREE.Vector3(x, y, z);
}

export default function GlobeMarker({
  circuit,
  radius,
  visualOffset,
  selected,
  hovered,
  onHover,
  onSelect,
  onBlur,
}: GlobeMarkerProps) {
  const active = selected || hovered;
  const groupRef = useRef<THREE.Group>(null);
  const centerMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  const redRingMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  const whiteRingMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  const haloMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  const pulseMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
  const hitRef = useRef<THREE.Mesh>(null);
  const worldPositionRef = useRef(new THREE.Vector3());
  const cameraDirectionRef = useRef(new THREE.Vector3());
  const { camera } = useThree();
  const position = useMemo(() => {
    const basePosition = latLonToVector3(circuit.lat, circuit.lon, radius);
    if (!visualOffset || visualOffset.magnitude <= 0) return basePosition;

    const surfaceNormal = basePosition.clone().normalize();
    const east = new THREE.Vector3(0, 1, 0).cross(surfaceNormal);
    if (east.lengthSq() < 0.0001) east.set(1, 0, 0);
    east.normalize();
    const north = surfaceNormal.clone().cross(east).normalize();
    const tangentOffset = east
      .multiplyScalar(Math.cos(visualOffset.angle) * visualOffset.magnitude)
      .add(
        north.multiplyScalar(
          Math.sin(visualOffset.angle) * visualOffset.magnitude,
        ),
      );

    return basePosition.add(tangentOffset).normalize().multiplyScalar(radius);
  }, [circuit.lat, circuit.lon, radius, visualOffset]);
  const normal = useMemo(() => position.clone().normalize(), [position]);
  const orientation = useMemo(() => {
    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    return quaternion;
  }, [normal]);

  useCursor(active);

  useFrame(({ clock }) => {
    if (
      !groupRef.current ||
      !centerMaterialRef.current ||
      !redRingMaterialRef.current ||
      !whiteRingMaterialRef.current ||
      !haloMaterialRef.current ||
      !pulseMaterialRef.current ||
      !pulseRef.current ||
      !hitRef.current
    ) {
      return;
    }

    const surfaceNormal =
      groupRef.current.getWorldPosition(worldPositionRef.current).normalize();
    const cameraDirection = cameraDirectionRef.current
      .copy(camera.position)
      .normalize();
    const facing = surfaceNormal.dot(cameraDirection);
    const horizonFade = THREE.MathUtils.smoothstep(facing, -0.06, 0.22);
    const opacity = active
      ? THREE.MathUtils.clamp(horizonFade, 0.2, 1)
      : horizonFade;

    groupRef.current.visible = opacity > 0.035;
    hitRef.current.visible = facing > -0.02;
    const selectedPulse = selected
      ? 1 + Math.sin(clock.elapsedTime * 5.2) * 0.06
      : 1;
    const pulseProgress = (Math.sin(clock.elapsedTime * 3.6) + 1) / 2;
    groupRef.current.scale.setScalar(selectedPulse);
    pulseRef.current.scale.setScalar(active ? 1.04 + pulseProgress * 0.38 : 1);
    centerMaterialRef.current.opacity = active ? opacity : opacity * 0.92;
    redRingMaterialRef.current.opacity = active ? opacity : opacity * 0.9;
    whiteRingMaterialRef.current.opacity = active ? opacity : opacity * 0.72;
    haloMaterialRef.current.opacity = active ? opacity * 0.36 : opacity * 0.1;
    pulseMaterialRef.current.opacity = active
      ? opacity * (0.28 - pulseProgress * 0.2)
      : 0;
  });

  return (
    <group ref={groupRef} position={position} quaternion={orientation}>
      <mesh position={[0, 0, 0.0004]}>
        <circleGeometry args={[active ? 0.058 : 0.041, 56]} />
        <meshBasicMaterial
          ref={haloMaterialRef}
          color={active ? "#ff3b32" : "#ffffff"}
          transparent
          opacity={0.12}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh ref={pulseRef} position={[0, 0, 0.0006]}>
        <ringGeometry args={[0.035, 0.041, 64]} />
        <meshBasicMaterial
          ref={pulseMaterialRef}
          color="#ffffff"
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(circuit);
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onBlur();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(circuit);
        }}
        position={[0, 0, 0.0008]}
      >
        <circleGeometry args={[active ? 0.031 : 0.024, 56]} />
        <meshBasicMaterial
          ref={whiteRingMaterialRef}
          color="#ffffff"
          transparent
          opacity={0.86}
          depthWrite={false}
        />
      </mesh>
      <mesh
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(circuit);
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onBlur();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(circuit);
        }}
        position={[0, 0, 0.001]}
      >
        <ringGeometry
          args={[
            active ? 0.015 : 0.011,
            active ? 0.024 : 0.018,
            56,
          ]}
        />
        <meshBasicMaterial
          ref={redRingMaterialRef}
          color="#f10800"
          transparent
          opacity={0.92}
          depthWrite={false}
        />
      </mesh>
      <mesh
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(circuit);
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onBlur();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(circuit);
        }}
        position={[0, 0, 0.0012]}
      >
        <circleGeometry args={[active ? 0.008 : 0.0062, 40]} />
        <meshBasicMaterial
          ref={centerMaterialRef}
          color="#f10800"
          transparent
          opacity={0.95}
          depthWrite={false}
        />
      </mesh>
      <mesh
        ref={hitRef}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(circuit);
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onBlur();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(circuit);
        }}
      >
        <sphereGeometry args={[0.095, 10, 10]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}
