"use client";

import { Suspense, useState, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { TrackWidthProfile } from "@/lib/track-width";
import type { StartFinishPlacement } from "@/lib/start-finish";
import type { CircuitGeoJSON } from "@/lib/f1-circuits";
import type { TrackMarkers, TrackViewMode } from "@/lib/track-markers";
import type { EnvironmentBundle } from "@/lib/environment-types";
import type { QualityMode } from "@/lib/url-state";
import PointerCaptureBoundary from "@/components/pointer-capture-boundary";
import TrackMesh from "@/components/three/track-mesh";
import { useIsMobile } from "@/hooks/use-mobile";
import { useStartFinishCalibration } from "@/hooks/use-start-finish-calibration";
import { canCreateWebGLContext, getSceneBackground } from "@/lib/scene-config";
import { computeBounds, sceneRadiusFromBounds } from "@/lib/geo-utils";
import CalibrationPanel from "@/components/three/calibration-panel";

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
  qualityMode?: QualityMode;
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
  qualityMode = "auto",
}: TrackViewerProps) {
  const [canvasEventSource, setCanvasEventSource] =
    useState<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const lowDetail =
    qualityMode === "performance" ? true : qualityMode === "quality" ? false : isMobile;
  const [webglAvailable] = useState(() =>
    typeof document === "undefined" ? true : canCreateWebGLContext(),
  );
  const circuitId = geojson.features[0]?.properties.id;
  const calibrationEnabled = startFinishCalibration;

  const [resolvedStartFinishS, setResolvedStartFinishS] = useState<
    number | null
  >(null);

  const calibration = useStartFinishCalibration(circuitId, resolvedStartFinishS);

  const { bgGradient, sceneBackgroundColor } = getSceneBackground(resolvedTheme);

  // Compute scene radius for dynamic camera limits (must match TrackMesh).
  const sceneRadius = useMemo(() => {
    const coords = geojson.features[0]?.geometry.coordinates;
    if (!coords) return 1000;
    return sceneRadiusFromBounds(computeBounds(coords));
  }, [geojson]);

  return (
    <PointerCaptureBoundary>
      <div ref={setCanvasEventSource} className="relative h-full w-full">
        {calibrationEnabled && circuitId && (
          <CalibrationPanel
            circuitId={circuitId}
            displayedS={calibration.displayedStartFinishS}
            currentMarkerExport={calibration.currentMarkerExport}
            allMarkerExport={calibration.allMarkerExport}
            onUpdate={calibration.updateCalibratedStartFinish}
            onReset={calibration.resetCalibratedStartFinish}
          />
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
              near: isMobile ? 8 : 2,
              far: 20000,
              position: [400, 300, 400],
            }}
            gl={{
              antialias: true,
              alpha: true,
              logarithmicDepthBuffer: true,
              powerPreference: "high-performance",
            }}
            onCreated={({ gl }) => {
              gl.toneMapping = THREE.ACESFilmicToneMapping;
              gl.toneMappingExposure = 1.05;
              gl.outputColorSpace = THREE.SRGBColorSpace;
              gl.setClearColor(sceneBackgroundColor, 0);
            }}
            style={{ background: bgGradient, touchAction: "none" }}
          >
            <ambientLight intensity={resolvedTheme === "dark" ? 0.42 : 0.55} />
            <hemisphereLight
              args={
                resolvedTheme === "dark"
                  ? ["#AFC2FF", "#07080C", 0.58]
                  : ["#AAB4D8", "#16181D", 0.48]
              }
            />
            <directionalLight
              position={[500, 800, 400]}
              intensity={resolvedTheme === "dark" ? 1.45 : 1.05}
            />
            <directionalLight
              position={[-400, 300, -500]}
              intensity={0.5}
              color="#7D9BFF"
            />
            <directionalLight
              position={[0, 260, -900]}
              intensity={0.55}
              color="#E10600"
            />

            <Suspense fallback={<SceneSpinner />}>
              <TrackMesh
                geojson={geojson}
                trackWidth={trackWidth}
                elevations={elevations}
                resolvedTheme={resolvedTheme}
                cameraPreset={cameraPreset}
                calibratedStartFinishS={calibration.calibratedStartFinishS}
                onStartFinishResolved={setResolvedStartFinishS}
                calibrationEnabled={calibrationEnabled}
                onCalibrateStartFinish={calibration.updateCalibratedStartFinish}
                onStartFinishPlacement={onStartFinishPlacement}
                viewMode={viewMode}
                markers={markers}
                environmentBundle={environmentBundle}
                environmentTerrain={environmentTerrain}
                widthProfile={widthProfile}
                realWidthEnabled={realWidthEnabled}
                lowDetail={lowDetail}
              />
            </Suspense>

            <OrbitControls
              makeDefault
              enableDamping
              dampingFactor={0.08}
              autoRotate={autoRotate}
              autoRotateSpeed={0.5}
              minDistance={sceneRadius * 0.4}
              maxDistance={sceneRadius * 4}
              minPolarAngle={Math.PI / 12}
              maxPolarAngle={Math.PI / 2.8}
            />
          </Canvas>
        ) : null}
      </div>
    </PointerCaptureBoundary>
  );
}
