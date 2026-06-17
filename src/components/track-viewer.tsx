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
  elevations?: number[] | null;
  elevationScale?: number;
  /** Half-width of the track ribbon in meters. Real F1 tracks are ~7–8m
   * wide each side, so default 7 = ~14m total. */
  trackWidth?: number;
  autoRotate?: boolean;
  /** Resolved theme — affects ribbon colors / ground tint. */
  resolvedTheme?: "light" | "dark";
}

/**
 * Build a flat ribbon mesh from a CatmullRomCurve3.
 *
 * For each sampled point on the curve we compute:
 *   - the tangent T (direction of travel)
 *   - the world-up vector U = (0, 1, 0)
 *   - the side vector S = normalize(cross(T, U)) — perpendicular to travel,
 *     lying roughly horizontal
 *   - the actual up vector B = cross(S, T) — perpendicular to travel AND
 *     to S, used as the surface normal
 *
 * Two vertices per sample (left side = +S, right side = -S), connected as
 * a triangle strip. The ribbon is raised `raise` meters above the curve to
 * avoid z-fighting with the ground plane on flat tracks.
 *
 * We also compute per-vertex normals so lighting works, and bake a thin
 * darker "kerb" strip along each edge for visual definition.
 *
 * Returns the ribbon BufferGeometry + a separate kerb line geometry.
 */
function buildRibbon(
  curve: THREE.CatmullRomCurve3,
  halfWidth: number,
  raise: number,
): {
  surface: THREE.BufferGeometry;
  kerbs: THREE.BufferGeometry;
  centerline: THREE.BufferGeometry;
} {
  const N = 800;
  const samples = curve.getSpacedPoints(N);
  // getSpacedPoints doesn't compute tangents — use getTangentAt with the
  // same normalized parameter range.
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    tangents.push(curve.getTangentAt(i / N));
  }
  // Close the loop: append first sample so the ribbon ends meet.
  samples.push(samples[0]);
  tangents.push(tangents[0]);

  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const binorm = new THREE.Vector3();

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const kerbPositions: number[] = [];
  const centerlinePositions: number[] = [];

  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const t = tangents[i];

    // Compute side vector. If tangent is nearly vertical (rare, but possible
    // on elevation cliffs), fall back to world X as the side direction.
    side.crossVectors(t, up);
    if (side.lengthSq() < 1e-6) {
      side.set(1, 0, 0);
    }
    side.normalize();
    binorm.crossVectors(side, t).normalize();

    // Centerline sample (slightly raised so it sits on top of the surface)
    centerlinePositions.push(
      p.x,
      p.y + raise + 0.05,
      p.z,
    );

    // Left edge (the sample point shifted by +side * halfWidth, plus a tiny
    // raise to lift off the ground)
    const lx = p.x + side.x * halfWidth;
    const ly = p.y + raise;
    const lz = p.z + side.z * halfWidth;
    // Right edge (-side)
    const rx = p.x - side.x * halfWidth;
    const ry = p.y + raise;
    const rz = p.z - side.z * halfWidth;

    positions.push(lx, ly, lz, rx, ry, rz);

    // Both vertices share the same normal (binormal) for flat shading
    normals.push(binorm.x, binorm.y, binorm.z, binorm.x, binorm.y, binorm.z);

    // UV: u goes 0..1 across the width (left=0, right=1), v goes 0..1 along
    // the length. v wraps because we want the texture to loop seamlessly on
    // a closed track.
    const v = i / N;
    uvs.push(0, v, 1, v);

    // Two triangles between this quad and the next one. Last quad (i==N)
    // connects back to i==0 — we handle that by NOT emitting the quad
    // indices for the closing sample, since samples[N+1] === samples[0].
    if (i < N) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }

    // Kerb lines — a thin strip just outside each edge, used for visual
    // definition. We offset by an extra ~5% of halfWidth so they peek out.
    const k = halfWidth * 1.06;
    kerbPositions.push(
      p.x + side.x * k, p.y + raise + 0.02, p.z + side.z * k,
      p.x - side.x * k, p.y + raise + 0.02, p.z - side.z * k,
    );
  }

  const surface = new THREE.BufferGeometry();
  surface.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  surface.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  surface.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  surface.setIndex(indices);

  const kerbs = new THREE.BufferGeometry();
  kerbs.setAttribute("position", new THREE.Float32BufferAttribute(kerbPositions, 3));

  const centerline = new THREE.BufferGeometry();
  centerline.setAttribute("position", new THREE.Float32BufferAttribute(centerlinePositions, 3));

  return { surface, kerbs, centerline };
}

function TrackMesh({
  geojson,
  trackWidth,
  elevations,
  elevationScale,
  resolvedTheme,
}: {
  geojson: CircuitGeoJSON;
  trackWidth: number;
  elevations?: number[] | null;
  elevationScale: number;
  resolvedTheme: "light" | "dark";
}) {
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates;

  const { curve, radius, peakY } = useMemo(() => {
    const b = computeBounds(coords);
    const c = buildTrackCurve(coords, b, elevations ?? undefined, elevationScale);
    const r = sceneRadiusFromBounds(b);
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
    return { curve: c, radius: r, peakY: peak };
  }, [coords, elevations, elevationScale]);

  const { surface, kerbs, centerline } = useMemo(
    () => buildRibbon(curve, trackWidth, 0.5),
    [curve, trackWidth],
  );

  // Cleanup geometries on unmount / re-build to avoid GPU memory leaks.
  useEffect(() => {
    return () => {
      surface.dispose();
      kerbs.dispose();
      centerline.dispose();
    };
  }, [surface, kerbs, centerline]);

  // Start/finish line marker at the first point of the curve
  const startPoint = useMemo(() => curve.getPointAt(0), [curve]);
  const startTangent = useMemo(() => curve.getTangentAt(0), [curve]);
  const startQuaternion = useMemo(() => {
    const dir = new THREE.Vector3(startTangent.x, 0, startTangent.z).normalize();
    const angle = Math.atan2(dir.x, dir.z);
    return new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      angle,
    );
  }, [startTangent]);

  // Camera fit — frame the whole track including vertical extent.
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

  const groundY = -peakY - trackWidth * 2 - 1;

  // Theme-aware colors
  const isDark = resolvedTheme === "dark";
  const trackColor = isDark ? "#1a1a1f" : "#2a2a30";
  const trackEmissive = isDark ? "#000000" : "#000000";
  const groundColor = isDark ? "#0a0a0d" : "#d8d8dc";
  const ringColor1 = isDark ? "#1f1f24" : "#c4c4ca";
  const ringColor2 = isDark ? "#16161a" : "#cdcdd2";

  return (
    <group>
      {/* Track surface — flat ribbon, dark asphalt */}
      <mesh geometry={surface}>
        <meshStandardMaterial
          color={trackColor}
          emissive={trackEmissive}
          emissiveIntensity={0}
          roughness={0.92}
          metalness={0.05}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Kerbs — thin red/white striped line along each edge. For now a
          single solid red line; can upgrade to actual stripe pattern later
          (e.g. via custom shader or texture). */}
      <lineSegments geometry={kerbs}>
        <lineBasicMaterial color="#e10600" />
      </lineSegments>

      {/* Centerline — thin white stripe on top of the surface */}
      <line geometry={centerline}>
        <lineBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.45}
        />
      </line>

      {/* Start/finish line — checkered-ish white bar across the ribbon */}
      <mesh
        position={[startPoint.x, startPoint.y + 0.6, startPoint.z]}
        quaternion={startQuaternion}
      >
        <boxGeometry args={[trackWidth * 2.4, 0.4, trackWidth * 0.4]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#ffffff"
          emissiveIntensity={0.3}
          roughness={0.4}
        />
      </mesh>

      {/* Ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY, 0]}>
        <circleGeometry args={[radius * 4, 64]} />
        <meshStandardMaterial color={groundColor} roughness={1} metalness={0} />
      </mesh>

      {/* Concentric guide rings */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY + 0.01, 0]}>
        <ringGeometry args={[radius * 1.6, radius * 1.62, 96]} />
        <meshBasicMaterial color={ringColor1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY + 0.02, 0]}>
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
  elevationScale = 3,
  trackWidth = 7,
  autoRotate = true,
  resolvedTheme = "dark",
}: TrackViewerProps) {
  const bgGradient =
    resolvedTheme === "dark"
      ? "linear-gradient(180deg, #0e0e12 0%, #050507 100%)"
      : "linear-gradient(180deg, #e8e8ec 0%, #c8c8cc 100%)";

  return (
    <Canvas
      shadows={false}
      dpr={[1, 1.5]}
      camera={{ fov: 50, near: 0.1, far: 200000, position: [400, 300, 400] }}
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
      style={{ background: bgGradient }}
    >
      <ambientLight intensity={resolvedTheme === "dark" ? 0.5 : 0.7} />
      <hemisphereLight
        args={resolvedTheme === "dark"
          ? ["#9bb4ff", "#1a1a1f", 0.5]
          : ["#b4c4ff", "#3a3a3f", 0.6]}
      />
      <directionalLight position={[500, 800, 400]} intensity={resolvedTheme === "dark" ? 1.6 : 1.2} />
      <directionalLight position={[-400, 300, -500]} intensity={0.4} color="#6b8cff" />

      <Suspense fallback={<SceneSpinner />}>
        <TrackMesh
          geojson={geojson}
          trackWidth={trackWidth}
          elevations={elevations}
          elevationScale={elevationScale}
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
  );
}
