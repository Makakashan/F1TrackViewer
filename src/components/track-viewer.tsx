"use client";

import { useMemo, useEffect, Suspense, useState, useCallback } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import {
  buildTrackCurve,
  computeBounds,
  sceneRadiusFromBounds,
  REAL_ELEVATION_SCALE,
} from "@/lib/geo-utils";
import {
  buildExtrudedTrack,
  buildTrackOutline,
  buildSectorMesh,
  buildSectorSplitLineGeometry,
} from "@/lib/track-geometry";
import {
  buildDirectionArrowGeometry,
  buildStartFinishGantryGeometry,
  buildStartFinishGeometry,
  createCircuitMarkerSchema,
  findNearestCurveS,
  formatMarkerExport,
  resolveStartFinishPlacement,
  type StartFinishPlacement,
} from "@/lib/start-finish";
import type { CircuitGeoJSON } from "@/lib/f1-circuits";
import type { TrackMarkers, TrackViewMode } from "@/lib/track-markers";
import PointerCaptureBoundary from "@/components/pointer-capture-boundary";

export type CameraPreset = "top" | "iso" | "side" | "reset";

export interface TrackViewerProps {
  geojson: CircuitGeoJSON;
  elevations?: number[] | null;
  trackWidth?: number;
  autoRotate?: boolean;
  resolvedTheme?: "light" | "dark";
  cameraPreset?: CameraPreset | null;
  startFinishCalibration?: boolean;
  onStartFinishPlacement?: (placement: StartFinishPlacement) => void;
  viewMode?: TrackViewMode;
  markers?: TrackMarkers | null;
}

const START_FINISH_STORAGE_KEY = "f1tv:start-finish-overrides:v1";

function disposeGeometry(value: unknown) {
  const disposable = value as { dispose?: unknown } | null | undefined;
  if (typeof disposable?.dispose === "function") {
    disposable.dispose();
  }
}

function TrackMesh({
  geojson,
  trackWidth,
  elevations,
  resolvedTheme,
  cameraPreset,
  calibratedStartFinishS,
  onStartFinishResolved,
  calibrationEnabled,
  onCalibrateStartFinish,
  onStartFinishPlacement,
  viewMode,
  markers,
}: {
  geojson: CircuitGeoJSON;
  trackWidth: number;
  elevations?: number[] | null;
  resolvedTheme: "light" | "dark";
  cameraPreset?: CameraPreset | null;
  calibratedStartFinishS?: number | null;
  onStartFinishResolved?: (s: number) => void;
  calibrationEnabled?: boolean;
  onCalibrateStartFinish?: (s: number) => void;
  onStartFinishPlacement?: (placement: StartFinishPlacement) => void;
  viewMode: TrackViewMode;
  markers?: TrackMarkers | null;
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
      REAL_ELEVATION_SCALE,
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

  const startFinishPlacement = useMemo(
    () =>
      resolveStartFinishPlacement(
        feature.properties.id,
        curve,
        samples,
        calibratedStartFinishS,
      ),
    [feature.properties.id, curve, samples, calibratedStartFinishS],
  );

  useEffect(() => {
    onStartFinishResolved?.(startFinishPlacement.s);
    onStartFinishPlacement?.(startFinishPlacement);
  }, [onStartFinishPlacement, onStartFinishResolved, startFinishPlacement]);

  const startFinishGeometry = useMemo(
    () =>
      buildStartFinishGeometry(
        curve,
        startFinishPlacement.s,
        trackWidth,
        0.5,
      ),
    [curve, startFinishPlacement.s, trackWidth],
  );

  const directionArrowGeometry = useMemo(
    () =>
      buildDirectionArrowGeometry(
        curve,
        startFinishPlacement.s,
        trackWidth,
        0.5,
      ),
    [curve, startFinishPlacement.s, trackWidth],
  );

  const startFinishGantryGeometry = useMemo(
    () =>
      buildStartFinishGantryGeometry(
        curve,
        startFinishPlacement.s,
        trackWidth,
        0.5,
      ),
    [curve, startFinishPlacement.s, trackWidth],
  );

  // ─── Sector geometries ────────────────────────────────────────────
  const showSectors = viewMode === "sectors" && markers?.sectors?.length;

  // Debug: log sector rendering state
  useEffect(() => {
    console.log("[MVP2.5] showSectors:", showSectors, "viewMode:", viewMode, "markers:", markers?.circuitId, "sectors:", markers?.sectors?.length);
  }, [showSectors, viewMode, markers]);

  const sectorGeometries = useMemo(() => {
    if (!showSectors || !markers) return [];
    console.log("[MVP2.5] Building sector meshes, count:", markers.sectors.length);
    return markers.sectors.map((sector) =>
      buildSectorMesh(curve, sector, markers, trackWidth, 0.5, groundY, samples),
    );
  }, [showSectors, curve, markers, trackWidth, groundY, samples]);

  const splitLineGeometries = useMemo(() => {
    if (!showSectors || !markers) return [];
    // Split lines at the end of S1 and S2 (not at S3 end = start/finish)
    return markers.sectors
      .slice(0, -1)
      .map((sector) =>
        buildSectorSplitLineGeometry(
          curve,
          sector.toDistance,
          markers,
          trackWidth,
          0.5,
        ),
      );
  }, [showSectors, curve, markers, trackWidth]);

  // Separate cleanup effects so that sector geometry changes don't
  // dispose the stable track/outline/marker geometries (which would
  // wipe the very meshes we need when toggling back to normal mode).
  useEffect(() => {
    return () => {
      trackGeometry.dispose();
      outlineGeometry.dispose();
      startFinishGeometry.dispose();
      directionArrowGeometry.dispose();
      disposeGeometry(startFinishGantryGeometry.posts);
      disposeGeometry(startFinishGantryGeometry.beam);
    };
  }, [
    trackGeometry,
    outlineGeometry,
    startFinishGeometry,
    directionArrowGeometry,
    startFinishGantryGeometry,
  ]);

  useEffect(() => {
    return () => {
      sectorGeometries.forEach((g) => g.dispose());
      splitLineGeometries.forEach((g) => g.dispose());
    };
  }, [sectorGeometries, splitLineGeometries]);

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

  useEffect(() => {
    if (!cameraPreset) return;
    const distance = radius * 2.4;
    const yOffset = Math.max(radius * 0.3, peakY * 1.2);

    switch (cameraPreset) {
      case "top":
        camera.position.set(0, distance * 2, 0);
        break;
      case "iso":
        camera.position.set(distance, distance * 0.6 + yOffset, distance);
        break;
      case "side":
        camera.position.set(distance * 1.5, yOffset * 0.5, 0);
        break;
      case "reset":
        camera.position.set(distance, distance * 0.6 + yOffset, distance);
        break;
    }
    camera.lookAt(0, 0, 0);
    if (controls && "target" in controls) {
      (controls as any).target.set(0, 0, 0);
      (controls as any).update?.();
    }
  }, [cameraPreset, camera, controls, radius, peakY]);

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
      {/* Sector mode: colored sector meshes replace the single track mesh.
          In normal mode, the single red track mesh is shown. */}
      {showSectors ? (
        <>
          {markers!.sectors.map((sector, i) => (
            <mesh
              key={`sector-${sector.id}`}
              geometry={sectorGeometries[i]}
              onPointerDown={(event) => {
                if (!calibrationEnabled) return;
                event.stopPropagation();
                const nearestS = findNearestCurveS(curve, event.point, samples);
                onCalibrateStartFinish?.(nearestS);
              }}
            >
              <meshStandardMaterial
                color={sector.color}
                emissive={sector.color}
                emissiveIntensity={0.15}
                roughness={0.5}
                metalness={0.05}
                side={THREE.DoubleSide}
              />
            </mesh>
          ))}

          {/* Sector split lines */}
          {splitLineGeometries.map((geo, i) => (
            <mesh key={`split-${i}`} geometry={geo}>
              <meshBasicMaterial color="#FFFFFF" side={THREE.DoubleSide} />
            </mesh>
          ))}
        </>
      ) : (
        <>
          {/* Extruded track — top surface + side walls in one geometry.
              F1 red with emissive so it reads clearly on both themes. */}
          <mesh
            geometry={trackGeometry}
            onPointerDown={(event) => {
              if (!calibrationEnabled) return;
              event.stopPropagation();
              const nearestS = findNearestCurveS(curve, event.point, samples);
              onCalibrateStartFinish?.(nearestS);
            }}
          >
            <meshStandardMaterial
              color={trackColor}
              emissive={trackEmissive}
              emissiveIntensity={trackEmissiveIntensity}
              roughness={0.5}
              metalness={0.05}
              side={THREE.DoubleSide}
            />
          </mesh>
        </>
      )}

      {/* Track outline — thin black lines along both top edges of the
          ribbon. Provides visual definition between track and ground. */}
      <lineSegments geometry={outlineGeometry}>
        <lineBasicMaterial color={outlineColor} />
      </lineSegments>

      <mesh geometry={startFinishGeometry}>
        <meshBasicMaterial
          vertexColors
          side={THREE.DoubleSide}
          depthTest={false}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-4}
          polygonOffsetUnits={-4}
        />
      </mesh>

      <mesh geometry={directionArrowGeometry}>
        <meshBasicMaterial
          color="#f5f5f5"
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-5}
          polygonOffsetUnits={-5}
        />
      </mesh>

      <mesh geometry={startFinishGantryGeometry.posts}>
        <meshStandardMaterial
          color="#050507"
          emissive="#000000"
          emissiveIntensity={0}
          roughness={0.48}
          metalness={0.2}
        />
      </mesh>
      <mesh geometry={startFinishGantryGeometry.beam}>
        <meshStandardMaterial
          vertexColors
          roughness={0.42}
          metalness={0.12}
        />
      </mesh>

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
  cameraPreset = null,
  startFinishCalibration = false,
  onStartFinishPlacement,
  viewMode = "normal",
  markers,
}: TrackViewerProps) {
  const [canvasEventSource, setCanvasEventSource] =
    useState<HTMLDivElement | null>(null);
  const circuitId = geojson.features[0]?.properties.id;
  const [calibratedOverrides, setCalibratedOverrides] = useState<
    Record<string, number>
  >(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(START_FINISH_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [resolvedStartFinishS, setResolvedStartFinishS] = useState<
    number | null
  >(null);
  const calibrationEnabled = startFinishCalibration;

  const calibratedStartFinishS =
    circuitId && calibratedOverrides[circuitId] != null
      ? calibratedOverrides[circuitId]
      : null;

  const displayedStartFinishS =
    calibratedStartFinishS ?? resolvedStartFinishS ?? 0;
  const exportOverrides = useMemo(() => {
    if (!circuitId) return calibratedOverrides;
    return {
      ...calibratedOverrides,
      [circuitId]: Number(displayedStartFinishS.toFixed(5)),
    };
  }, [calibratedOverrides, circuitId, displayedStartFinishS]);
  const currentMarkerExport = useMemo(() => {
    if (!circuitId) return "";
    return JSON.stringify(
      createCircuitMarkerSchema(
        circuitId,
        displayedStartFinishS,
        true,
        calibratedStartFinishS != null
          ? "local admin calibration"
          : "current effective marker",
      ),
      null,
      2,
    );
  }, [calibratedStartFinishS, circuitId, displayedStartFinishS]);
  const allMarkerExport = useMemo(
    () => formatMarkerExport(exportOverrides),
    [exportOverrides],
  );

  const updateCalibratedStartFinish = useCallback(
    (s: number) => {
      if (!circuitId || typeof window === "undefined") return;
      const next = {
        ...calibratedOverrides,
        [circuitId]: Number(s.toFixed(5)),
      };
      setCalibratedOverrides(next);
      window.localStorage.setItem(
        START_FINISH_STORAGE_KEY,
        JSON.stringify(next),
      );
    },
    [calibratedOverrides, circuitId],
  );

  const resetCalibratedStartFinish = useCallback(() => {
    if (!circuitId || typeof window === "undefined") return;
    const next = { ...calibratedOverrides };
    delete next[circuitId];
    setCalibratedOverrides(next);
    window.localStorage.setItem(
      START_FINISH_STORAGE_KEY,
      JSON.stringify(next),
    );
  }, [calibratedOverrides, circuitId]);

  const bgGradient =
    resolvedTheme === "dark"
      ? "linear-gradient(180deg, #0e0e12 0%, #050507 100%)"
      : "linear-gradient(180deg, #e8e8ec 0%, #c8c8cc 100%)";

  return (
    <PointerCaptureBoundary>
      <div ref={setCanvasEventSource} className="relative h-full w-full">
        {calibrationEnabled && circuitId && (
          <div className="absolute left-4 top-4 z-20 max-h-[calc(100vh-2rem)] w-[min(360px,calc(100vw-2rem))] overflow-y-auto rounded-md border border-border/80 bg-background/90 p-3 text-xs shadow-lg backdrop-blur">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-foreground">
                  Start/finish calibration
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  {circuitId}: {displayedStartFinishS.toFixed(5)}
                </div>
              </div>
              <button
                type="button"
                onClick={resetCalibratedStartFinish}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Reset
              </button>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.0005}
              value={displayedStartFinishS}
              onChange={(event) =>
                updateCalibratedStartFinish(Number(event.target.value))
              }
              className="mt-3 h-1 w-full cursor-pointer accent-[#e10600]"
            />
            <div className="mt-2 rounded-sm bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
              "{circuitId}": {displayedStartFinishS.toFixed(5)}
            </div>
            <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Click the correct point on the track, then fine-tune with the
              slider if needed.
            </div>
            <div className="mt-3 space-y-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Current marker JSON
              </div>
              <textarea
                readOnly
                value={currentMarkerExport}
                className="h-28 w-full resize-none rounded-sm border border-border bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
              />
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Local overrides export
              </div>
              <textarea
                readOnly
                value={allMarkerExport}
                className="h-40 w-full resize-none rounded-sm border border-border bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
              />
            </div>
          </div>
        )}

        {canvasEventSource && (
          <Canvas
            eventSource={canvasEventSource}
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
                cameraPreset={cameraPreset}
                calibratedStartFinishS={calibratedStartFinishS}
                onStartFinishResolved={setResolvedStartFinishS}
                calibrationEnabled={calibrationEnabled}
                onCalibrateStartFinish={updateCalibratedStartFinish}
                onStartFinishPlacement={onStartFinishPlacement}
                viewMode={viewMode}
                markers={markers}
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
        )}
      </div>
    </PointerCaptureBoundary>
  );
}
