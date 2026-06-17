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
  /** Half-width of the track ribbon in meters. Real F1 tracks are ~7-8m
   * wide each side, so default 7 = ~14m total. */
  trackWidth?: number;
  autoRotate?: boolean;
  resolvedTheme?: "light" | "dark";
}

/**
 * Build an extruded track mesh — top surface + side walls going all the way
 * down to a fixed ground Y. This produces a solid 3D-printed look instead
 * of a "floating ribbon".
 *
 * For each sample point on the curve:
 *   - Compute tangent T and side vector S (perpendicular to T, roughly horizontal)
 *   - Top-left  vertex = P + S * halfWidth, at the curve's Y (raised 0.5m)
 *   - Top-right vertex = P - S * halfWidth, at the curve's Y (raised 0.5m)
 *   - Bot-left  vertex = same X/Z as top-left, but Y = groundY
 *   - Bot-right vertex = same X/Z as top-right, but Y = groundY
 *
 * Indices:
 *   - Top surface: triangles between (topL_i, topR_i, topL_{i+1}, topR_{i+1})
 *   - Left wall:   triangles between (topL_i, botL_i, topL_{i+1}, botL_{i+1})
 *   - Right wall:  triangles between (topR_i, botR_i, topR_{i+1}, botR_{i+1})
 *
 * Normals are computed per-quad (flat shading) — good enough for a road
 * surface and much cheaper than smooth normals.
 *
 * Returns the BufferGeometry for the extruded mesh (top + walls together).
 */
function buildExtrudedTrack(
  curve: THREE.CatmullRomCurve3,
  halfWidth: number,
  topRaise: number,
  groundY: number,
  samples: number,
): THREE.BufferGeometry {
  const N = samples;
  // Sample N+1 points; the (N+1)-th equals the 1st because the curve is
  // closed — we keep it so the last quad connects back to the first.
  const pts = curve.getSpacedPoints(N);
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    tangents.push(curve.getTangentAt(i / N));
  }

  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const binorm = new THREE.Vector3();

  // 4 vertices per sample × (N+1) samples
  // Layout: [topL, topR, botL, botR] per sample
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  // Scratch vectors for normal computation per quad
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  function pushV(x: number, y: number, z: number, nx: number, ny: number, nz: number) {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  }

  function pushQuad(i1: number, i2: number, i3: number, i4: number) {
    // Two triangles: (i1, i3, i2) and (i2, i3, i4) — CCW winding for
    // outward-facing normal. We'll compute the normal from the actual
    // vertex positions and assign it to all 4 verts (flat shading).
    indices.push(i1, i3, i2, i2, i3, i4);
  }

  // First pass: compute and store 4 vertices per sample.
  for (let i = 0; i <= N; i++) {
    const p = pts[i];
    const t = tangents[i];

    side.crossVectors(t, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    binorm.crossVectors(side, t).normalize();

    const topY = p.y + topRaise;
    const lx = p.x + side.x * halfWidth;
    const lz = p.z + side.z * halfWidth;
    const rx = p.x - side.x * halfWidth;
    const rz = p.z - side.z * halfWidth;

    // topL, topR, botL, botR — normals will be patched in the second pass
    // per-quad (flat shading), so we set them to zero here just to fill
    // the buffer. The second pass overwrites the relevant vertices.
    pushV(lx, topY, lz, 0, 0, 0);
    pushV(rx, topY, rz, 0, 0, 0);
    pushV(lx, groundY, lz, 0, 0, 0);
    pushV(rx, groundY, rz, 0, 0, 0);
  }

  const stride = 4; // 4 verts per sample
  // Helper to access the Float32Array backing the position attribute
  // — we patch normals per quad using cross product of actual positions.
  const posAttr = positions; // we mutate via index lookups below

  function patchQuadNormal(
    i1: number, i2: number, i3: number, i4: number,
  ) {
    // Read positions
    a.set(posAttr[i1 * 3], posAttr[i1 * 3 + 1], posAttr[i1 * 3 + 2]);
    b.set(posAttr[i2 * 3], posAttr[i2 * 3 + 1], posAttr[i2 * 3 + 2]);
    c.set(posAttr[i3 * 3], posAttr[i3 * 3 + 1], posAttr[i3 * 3 + 2]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac).normalize();
    // Write back into the normals array
    for (const idx of [i1, i2, i3, i4]) {
      normals[idx * 3] = n.x;
      normals[idx * 3 + 1] = n.y;
      normals[idx * 3 + 2] = n.z;
    }
  }

  // Second pass: emit top + wall quads, patching normals per quad.
  for (let i = 0; i < N; i++) {
    const base0 = i * stride;       // topL_i, topR_i, botL_i, botR_i
    const base1 = (i + 1) * stride; // topL_{i+1}, ...
    const tL0 = base0 + 0;
    const tR0 = base0 + 1;
    const bL0 = base0 + 2;
    const bR0 = base0 + 3;
    const tL1 = base1 + 0;
    const tR1 = base1 + 1;
    const bL1 = base1 + 2;
    const bR1 = base1 + 3;

    // Top surface quad (CCW when viewed from above)
    pushQuad(tL0, tR0, tL1, tR1);
    patchQuadNormal(tL0, tR0, tL1, tR1);

    // Left wall — facing +side direction
    pushQuad(tL0, bL0, tL1, bL1);
    patchQuadNormal(tL0, bL0, tL1, bL1);

    // Right wall — facing -side direction
    pushQuad(tR1, bR1, tR0, bR0);
    patchQuadNormal(tR1, bR1, tR0, bR0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
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
    // buildTrackCurve now uses centripetal parametrization internally —
    // this prevents the "track jumps to a random far-away point" bug we
    // had on street circuits where GeoJSON samples cluster tightly around
    // hairpins (Monaco, Baku, Singapore, Jeddah).
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

  // Ground Y — sit a bit below the lowest curve point so the extrusion has
  // visible depth even on flat tracks.
  const groundY = useMemo(
    () => -peakY - trackWidth * 2 - 1,
    [peakY, trackWidth],
  );

  // Scale sample count with track length — longer tracks need more samples
  // to avoid polygonal look on high-speed sections.
  const samples = useMemo(() => {
    const length = feature.properties.length;
    return Math.max(400, Math.min(2000, Math.round(length / 4)));
  }, [feature.properties.length]);

  const trackGeometry = useMemo(
    () => buildExtrudedTrack(curve, trackWidth, 0.5, groundY, samples),
    [curve, trackWidth, groundY, samples],
  );

  useEffect(() => {
    return () => trackGeometry.dispose();
  }, [trackGeometry]);

  // Start/finish line marker
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

  // Theme-aware colors — asphalt track, neutral ground
  const isDark = resolvedTheme === "dark";
  const trackColor = isDark ? "#1a1a1f" : "#2a2a30";
  const groundColor = isDark ? "#0a0a0d" : "#d8d8dc";
  const ringColor1 = isDark ? "#1f1f24" : "#c4c4ca";
  const ringColor2 = isDark ? "#16161a" : "#cdcdd2";

  return (
    <group>
      {/* Extruded track — top surface + side walls in one geometry */}
      <mesh geometry={trackGeometry}>
        <meshStandardMaterial
          color={trackColor}
          roughness={0.92}
          metalness={0.05}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Start/finish line — white bar across the ribbon */}
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
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY - 0.1, 0]}>
        <circleGeometry args={[radius * 4, 64]} />
        <meshStandardMaterial color={groundColor} roughness={1} metalness={0} />
      </mesh>

      {/* Concentric guide rings */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY - 0.05, 0]}>
        <ringGeometry args={[radius * 1.6, radius * 1.62, 96]} />
        <meshBasicMaterial color={ringColor1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundY - 0.04, 0]}>
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
