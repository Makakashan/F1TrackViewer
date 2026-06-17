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
import type { CircuitGeoJSON } from "@/lib/f1-circuits";

export interface TrackViewerProps {
  geojson: CircuitGeoJSON;
  /** Per-point elevations in meters. Same indexing as `coords` (incl. closing
   * duplicate). If null/undefined, the track is rendered flat. */
  elevations?: number[] | null;
  /** Vertical exaggeration applied to elevation deltas. 1 = real scale. */
  elevationScale?: number;
  /** Radius of the track "tube" in meters. Defaults to 8. */
  trackWidth?: number;
  /** Auto-rotate the camera around the track. */
  autoRotate?: boolean;
  /** Show a small marker at the start/finish line. */
  showStartLine?: boolean;
}

/**
 * The actual track mesh — built once per `geojson` / `elevations` change.
 *
 * Uses CatmullRomCurve3 + TubeGeometry. This is the simplest "looks like a
 * 3D track" approach. We can upgrade to a proper ribbon mesh (centerline +
 * width-based normals) in MVP3 when we pull width data from TUMFTM.
 *
 * Elevation handling: if `elevations` is supplied, each curve point gets a
 * Y coordinate derived from (elevation - mean) * scale. The mean is subtracted
 * so tracks at high absolute altitude (Mexico, ~2000m) don't float far above
 * the ground plane — only the *relative* profile matters visually.
 */
function TrackMesh({
  geojson,
  trackWidth,
  elevations,
  elevationScale,
}: {
  geojson: CircuitGeoJSON;
  trackWidth: number;
  elevations?: number[] | null;
  elevationScale: number;
}) {
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates;

  const { curve, bounds, radius, peakY } = useMemo(() => {
    const b = computeBounds(coords);
    // Pass elevations as-is (same length as `coords`, including the closing
    // duplicate). buildTrackCurve strips the duplicate point internally — and
    // because both arrays share the same indexing, the per-point elevation
    // still lines up after the slice.
    const c = buildTrackCurve(coords, b, elevations ?? undefined, elevationScale);
    const r = sceneRadiusFromBounds(b);
    // Compute the max |Y| across the curve so we can size the ground plane
    // gap and the camera frustum.
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
      peak = Math.max(Math.abs(min - mean), Math.abs(max - mean)) * elevationScale;
    }
    return { curve: c, bounds: b, radius: r, peakY: peak };
  }, [coords, elevations, elevationScale]);

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

  // Centerline glow line — thin, brighter, slightly above the track surface.
  // Built by sampling the curve + offsetting each sample a touch up the local
  // "up" direction (curve normal projected to world Y) so the line reads as
  // painted on top of the asphalt rather than z-fighting through it.
  const centerlineGeometry = useMemo(() => {
    const N = 800;
    const points = curve.getPoints(N);
    // Slight upward offset so the line sits on top of the tube surface
    for (const p of points) p.y += trackWidth * 0.95;
    const g = new THREE.BufferGeometry().setFromPoints(points);
    return g;
  }, [curve, trackWidth]);

  // Start/finish line marker — small bar at the first point of the curve,
  // oriented perpendicular to the track direction.
  const startPoint = useMemo(() => curve.getPointAt(0), [curve]);
  const startTangent = useMemo(() => curve.getTangentAt(0), [curve]);
  const startQuaternion = useMemo(() => {
    // Use the full 3D tangent (including Y) so the bar stays aligned with the
    // track surface on hills. We rotate around the world Y axis only — good
    // enough for a small flat marker.
    const dir = new THREE.Vector3(startTangent.x, 0, startTangent.z).normalize();
    const angle = Math.atan2(dir.x, dir.z);
    return new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      angle,
    );
  }, [startTangent]);

  // Camera fit effect — when the curve or elevation changes, frame the whole
  // track including vertical extent.
  const { camera, controls } = useThree();
  useEffect(() => {
    // Use a wider distance when there's significant elevation, so the camera
    // doesn't end up inside a hill on hilly tracks like Spa.
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

  // Ground plane Y — sit a bit below the lowest curve point so the track
  // appears to "rise above" the ground rather than clipping through it.
  const groundY = -peakY - trackWidth * 2 - 1;

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
          opacity={0.7}
          linewidth={2}
        />
      </line>

      {/* Start/finish line — white bar with red emissive */}
      <mesh
        position={[startPoint.x, startPoint.y + trackWidth * 0.6, startPoint.z]}
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

      {/* Ground plane — subtle dark disc, follows track height */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY, 0]}>
        <circleGeometry args={[radius * 4, 64]} />
        <meshStandardMaterial color="#0a0a0d" roughness={1} metalness={0} />
      </mesh>

      {/* Concentric guide rings — purely cosmetic, gives a sense of scale */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY + 0.01, 0]}>
        <ringGeometry args={[radius * 1.6, radius * 1.62, 96]} />
        <meshBasicMaterial color="#1f1f24" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY + 0.02, 0]}>
        <ringGeometry args={[radius * 2.4, radius * 2.42, 96]} />
        <meshBasicMaterial color="#16161a" />
      </mesh>

      {/* Vertical reference pillars at each corner of the bbox — give a sense
          of elevation scale on hilly tracks. Skipped on flat ones. */}
      {peakY > trackWidth * 2 &&
        [
          [radius, radius],
          [-radius, radius],
          [radius, -radius],
          [-radius, -radius],
        ].map(([x, z], i) => (
          <mesh key={i} position={[x, 0, z]}>
            <boxGeometry args={[trackWidth * 0.3, peakY * 2, trackWidth * 0.3]} />
            <meshStandardMaterial
              color="#2a2a30"
              emissive="#ff1e1e"
              emissiveIntensity={0.15}
              roughness={0.7}
            />
          </mesh>
        ))}
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
  elevations,
  elevationScale = 3,
  trackWidth = 8,
  autoRotate = true,
  showStartLine = true,
}: TrackViewerProps) {
  return (
    <Canvas
      shadows={false} // shadows off — they were the main cause of flicker
      dpr={[1, 1.5]} // clamp pixel ratio; high-DPI jitter contributes to shimmer
      camera={{ fov: 50, near: 0.1, far: 200000, position: [400, 300, 400] }}
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
        // Lock tone mapping & color space explicitly — defaults sometimes
        // shift when the canvas is resized, which reads as flicker.
      }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
        gl.outputColorSpace = THREE.SRGBColorSpace;
      }}
      style={{ background: "linear-gradient(180deg, #0e0e12 0%, #050507 100%)" }}
    >
      {/* Lighting — three static lights, no environment map (env maps from
          drei's <Environment> can re-bake on resize and cause shimmer). */}
      <ambientLight intensity={0.45} />
      <hemisphereLight args={["#9bb4ff", "#1a1a1f", 0.5]} />
      <directionalLight position={[500, 800, 400]} intensity={1.6} />
      <directionalLight position={[-400, 300, -500]} intensity={0.4} color="#6b8cff" />

      <Suspense fallback={<SceneSpinner />}>
        <TrackMesh
          geojson={geojson}
          trackWidth={trackWidth}
          elevations={elevations}
          elevationScale={elevationScale}
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
  );
}
