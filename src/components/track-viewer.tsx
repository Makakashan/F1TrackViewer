"use client";

import { useMemo, useEffect, Suspense } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import {
  buildTrackCurve,
  computeBounds,
  sceneRadiusFromBounds,
} from "@/lib/geo-utils";
import { buildExtrudedTrack, buildTrackOutline } from "@/lib/track-geometry";
import type { CircuitGeoJSON } from "@/lib/f1-circuits";
import PointerCaptureBoundary from "@/components/pointer-capture-boundary";

export interface TrackViewerProps {
  geojson: CircuitGeoJSON;
  elevations?: number[] | null;
  trackWidth?: number;
  autoRotate?: boolean;
  resolvedTheme?: "light" | "dark";
}

function TrackMesh({
  geojson,
  trackWidth,
  elevations,
  resolvedTheme,
}: {
  geojson: CircuitGeoJSON;
  trackWidth: number;
  elevations?: number[] | null;
  resolvedTheme: "light" | "dark";
}) {
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates;

  const radius = useMemo(() => {
    const b = computeBounds(coords);
    return sceneRadiusFromBounds(b);
  }, [coords]);

  const { curve, peakY } = useMemo(() => {
    const b = computeBounds(coords);
    const c = buildTrackCurve(
      coords,
      b,
      elevations ?? undefined,
      1,
    );
    let peak = 0;
    if (elevations && elevations.length) {
      let min = Infinity,
        max = -Infinity,
        sum = 0;
      for (const e of elevations) {
        if (e < min) min = e;
        if (e > max) max = e;
        sum += e;
      }
      const mean = sum / elevations.length;
      peak = Math.max(Math.abs(min - mean), Math.abs(max - mean));
    }
    return { curve: c, peakY: peak };
  }, [coords, elevations]);

  const groundY = useMemo(
    () => -peakY - trackWidth * 2 - 1,
    [peakY, trackWidth],
  );

  const samples = useMemo(() => {
    const length = feature.properties.length;
    return Math.max(400, Math.min(2000, Math.round(length / 4)));
  }, [feature.properties.length]);

  const trackGeometry = useMemo(
    () => buildExtrudedTrack(curve, trackWidth, 0.5, groundY, samples),
    [curve, trackWidth, groundY, samples],
  );

  const outlineGeometry = useMemo(
    () => buildTrackOutline(curve, trackWidth, 0.5, samples),
    [curve, trackWidth, samples],
  );

  useEffect(() => {
    return () => {
      trackGeometry.dispose();
      outlineGeometry.dispose();
    };
  }, [trackGeometry, outlineGeometry]);

  const { camera, controls } = useThree();
  useEffect(() => {
    const verticalFudge = 1 + Math.min(1, peakY / Math.max(radius, 1));
    const distance = radius * 2.4 * verticalFudge;
    const yOffset = Math.max(radius * 0.3, peakY * 1.2);
    camera.position.set(distance, distance * 0.6 + yOffset, distance);
    camera.lookAt(0, 0, 0);
    if (controls && "target" in controls) {
      (controls as any).target.set(0, 0, 0);
      (controls as any).update?.();
    }
  }, [camera, controls, radius, peakY]);

  // Track is F1 red on both themes — less neon than #e10600 (lower
  // emissiveIntensity + slightly darker base) so it doesn't burn the eyes.
  // Ground and rings are theme-dependent.
  const isDark = resolvedTheme === "dark";
  const trackColor = "#c10500";
  const trackEmissive = "#c10500";
  const trackEmissiveIntensity = 0.12;
  const outlineColor = "#0a0a0d";
  const groundColor = isDark ? "#0a0a0d" : "#d8d8dc";
  const ringColor1 = isDark ? "#1f1f24" : "#c4c4ca";
  const ringColor2 = isDark ? "#16161a" : "#cdcdd2";

  return (
    <group>
      {/* Extruded track — top surface + side walls in one geometry.
          F1 red with emissive so it reads clearly on both themes. */}
      <mesh geometry={trackGeometry}>
        <meshStandardMaterial
          color={trackColor}
          emissive={trackEmissive}
          emissiveIntensity={trackEmissiveIntensity}
          roughness={0.5}
          metalness={0.05}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Track outline — thin black lines along both top edges of the
          ribbon. Provides visual definition between track and ground. */}
      <lineSegments geometry={outlineGeometry}>
        <lineBasicMaterial color={outlineColor} />
      </lineSegments>

      {/* Ground plane — sits 0.5 m below the track's lowest point to avoid
          z-fighting with the guide rings. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, groundY - 0.5, 0]}
      >
        <circleGeometry args={[radius * 4, 64]} />
        <meshStandardMaterial
          color={groundColor}
          roughness={1}
          metalness={0}
        />
      </mesh>

      {/* Concentric guide rings — sit clearly above the ground plane to
          avoid z-fighting flicker when the camera orbits. Used to be at
          groundY - 0.05 / - 0.04 (1 cm apart) which caused shimmer. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, groundY + 0.1, 0]}
      >
        <ringGeometry args={[radius * 1.6, radius * 1.62, 96]} />
        <meshBasicMaterial color={ringColor1} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, groundY + 0.2, 0]}
      >
        <ringGeometry args={[radius * 2.4, radius * 2.42, 96]} />
        <meshBasicMaterial color={ringColor2} />
      </mesh>
    </group>
  );
}

function SceneSpinner() {
  return (
    <mesh>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#e10600" />
    </mesh>
  );
}

export default function TrackViewer({
  geojson,
  elevations,
  trackWidth = 7,
  autoRotate = true,
  resolvedTheme = "dark",
}: TrackViewerProps) {
  const bgGradient =
    resolvedTheme === "dark"
      ? "linear-gradient(180deg, #0e0e12 0%, #050507 100%)"
      : "linear-gradient(180deg, #e8e8ec 0%, #c8c8cc 100%)";

  return (
    <PointerCaptureBoundary>
      <Canvas
        shadows={false}
        dpr={[1, 1.5]}
        camera={{
          fov: 50,
          near: 0.1,
          far: 200000,
          position: [400, 300, 400],
        }}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
        }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.05;
          gl.outputColorSpace = THREE.SRGBColorSpace;
        }}
        style={{ background: bgGradient, touchAction: "none" }}
      >
        <ambientLight intensity={resolvedTheme === "dark" ? 0.5 : 0.7} />
        <hemisphereLight
          args={
            resolvedTheme === "dark"
              ? ["#9bb4ff", "#1a1a1f", 0.5]
              : ["#b4c4ff", "#3a3a3f", 0.6]
          }
        />
        <directionalLight
          position={[500, 800, 400]}
          intensity={resolvedTheme === "dark" ? 1.6 : 1.2}
        />
        <directionalLight
          position={[-400, 300, -500]}
          intensity={0.4}
          color="#6b8cff"
        />

        <Suspense fallback={<SceneSpinner />}>
          <TrackMesh
            geojson={geojson}
            trackWidth={trackWidth}
            elevations={elevations}
            resolvedTheme={resolvedTheme}
          />
        </Suspense>

        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          autoRotate={autoRotate}
          autoRotateSpeed={0.5}
          minDistance={20}
          maxDistance={50000}
          maxPolarAngle={Math.PI / 2.05}
        />
      </Canvas>
    </PointerCaptureBoundary>
  );
}
