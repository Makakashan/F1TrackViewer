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
  const dotMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  const outlineMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
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
      !dotMaterialRef.current ||
      !outlineMaterialRef.current ||
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
    groupRef.current.scale.setScalar(selectedPulse);
    dotMaterialRef.current.opacity = active ? opacity * 0.96 : opacity * 0.78;
    outlineMaterialRef.current.opacity = active ? opacity * 0.92 : opacity * 0.82;
  });

  return (
    <group ref={groupRef} position={position} quaternion={orientation}>
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
        <circleGeometry args={[active ? 0.022 : 0.017, 32]} />
        <meshBasicMaterial
          ref={outlineMaterialRef}
          color="#ffffff"
          transparent
          opacity={0.82}
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
        <circleGeometry args={[active ? 0.0175 : 0.0135, 32]} />
        <meshBasicMaterial
          ref={dotMaterialRef}
          color={selected ? "#ff1f18" : hovered ? "#ff2f28" : "#d90f0a"}
          transparent
          opacity={0.78}
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
