"use client";

import { useMemo, useEffect, Suspense, useState, useCallback } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import {
  buildTrackCurveWithY,
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
  type HalfWidth,
} from "@/lib/track-geometry";
import { sampleWidthAt, type TrackWidthProfile } from "@/lib/track-width";
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
import type { EnvironmentBundle } from "@/lib/environment-types";
import { buildTerrainSampler } from "@/lib/terrain-sampler";
import PointerCaptureBoundary from "@/components/pointer-capture-boundary";
import EnvironmentLayer from "@/components/environment-layer";

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
  environmentBundle?: EnvironmentBundle | null;
  environmentTerrain?: boolean;
  widthProfile?: TrackWidthProfile | null;
  realWidthEnabled?: boolean;
}

const START_FINISH_STORAGE_KEY = "f1tv:start-finish-overrides:v1";
const TERRAIN_TRACK_OFFSET = 0.6;
const TERRAIN_TRACK_WALL_DEPTH = 0.8;

function disposeGeometry(value: unknown) {
  const disposable = value as { dispose?: unknown } | null | undefined;
  if (typeof disposable?.dispose === "function") {
    disposable.dispose();
  }
}

function canCreateWebGLContext(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!context) return false;
    const loseContext = (
      context as WebGLRenderingContext | WebGL2RenderingContext
    ).getExtension("WEBGL_lose_context");
    loseContext?.loseContext();
    return true;
  } catch {
    return false;
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
  environmentBundle,
  environmentTerrain,
  widthProfile,
  realWidthEnabled,
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
  environmentBundle?: EnvironmentBundle | null;
  environmentTerrain?: boolean;
  widthProfile?: TrackWidthProfile | null;
  realWidthEnabled?: boolean;
}) {
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates;
  const hasEnvironment = !!environmentBundle;

  // Real per-point track width (TUMFTM) vs. the uniform manual slider.
  // When active, the ribbon half-width varies along normalized arc length;
  // overlay markers use the mean half-width so they stay proportional.
  const realWidthActive = !!realWidthEnabled && !!widthProfile;
  const halfWidth = useMemo<HalfWidth>(() => {
    if (realWidthActive && widthProfile) {
      return (s: number) => sampleWidthAt(widthProfile, s) / 2;
    }
    return trackWidth;
  }, [realWidthActive, widthProfile, trackWidth]);
  const markerHalfWidth =
    realWidthActive && widthProfile
      ? widthProfile.meanWidthMeters / 2
      : trackWidth;

  const bounds = useMemo(() => computeBounds(coords), [coords]);

  const radius = useMemo(() => sceneRadiusFromBounds(bounds), [bounds]);

  const terrainSampler = useMemo(() => {
    if (!environmentBundle || !environmentTerrain || environmentBundle.terrain.gridSize < 2) {
      return null;
    }
    return buildTerrainSampler(environmentBundle.terrain, environmentBundle.manifest);
  }, [environmentBundle, environmentTerrain]);

  const { curve, peakY, minY } = useMemo(() => {
    if (terrainSampler) {
      let min = Infinity;
      let max = -Infinity;
      const c = buildTrackCurveWithY(coords, bounds, (lon, lat) => {
        const y = terrainSampler.heightAt(lon, lat) + TERRAIN_TRACK_OFFSET;
        if (y < min) min = y;
        if (y > max) max = y;
        return y;
      });
      return {
        curve: c,
        peakY: Math.max(Math.abs(min), Math.abs(max)),
        minY: Number.isFinite(min) ? min : 0,
      };
    }

    const renderedElevations = hasEnvironment
      ? undefined
      : (elevations ?? undefined);
    const c = buildTrackCurve(coords, bounds, renderedElevations, REAL_ELEVATION_SCALE);
    let peak = 0;
    let minCurveY = 0;
    if (renderedElevations && renderedElevations.length) {
      let min = Infinity,
        max = -Infinity,
        sum = 0;
      for (const e of renderedElevations) {
        if (e < min) min = e;
        if (e > max) max = e;
        sum += e;
      }
      const mean = sum / renderedElevations.length;
      peak = Math.max(Math.abs(min - mean), Math.abs(max - mean));
      minCurveY = min - mean;
    }
    return { curve: c, peakY: peak, minY: minCurveY };
  }, [bounds, coords, elevations, hasEnvironment, terrainSampler]);

  const groundY = useMemo(
    () => (hasEnvironment ? minY - 1 : -peakY - trackWidth * 2 - 1),
    [hasEnvironment, minY, peakY, trackWidth],
  );

  const samples = useMemo(() => {
    const length = feature.properties.length;
    return Math.max(400, Math.min(2000, Math.round(length / 4)));
  }, [feature.properties.length]);

  const widthColorAt = useMemo(() => {
    if (!realWidthActive || !widthProfile) return undefined;
    const narrow = new THREE.Color("#F59E0B");
    const wide = new THREE.Color("#22D3EE");
    const span = Math.max(
      0.01,
      widthProfile.maxWidthMeters - widthProfile.minWidthMeters,
    );
    return (s: number, target: THREE.Color) => {
      const normalized = THREE.MathUtils.clamp(
        (sampleWidthAt(widthProfile, s) - widthProfile.minWidthMeters) / span,
        0,
        1,
      );
      target.copy(narrow).lerp(wide, normalized);
    };
  }, [realWidthActive, widthProfile]);

  const trackGeometry = useMemo(
    () =>
      buildExtrudedTrack(
        curve,
        halfWidth,
        0.5,
        groundY,
        samples,
        terrainSampler ? TERRAIN_TRACK_WALL_DEPTH : undefined,
        widthColorAt,
      ),
    [curve, halfWidth, groundY, samples, terrainSampler, widthColorAt],
  );

  const outlineGeometry = useMemo(
    () => buildTrackOutline(curve, halfWidth, 0.5, samples),
    [curve, halfWidth, samples],
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
        markerHalfWidth,
        0.5,
      ),
    [curve, startFinishPlacement.s, markerHalfWidth],
  );

  const directionArrowGeometry = useMemo(
    () =>
      buildDirectionArrowGeometry(
        curve,
        startFinishPlacement.s,
        markerHalfWidth,
        0.5,
      ),
    [curve, startFinishPlacement.s, markerHalfWidth],
  );

  const startFinishGantryGeometry = useMemo(
    () =>
      buildStartFinishGantryGeometry(
        curve,
        startFinishPlacement.s,
        markerHalfWidth,
        0.5,
      ),
    [curve, startFinishPlacement.s, markerHalfWidth],
  );

  // ─── Sector geometries ────────────────────────────────────────────
  const showSectors = viewMode === "sectors" && markers?.sectors?.length;

  const sectorGeometries = useMemo(() => {
    if (!showSectors || !markers) return [];
    return markers.sectors.map((sector) =>
      buildSectorMesh(
        curve,
        sector,
        markers,
        halfWidth,
        0.5,
        groundY,
        samples,
        terrainSampler ? TERRAIN_TRACK_WALL_DEPTH : undefined,
      ),
    );
  }, [showSectors, curve, markers, halfWidth, groundY, samples, terrainSampler]);

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
          markerHalfWidth,
          0.5,
        ),
      );
  }, [showSectors, curve, markers, markerHalfWidth]);

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

  const isDark = resolvedTheme === "dark";
  const { camera, controls } = useThree();

  useEffect(() => {
    const verticalFudge = 1 + Math.min(1, peakY / Math.max(radius, 1));
    // When the diorama is on, pull the camera much further back so the whole
    // city fits in frame — the bbox is ~2700 m wide for Monaco vs. ~1000 m
    // for the track alone.
    const envMultiplier = hasEnvironment ? 2.6 : 2.4;
    const distance = radius * envMultiplier * verticalFudge;
    const yOffset = Math.max(radius * 0.3, peakY * 1.2);
    camera.position.set(distance, distance * 0.6 + yOffset, distance);
    camera.lookAt(0, 0, 0);
    if (controls && "target" in controls) {
      (controls as any).target.set(0, 0, 0);
      (controls as any).update?.();
    }
  }, [camera, controls, radius, peakY, hasEnvironment]);

  useEffect(() => {
    if (!cameraPreset) return;
    const envMultiplier = hasEnvironment ? 2.6 : 2.4;
    const distance = radius * envMultiplier;
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
  const trackColor = "#c10500";
  const trackEmissive = "#c10500";
  const trackEmissiveIntensity = 0.12;
  const outlineColor = isDark ? "#0a0a0d" : "#161a21";
  const groundColor = isDark ? "#0a0a0d" : "#fbfcfe";
  const ringColor1 = isDark ? "#1f1f24" : "#eef1f6";
  const ringColor2 = isDark ? "#16161a" : "#f5f7fb";
  const markerColor = isDark ? "#f5f5f5" : "#151820";
  const sectorEmissiveIntensity = isDark ? 0.15 : 0.035;
  const splitLineColor = isDark ? "#ffffff" : "#222936";

  return (
    <group>
      {/* Environment diorama shares the track coordinate origin so Monaco
          reads as one 3D scene instead of a floating overlay. */}
      {hasEnvironment && (
        <EnvironmentLayer
          bundle={environmentBundle!}
          trackCoordinates={coords}
          originLon={bounds.centerLon}
          originLat={bounds.centerLat}
          baseY={groundY}
          showTerrain={environmentTerrain}
          resolvedTheme={resolvedTheme}
        />
      )}

      <group>
      {/* Sector mode and width mode each replace the normal red top surface. */}
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
                emissiveIntensity={sectorEmissiveIntensity}
                roughness={0.5}
                metalness={0.05}
                side={THREE.DoubleSide}
                depthTest
                depthWrite
              />
            </mesh>
          ))}

          {/* Sector split lines */}
          {splitLineGeometries.map((geo, i) => (
            <mesh
              key={`split-${i}`}
              geometry={geo}
            >
              <meshBasicMaterial
                color={splitLineColor}
                side={THREE.DoubleSide}
                depthTest
                depthWrite
              />
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
              key={realWidthActive ? "real-width-colors" : "solid-track"}
              vertexColors={realWidthActive}
              color={realWidthActive ? "#ffffff" : trackColor}
              emissive={realWidthActive ? "#000000" : trackEmissive}
              emissiveIntensity={realWidthActive ? 0 : trackEmissiveIntensity}
              roughness={0.5}
              metalness={0.05}
              side={THREE.DoubleSide}
              depthTest
              depthWrite
            />
          </mesh>
        </>
      )}

      {/* Track outline — thin black lines along both top edges of the
          ribbon. Provides visual definition between track and ground. */}
      <lineSegments geometry={outlineGeometry}>
        <lineBasicMaterial
          color={outlineColor}
          depthTest
          depthWrite
        />
      </lineSegments>
      </group>

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
          color={markerColor}
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
          z-fighting with the guide rings. Hidden when the diorama is on. */}
      {!hasEnvironment && (
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
      )}

      {/* Concentric guide rings — sit clearly above the ground plane to
          avoid z-fighting flicker when the camera orbits. Hidden when the
          diorama is on so the city is the visual context. */}
      {!hasEnvironment && (
        <>
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
        </>
      )}
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
  environmentBundle,
  environmentTerrain = true,
  widthProfile,
  realWidthEnabled = true,
}: TrackViewerProps) {
  const [canvasEventSource, setCanvasEventSource] =
    useState<HTMLDivElement | null>(null);
  const [webglAvailable] = useState(() =>
    typeof document === "undefined" ? true : canCreateWebGLContext(),
  );
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
      : "linear-gradient(180deg, #f7f8fb 0%, #e7eaf0 100%)";
  const sceneBackgroundColor =
    resolvedTheme === "dark" ? "#020204" : "#f4f6fa";

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

        {webglAvailable === false ? (
          <div className="flex h-full w-full items-center justify-center bg-background px-6 text-center">
            <div className="max-w-sm rounded-md border border-border bg-card/60 p-4 shadow-sm">
              <div className="text-sm font-semibold text-foreground">
                WebGL is unavailable
              </div>
              <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
                This browser could not create a WebGL context. Enable WebGL or
                hardware acceleration in browser settings, lower browser
                shields for this site, or open the viewer in another browser.
              </div>
            </div>
          </div>
        ) : canvasEventSource ? (
          <Canvas
            eventSource={canvasEventSource}
            shadows={false}
            dpr={[1, 1.5]}
            camera={{
              fov: 50,
              near: 2,
              far: 20000,
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
            <color attach="background" args={[sceneBackgroundColor]} />
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
                environmentBundle={environmentBundle}
                environmentTerrain={environmentTerrain}
                widthProfile={widthProfile}
                realWidthEnabled={realWidthEnabled}
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
        ) : null}
      </div>
    </PointerCaptureBoundary>
  );
}
