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

export function markerPositionForCircuit(
  circuit: Pick<GlobeCircuit, "lat" | "lon">,
  radius: number,
  visualOffset?: { angle: number; magnitude: number },
) {
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
}

const HIT_RADIUS = 0.12;
const COLOR_RED = 0xe10600;
const COLOR_WHITE = 0xffffff;

// One shared radial-gradient texture → smooth single falloff, no "double halo".
// White center fading to transparent edge. Material .color tints the glow.
let glowTextureCache: THREE.Texture | null = null;
function getGlowTexture(): THREE.Texture {
  if (glowTextureCache) return glowTextureCache;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    // Dim center (hidden behind the dot) → peak just outside the dot edge →
    // smooth fade to transparent. Avoids a bright "white border" at the dot
    // edge that a center-peaked gradient would produce.
    g.addColorStop(0.0, "rgba(255,255,255,0.06)");
    g.addColorStop(0.28, "rgba(255,255,255,0.1)");
    g.addColorStop(0.42, "rgba(255,255,255,0.42)");
    g.addColorStop(0.6, "rgba(255,255,255,0.16)");
    g.addColorStop(0.85, "rgba(255,255,255,0.03)");
    g.addColorStop(1.0, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  glowTextureCache = tex;
  return tex;
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
  const glowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const outlineMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
  const pulseMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hitRef = useRef<THREE.Mesh>(null);
  const worldPosRef = useRef(new THREE.Vector3());
  const camDirRef = useRef(new THREE.Vector3());
  const { camera } = useThree();

  const glowTexture = useMemo(() => getGlowTexture(), []);

  const position = useMemo(
    () => markerPositionForCircuit(circuit, radius, visualOffset),
    [circuit, radius, visualOffset],
  );

  const normal = useMemo(() => position.clone().normalize(), [position]);

  const orientation = useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    return q;
  }, [normal]);

  useCursor(active);

  useFrame(({ clock }) => {
    if (
      !groupRef.current ||
      !glowMatRef.current ||
      !outlineMatRef.current ||
      !coreMatRef.current ||
      !pulseRef.current ||
      !pulseMatRef.current ||
      !hitRef.current
    )
      return;

    const surfNormal = groupRef.current
      .getWorldPosition(worldPosRef.current)
      .normalize();
    const camDir = camDirRef.current.copy(camera.position).normalize();
    const facing = surfNormal.dot(camDir);
    const horizonFade = THREE.MathUtils.smoothstep(facing, -0.08, 0.25);
    const opacity = active
      ? THREE.MathUtils.clamp(horizonFade, 0.35, 1)
      : horizonFade;

    groupRef.current.visible = opacity > 0.03;
    hitRef.current.visible = facing > -0.02;

    const t = clock.elapsedTime;

    // Pulse ring — expanding radar wave, only for active markers
    if (active) {
      const cycle = (t * 1.3) % 1;
      const pulseScale = 1 + cycle * 2.2;
      const pulseOpacity = (1 - cycle) * (1 - cycle) * 0.6 * opacity;
      pulseRef.current.scale.setScalar(pulseScale);
      pulseMatRef.current.opacity = pulseOpacity;
      pulseRef.current.visible = pulseOpacity > 0.01;
    } else {
      pulseRef.current.visible = false;
    }

    if (selected) {
      const breathe = 1 + Math.sin(t * 2.4) * 0.1;
      groupRef.current.scale.setScalar(1.55 * breathe);

      // Red core + white outline — always. Active = much bigger + strong glow + pulse.
      coreMatRef.current.opacity = opacity;
      coreMatRef.current.color.setHex(COLOR_RED);

      outlineMatRef.current.opacity = opacity;
      outlineMatRef.current.color.setHex(COLOR_WHITE);

      glowMatRef.current.opacity = opacity * 1.6;
      glowMatRef.current.color.setHex(COLOR_RED);

      pulseMatRef.current.color.setHex(COLOR_WHITE);
    } else if (hovered) {
      groupRef.current.scale.setScalar(1.45);

      coreMatRef.current.opacity = opacity;
      coreMatRef.current.color.setHex(COLOR_RED);

      outlineMatRef.current.opacity = opacity;
      outlineMatRef.current.color.setHex(COLOR_WHITE);

      glowMatRef.current.opacity = opacity * 1.4;
      glowMatRef.current.color.setHex(COLOR_RED);

      pulseMatRef.current.color.setHex(COLOR_WHITE);
    } else {
      groupRef.current.scale.setScalar(1);

      // Default: red dot + white outline + soft red glow
      coreMatRef.current.opacity = opacity;
      coreMatRef.current.color.setHex(COLOR_RED);

      outlineMatRef.current.opacity = opacity * 0.9;
      outlineMatRef.current.color.setHex(COLOR_WHITE);

      glowMatRef.current.opacity = opacity * 0.7;
      glowMatRef.current.color.setHex(COLOR_RED);

      pulseMatRef.current.color.setHex(COLOR_WHITE);
    }
  });

  return (
    <group ref={groupRef} position={position} quaternion={orientation}>
      {/* Invisible hit sphere for raycasting / interaction */}
      <mesh
        ref={hitRef}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(circuit);
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          onBlur();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(circuit);
        }}
      >
        <sphereGeometry args={[HIT_RADIUS, 10, 10]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Single soft glow — radial-gradient texture, smooth falloff.
          Tiny z-offset keeps it glued to the surface (no floating at oblique angles). */}
      <mesh position={[0, 0, 0.0008]}>
        <planeGeometry args={[0.08, 0.08]} />
        <meshBasicMaterial
          ref={glowMatRef}
          map={glowTexture}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* White outline — thin ring just outside the dot edge for contrast
          against any terrain color. Sits below the dot so only the rim shows. */}
      <mesh position={[0, 0, 0.0014]}>
        <ringGeometry args={[0.015, 0.0185, 32]} />
        <meshBasicMaterial
          ref={outlineMatRef}
          transparent
          depthWrite={false}
        />
      </mesh>

      {/* Core dot — the precise location point */}
      <mesh position={[0, 0, 0.0018]}>
        <circleGeometry args={[0.015, 32]} />
        <meshBasicMaterial
          ref={coreMatRef}
          transparent
          depthWrite={false}
        />
      </mesh>

      {/* Pulse ring — animated expanding wave (active only) */}
      <mesh ref={pulseRef} position={[0, 0, 0.0012]}>
        <ringGeometry args={[0.022, 0.026, 48]} />
        <meshBasicMaterial
          ref={pulseMatRef}
          color={COLOR_WHITE}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}
