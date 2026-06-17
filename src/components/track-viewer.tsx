"use client";

import { useMemo, useRef, useEffect, Suspense } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Environment, ContactShadows } from "@react-three/drei";
import * as THREE from "three";
import {
  buildTrackCurve,
  computeBounds,
  sceneRadiusFromBounds,
} from "@/lib/geo-utils";
import type { CircuitGeoJSON } from "@/lib/f1-circuits";

export interface TrackViewerProps {
  geojson: CircuitGeoJSON;
  /** Radius of the track "tube" in meters. Defaults to 8 (a touch narrower than a real 12-15m F1 track). */
  trackWidth?: number;
  /** Auto-rotate the camera around the track. */
  autoRotate?: boolean;
  /** Show a small marker at the start/finish line. */
  showStartLine?: boolean;
}

/**
 * The actual track mesh — built once per `geojson` change.
 *
 * Uses CatmullRomCurve3 + TubeGeometry. This is the simplest "looks like a
 * 3D track" approach: a tube laid flat on the ground. We can upgrade to a
 * proper ribbon mesh (centerline + width-based normals) in MVP3 when we
 * pull width data from TUMFTM/racetrack-database.
 */
function TrackMesh({
  geojson,
  trackWidth,
}: {
  geojson: CircuitGeoJSON;
  trackWidth: number;
}) {
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates;

  const { curve, bounds, radius } = useMemo(() => {
    const b = computeBounds(coords);
    const c = buildTrackCurve(coords, b);
    const r = sceneRadiusFromBounds(b);
    return { curve: c, bounds: b, radius: r };
  }, [coords]);

  const tubeGeometry = useMemo(() => {
    // Scale the tubular segments to track length so long tracks (Spa, Jeddah)
    // stay smooth without spending too many vertices on Monaco.
    const length = feature.properties.length;
    const tubularSegments = Math.max(200, Math.min(1500, Math.round(length)));
    return new THREE.TubeGeometry(
      curve,
      tubularSegments,
      trackWidth,
      8, // radial segments — octagon cross-section is plenty
      true,
    );
  }, [curve, trackWidth, feature.properties.length]);

  // Centerline glow line — thin, brighter, slightly above the track surface
  const centerlineGeometry = useMemo(() => {
    const points = curve.getPoints(600);
    const g = new THREE.BufferGeometry().setFromPoints(points);
    return g;
  }, [curve]);

  // Start/finish line marker — small red box at the first point of the curve
  const startPoint = useMemo(() => curve.getPointAt(0), [curve]);
  const startTangent = useMemo(() => curve.getTangentAt(0), [curve]);
  const startQuaternion = useMemo(() => {
    // Orient the box so its long axis is perpendicular to the track direction
    const dir = new THREE.Vector3(startTangent.x, 0, startTangent.z).normalize();
    const angle = Math.atan2(dir.x, dir.z);
    return new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      angle,
    );
  }, [startTangent]);

  // Camera fit effect — when the curve changes, pull the camera back so the
  // whole track is in frame.
  const { camera, controls } = useThree();
  useEffect(() => {
    const distance = radius * 2.4;
    camera.position.set(distance, distance * 0.7, distance);
    camera.lookAt(0, 0, 0);
    if (controls && "target" in controls) {
      (controls as any).target.set(0, 0, 0);
      (controls as any).update?.();
    }
  }, [camera, controls, radius]);

  return (
    <group>
      {/* Track surface — dark asphalt tube */}
      <mesh geometry={tubeGeometry} receiveShadow castShadow>
        <meshStandardMaterial
          color="#1c1c20"
          roughness={0.85}
          metalness={0.1}
        />
      </mesh>

      {/* Subtle centerline highlight — feels like racing line */}
      <line geometry={centerlineGeometry}>
        <lineBasicMaterial
          color="#ff4d4d"
          transparent
          opacity={0.65}
          linewidth={2}
        />
      </line>

      {/* Start/finish line — checkered-ish red bar */}
      <mesh
        position={[startPoint.x, trackWidth * 0.6, startPoint.z]}
        quaternion={startQuaternion}
      >
        <boxGeometry args={[trackWidth * 2.4, 0.4, trackWidth * 0.4]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#ff1e1e"
          emissiveIntensity={0.7}
          roughness={0.4}
        />
      </mesh>

      {/* Ground plane — subtle dark disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]}>
        <circleGeometry args={[radius * 4, 64]} />
        <meshStandardMaterial color="#0a0a0d" roughness={1} metalness={0} />
      </mesh>

      {/* Concentric guide rings — purely cosmetic, gives a sense of scale */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.49, 0]}>
        <ringGeometry args={[radius * 1.6, radius * 1.62, 96]} />
        <meshBasicMaterial color="#1f1f24" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.48, 0]}>
        <ringGeometry args={[radius * 2.4, radius * 2.42, 96]} />
        <meshBasicMaterial color="#16161a" />
      </mesh>
    </group>
  );
}

function SceneSpinner() {
  return (
    <mesh>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#ff1e1e" />
    </mesh>
  );
}

export default function TrackViewer({
  geojson,
  trackWidth = 8,
  autoRotate = true,
  showStartLine = true,
}: TrackViewerProps) {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ fov: 50, near: 0.1, far: 200000, position: [400, 300, 400] }}
      gl={{ antialias: true, alpha: false }}
      style={{ background: "linear-gradient(180deg, #0e0e12 0%, #050507 100%)" }}
    >
      <ambientLight intensity={0.35} />
      <directionalLight
        position={[500, 800, 400]}
        intensity={1.4}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={5000}
        shadow-camera-left={-1500}
        shadow-camera-right={1500}
        shadow-camera-top={1500}
        shadow-camera-bottom={-1500}
      />
      <hemisphereLight args={["#9bb4ff", "#1a1a1f", 0.4]} />

      <Suspense fallback={<SceneSpinner />}>
        <TrackMesh geojson={geojson} trackWidth={trackWidth} />
        <ContactShadows
          position={[0, -0.4, 0]}
          opacity={0.5}
          scale={5000}
          blur={2}
          far={1000}
          resolution={1024}
          color="#000000"
        />
        <Environment preset="night" />
      </Suspense>

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        autoRotate={autoRotate}
        autoRotateSpeed={0.6}
        minDistance={20}
        maxDistance={50000}
        maxPolarAngle={Math.PI / 2.05}
      />
    </Canvas>
  );
}
