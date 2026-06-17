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
import PointerCaptureBoundary from "@/components/pointer-capture-boundary";

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
 * Smooth an elevation array with a simple 3-tap moving-average filter,
 * applied N times. The array is treated as a closed loop.
 *
 * Why: Open-Meteo returns SRTM-3 arcsec samples which have noticeable
 * per-sample jitter on tight street circuits. Smoothing kills the
 * residual "teeth" left after despiking.
 */
function smoothElevations(input: number[], passes: number = 3): number[] {
  if (input.length < 3) return input.slice();
  let cur = input.slice();
  const n = cur.length;
  for (let p = 0; p < passes; p++) {
    const next = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      next[i] = (a + b + c) / 3;
    }
    cur = next;
  }
  return cur;
}

/**
 * Despike elevation samples that are obvious API noise. Three cases we hit:
 *   1. Zero or near-zero elevation on a track that's clearly inland (the
 *      API sometimes returns 0 for coastal points instead of the real
 *      SRTM value — very visible on Monaco where some samples are 0 and
 *      others are 47+).
 *   2. Single-sample spikes where one point is 30+ meters off from both
 *      its neighbors.
 *   3. Negative elevations on tracks that are above sea level.
 *
 * Strategy:
 *   a) Compute the per-track median elevation M and the median absolute
 *      deviation (MAD). These are robust to outliers.
 *   b) Replace any sample <5 m on tracks whose median is >10 m (likely
 *      coastal API glitch) with M.
 *   c) Replace any sample that deviates from its 5-tap local median by
 *      more than max(threshold, 4 * MAD) meters with that local median.
 *
 * Two passes catch most artifacts. The array is treated as a closed loop.
 */
function despikeElevations(
  input: number[],
  threshold: number = 15,
  passes: number = 2,
): number[] {
  if (input.length < 5) return input.slice();
  let cur = input.slice();
  const n = cur.length;

  // Robust track-level stats — median and MAD
  const sortedAll = cur.slice().sort((a, b) => a - b);
  const globalMedian = sortedAll[Math.floor(n / 2)];
  const absDevs = cur
    .map((v) => Math.abs(v - globalMedian))
    .sort((a, b) => a - b);
  const mad = absDevs[Math.floor(n / 2)];
  const dynamicThreshold = Math.max(threshold, 4 * mad);

  // First: replace near-zero values on tracks that are clearly above sea
  // level (median > 10 m). These are coastal API glitches.
  if (globalMedian > 10) {
    cur = cur.map((v) => (v < 5 ? globalMedian : v));
  }

  // Then: median-filter spikes
  for (let p = 0; p < passes; p++) {
    const next = cur.slice();
    for (let i = 0; i < n; i++) {
      const window = [
        cur[(i - 2 + n) % n],
        cur[(i - 1 + n) % n],
        cur[i],
        cur[(i + 1) % n],
        cur[(i + 2) % n],
      ]
        .slice()
        .sort((a, b) => a - b);
      const localMedian = window[2];
      if (Math.abs(cur[i] - localMedian) > dynamicThreshold) {
        next[i] = localMedian;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Build an extruded track mesh — top surface + side walls going all the way
 * down to a fixed ground Y. This produces a solid 3D-printed look instead
 * of a "floating ribbon".
 *
 * For each sample point on the curve:
 *   - Compute tangent T and side vector S (perpendicular to T, roughly
 *     horizontal).
 *   - Top-left  vertex = P + S * halfWidth, at the curve's Y (raised 0.5 m)
 *   - Top-right vertex = P - S * halfWidth, at the curve's Y (raised 0.5 m)
 *   - Bot-left  vertex = same X/Z as top-left, but Y = groundY
 *   - Bot-right vertex = same X/Z as top-right, but Y = groundY
 *
 * Top surface, left wall, and right wall are emitted as triangle quads.
 * Normals are computed per-quad (flat shading) via on-the-fly cross product
 * of the actual vertex positions.
 */
function buildExtrudedTrack(
  curve: THREE.CatmullRomCurve3,
  halfWidth: number,
  topRaise: number,
  groundY: number,
  samples: number,
): THREE.BufferGeometry {
  const N = samples;
  const pts = curve.getSpacedPoints(N);
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    tangents.push(curve.getTangentAt(i / N));
  }

  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const binorm = new THREE.Vector3();

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  // Scratch vectors for per-quad normal computation
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  function pushV(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ) {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  }

  function pushQuad(i1: number, i2: number, i3: number, i4: number) {
    // Two triangles: (i1, i3, i2) and (i2, i3, i4)
    indices.push(i1, i3, i2, i2, i3, i4);
  }

  // First pass: 4 vertices per sample (topL, topR, botL, botR).
  // Normals are placeholders (zero) — patched per-quad in the second pass.
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

    pushV(lx, topY, lz, 0, 0, 0);
    pushV(rx, topY, rz, 0, 0, 0);
    pushV(lx, groundY, lz, 0, 0, 0);
    pushV(rx, groundY, rz, 0, 0, 0);
  }

  const stride = 4;

  function patchQuadNormal(
    i1: number,
    i2: number,
    i3: number,
    i4: number,
  ) {
    a.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    b.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
    c.set(positions[i3 * 3], positions[i3 * 3 + 1], positions[i3 * 3 + 2]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac).normalize();
    for (const idx of [i1, i2, i3, i4]) {
      normals[idx * 3] = n.x;
      normals[idx * 3 + 1] = n.y;
      normals[idx * 3 + 2] = n.z;
    }
  }

  // Second pass: emit top + wall quads, patching normals per quad.
  for (let i = 0; i < N; i++) {
    const base0 = i * stride;
    const base1 = (i + 1) * stride;
    const tL0 = base0 + 0;
    const tR0 = base0 + 1;
    const bL0 = base0 + 2;
    const bR0 = base0 + 3;
    const tL1 = base1 + 0;
    const tR1 = base1 + 1;
    const bL1 = base1 + 2;
    const bR1 = base1 + 3;

    // Top surface quad
    pushQuad(tL0, tR0, tL1, tR1);
    patchQuadNormal(tL0, tR0, tL1, tR1);

    // Left wall
    pushQuad(tL0, bL0, tL1, bL1);
    patchQuadNormal(tL0, bL0, tL1, bL1);

    // Right wall (winding reversed so the normal faces outward)
    pushQuad(tR1, bR1, tR0, bR0);
    patchQuadNormal(tR1, bR1, tR0, bR0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

/**
 * Build a line-segments geometry tracing both top edges of the ribbon —
 * the left edge (P + side * halfWidth) and the right edge (P - side * halfWidth)
 * at every sample. Used as a thin black outline on top of the red track
 * surface for visual definition.
 *
 * The geometry is laid out as a single lineSegments strip: pairs of
 * adjacent left-edge vertices form one segment, pairs of adjacent
 * right-edge vertices form another. Total: 2 * N segments = 4 * N vertices
 * (each segment needs two vertices).
 */
function buildTrackOutline(
  curve: THREE.CatmullRomCurve3,
  halfWidth: number,
  topRaise: number,
  samples: number,
): THREE.BufferGeometry {
  const N = samples;
  const pts = curve.getSpacedPoints(N);
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    tangents.push(curve.getTangentAt(i / N));
  }

  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();

  // Collect top-edge points (left + right) for each sample
  const leftPts: number[] = [];
  const rightPts: number[] = [];
  for (let i = 0; i <= N; i++) {
    const p = pts[i];
    const t = tangents[i];
    side.crossVectors(t, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const topY = p.y + topRaise;
    leftPts.push(p.x + side.x * halfWidth, topY, p.z + side.z * halfWidth);
    rightPts.push(p.x - side.x * halfWidth, topY, p.z - side.z * halfWidth);
  }

  // Build segment pairs: (left[i], left[i+1]) and (right[i], right[i+1])
  // for i in 0..N-1. Closed curve — last segment connects back to first.
  const positions: number[] = [];
  for (let i = 0; i < N; i++) {
    // Left segment
    positions.push(leftPts[i * 3], leftPts[i * 3 + 1], leftPts[i * 3 + 2]);
    positions.push(
      leftPts[(i + 1) * 3],
      leftPts[(i + 1) * 3 + 1],
      leftPts[(i + 1) * 3 + 2],
    );
    // Right segment
    positions.push(
      rightPts[i * 3],
      rightPts[i * 3 + 1],
      rightPts[i * 3 + 2],
    );
    positions.push(
      rightPts[(i + 1) * 3],
      rightPts[(i + 1) * 3 + 1],
      rightPts[(i + 1) * 3 + 2],
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
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

  // Despike + smooth the elevation samples before building the curve.
  // Despiking kills single-sample outliers (e.g. Open-Meteo returning 0
  // for coastal Monaco points where the real SRTM value is 30+); smoothing
  // kills the residual jitter between adjacent samples.
  const smoothedElevations = useMemo(() => {
    if (!elevations || elevations.length < 5) return elevations;
    return smoothElevations(despikeElevations(elevations, 15, 2), 3);
  }, [elevations]);

  const { curve, radius, peakY } = useMemo(() => {
    const b = computeBounds(coords);
    const c = buildTrackCurve(
      coords,
      b,
      smoothedElevations ?? undefined,
      elevationScale,
    );
    const r = sceneRadiusFromBounds(b);
    let peak = 0;
    if (smoothedElevations && smoothedElevations.length) {
      let min = Infinity,
        max = -Infinity,
        sum = 0;
      for (const e of smoothedElevations) {
        if (e < min) min = e;
        if (e > max) max = e;
        sum += e;
      }
      const mean = sum / smoothedElevations.length;
      peak =
        Math.max(Math.abs(min - mean), Math.abs(max - mean)) * elevationScale;
    }
    return { curve: c, radius: r, peakY: peak };
  }, [coords, smoothedElevations, elevationScale]);

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

  const startPoint = useMemo(() => curve.getPointAt(0), [curve]);
  const startTangent = useMemo(() => curve.getTangentAt(0), [curve]);
  const startQuaternion = useMemo(() => {
    const dir = new THREE.Vector3(
      startTangent.x,
      0,
      startTangent.z,
    ).normalize();
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

  // Track is F1 red on both themes — less neon than before (lower
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

      {/* Track outline — thin black lines running along both top edges of
          the ribbon. Built as a line strip from the same centerline + side
          vectors used by buildExtrudedTrack. Provides visual definition
          between the track and the ground/scene background. */}
      <lineSegments geometry={outlineGeometry}>
        <lineBasicMaterial color={outlineColor} />
      </lineSegments>

      {/* Ground plane */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, groundY - 0.1, 0]}
      >
        <circleGeometry args={[radius * 4, 64]} />
        <meshStandardMaterial
          color={groundColor}
          roughness={1}
          metalness={0}
        />
      </mesh>

      {/* Concentric guide rings */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, groundY - 0.05, 0]}
      >
        <ringGeometry args={[radius * 1.6, radius * 1.62, 96]} />
        <meshBasicMaterial color={ringColor1} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, groundY - 0.04, 0]}
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
    </PointerCaptureBoundary>
  );
}
