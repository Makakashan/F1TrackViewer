"use client";

import { useMemo, useEffect, useCallback, useRef } from "react";
import { useThree } from "@react-three/fiber";
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
  findNearestCurveS,
  resolveStartFinishPlacement,
  type StartFinishPlacement,
} from "@/lib/start-finish";
import type { CircuitGeoJSON } from "@/lib/f1-circuits";
import type { TrackMarkers, TrackViewMode } from "@/lib/track-markers";
import type { EnvironmentBundle } from "@/lib/environment-types";
import { buildTerrainSampler } from "@/lib/terrain-sampler";
import EnvironmentLayer from "@/components/environment-layer";
import StudioStage from "@/components/three/studio-stage";
import type { CameraPreset } from "@/components/track-viewer";
import {
  TRACK_SURFACE_RAISE,
  TRACK_OVERLAY_RAISE,
  TRACK_RENDER_ORDER,
  TRACK_OVERLAY_RENDER_ORDER,
  TERRAIN_TRACK_OFFSET,
  TERRAIN_TRACK_CLEARANCE_SAMPLE_RADIUS_M,
  TERRAIN_TRACK_WALL_DEPTH,
  disposeGeometry,
  getSceneColors,
} from "@/lib/scene-config";

export interface TrackMeshProps {
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
  /** Reduces environment diorama detail (building count) for weaker devices. */
  lowDetail?: boolean;
}

export default function TrackMesh({
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
  lowDetail,
}: TrackMeshProps) {
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates;
  const hasEnvironment = !!environmentBundle;

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

  // Sample the max terrain height in a small neighbourhood so the track
  // ribbon never dips under a nearby terrain peak (flat-shaded triangles
  // can sit above the bilinear value).  Radius is kept small (12 m) to
  // avoid the floating look that the old 46 m radius caused.
  const terrainHeightNear = useCallback(
    (lon: number, lat: number): number => {
      if (!terrainSampler) return 0;
      const metersPerDegLat = 111_320;
      const metersPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
      const dLat = TERRAIN_TRACK_CLEARANCE_SAMPLE_RADIUS_M / metersPerDegLat;
      const dLon = TERRAIN_TRACK_CLEARANCE_SAMPLE_RADIUS_M / metersPerDegLon;
      let max = terrainSampler.heightAt(lon, lat);
      for (const [ox, oy] of [
        [dLon, 0],
        [-dLon, 0],
        [0, dLat],
        [0, -dLat],
        [dLon, dLat],
        [dLon, -dLat],
        [-dLon, dLat],
        [-dLon, -dLat],
      ] as const) {
        max = Math.max(max, terrainSampler.heightAt(lon + ox, lat + oy));
      }
      return max;
    },
    [terrainSampler],
  );

  const { curve, peakY, minY } = useMemo(() => {
    if (terrainSampler) {
      let min = Infinity;
      let max = -Infinity;
      const c = buildTrackCurveWithY(coords, bounds, (lon, lat) => {
        const y = terrainHeightNear(lon, lat) + TERRAIN_TRACK_OFFSET;
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
  }, [bounds, coords, elevations, hasEnvironment, terrainHeightNear, terrainSampler]);

  const groundY = useMemo(
    () => (hasEnvironment ? minY - 1 : -peakY - trackWidth * 2 - 1),
    [hasEnvironment, minY, peakY, trackWidth],
  );
  // In terrain mode the terrain bottom sits at baseY=0; place the stage floor
  // just below it to eliminate the visible gap between platform and scene.
  const stageFloorY = hasEnvironment
    ? terrainSampler
      ? -1
      : groundY - 2
    : groundY - 0.5;

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
        TRACK_SURFACE_RAISE,
        groundY,
        samples,
        terrainSampler ? TERRAIN_TRACK_WALL_DEPTH : undefined,
        widthColorAt,
      ),
    [curve, halfWidth, groundY, samples, terrainSampler, widthColorAt],
  );

  const outlineGeometry = useMemo(
    () => buildTrackOutline(curve, halfWidth, TRACK_OVERLAY_RAISE, samples),
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
        TRACK_OVERLAY_RAISE,
      ),
    [curve, startFinishPlacement.s, markerHalfWidth],
  );

  const directionArrowGeometry = useMemo(
    () =>
      buildDirectionArrowGeometry(
        curve,
        startFinishPlacement.s,
        markerHalfWidth,
        TRACK_OVERLAY_RAISE,
      ),
    [curve, startFinishPlacement.s, markerHalfWidth],
  );

  const startFinishGantryGeometry = useMemo(
    () =>
      buildStartFinishGantryGeometry(
        curve,
        startFinishPlacement.s,
        markerHalfWidth,
        TRACK_OVERLAY_RAISE,
      ),
    [curve, startFinishPlacement.s, markerHalfWidth],
  );

  const showSectors = viewMode === "sectors" && markers?.sectors?.length;

  const sectorGeometries = useMemo(() => {
    if (!showSectors || !markers) return [];
    return markers.sectors.map((sector) =>
      buildSectorMesh(
        curve,
        sector,
        markers,
        halfWidth,
        TRACK_SURFACE_RAISE,
        groundY,
        samples,
        terrainSampler ? TERRAIN_TRACK_WALL_DEPTH : undefined,
      ),
    );
  }, [showSectors, curve, markers, halfWidth, groundY, samples, terrainSampler]);

  const splitLineGeometries = useMemo(() => {
    if (!showSectors || !markers) return [];
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
  const colors = getSceneColors(isDark);
  const { camera, controls } = useThree();

  const cameraFraming = useCallback(
    (currentPeakY: number) => {
      const envMultiplier = hasEnvironment ? 2.6 : 2.4;
      return {
        baseDistance: radius * envMultiplier,
        yOffset: Math.max(radius * 0.3, currentPeakY * 1.2),
      };
    },
    [radius, hasEnvironment],
  );

  // Deliberately excludes `peakY` from the deps: peakY is recomputed whenever
  // the terrain toggle flips (same circuit, different elevation source), and
  // resetting the camera on that toggle would discard the user's orbit. It
  // only needs to reset when the circuit itself changes (tracked via radius
  // and hasEnvironment), reading the latest peakY via ref at that point.
  const peakYRef = useRef(peakY);
  useEffect(() => {
    peakYRef.current = peakY;
  });
  useEffect(() => {
    const currentPeakY = peakYRef.current;
    const verticalFudge = 1 + Math.min(1, currentPeakY / Math.max(radius, 1));
    const { baseDistance, yOffset } = cameraFraming(currentPeakY);
    const distance = baseDistance * verticalFudge;
    camera.position.set(distance, distance * 0.6 + yOffset, distance);
    camera.lookAt(0, 0, 0);
    if (controls && "target" in controls) {
      (controls as any).target.set(0, 0, 0);
      (controls as any).update?.();
    }
  }, [camera, controls, radius, cameraFraming]);

  // Excludes `peakY` from the deps for the same reason as above: cameraPreset
  // persists (it's URL state, not a one-shot trigger), so reacting to peakY
  // here would re-snap the camera on every terrain toggle once any preset had
  // ever been clicked.
  useEffect(() => {
    if (!cameraPreset) return;
    const { baseDistance: distance, yOffset } = cameraFraming(peakYRef.current);

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
  }, [cameraPreset, camera, controls, cameraFraming]);

  return (
    <group>
      {!hasEnvironment && (
        <StudioStage
          radius={radius}
          floorY={stageFloorY}
          hasEnvironment={hasEnvironment}
          resolvedTheme={resolvedTheme}
        />
      )}

      {hasEnvironment && (
        <EnvironmentLayer
          bundle={environmentBundle!}
          trackCoordinates={coords}
          originLon={bounds.centerLon}
          originLat={bounds.centerLat}
          baseY={terrainSampler ? 0 : groundY}
          showTerrain={environmentTerrain}
          resolvedTheme={resolvedTheme}
          lowDetail={lowDetail}
        />
      )}

      <group>
      {showSectors ? (
        <>
          {markers!.sectors.map((sector, i) => (
            <mesh
              key={`sector-${sector.id}`}
              geometry={sectorGeometries[i]}
              renderOrder={TRACK_RENDER_ORDER}
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
                emissiveIntensity={colors.sectorEmissiveIntensity}
                roughness={0.5}
                metalness={0.05}
                side={THREE.DoubleSide}
                depthTest
                depthWrite
                polygonOffset
                polygonOffsetFactor={-2}
                polygonOffsetUnits={-2}
              />
            </mesh>
          ))}

          {splitLineGeometries.map((geo, i) => (
            <mesh
              key={`split-${i}`}
              geometry={geo}
              renderOrder={TRACK_OVERLAY_RENDER_ORDER}
            >
              <meshBasicMaterial
                color={colors.splitLineColor}
                side={THREE.DoubleSide}
                depthTest
                depthWrite
              />
            </mesh>
          ))}
        </>
      ) : (
        <>
          <mesh
            geometry={trackGeometry}
            renderOrder={TRACK_RENDER_ORDER}
            onPointerDown={(event) => {
              if (!calibrationEnabled) return;
              event.stopPropagation();
              const nearestS = findNearestCurveS(curve, event.point, samples);
              onCalibrateStartFinish?.(nearestS);
            }}
          >
            <meshBasicMaterial
              key={realWidthActive ? "real-width-colors" : "solid-track"}
              vertexColors={realWidthActive}
              color={realWidthActive ? "#ffffff" : colors.trackColor}
              side={THREE.DoubleSide}
              depthTest
              depthWrite
              polygonOffset
              polygonOffsetFactor={-2}
              polygonOffsetUnits={-2}
              toneMapped={false}
            />
          </mesh>
        </>
      )}

      <lineSegments geometry={outlineGeometry} renderOrder={TRACK_OVERLAY_RENDER_ORDER}>
        <lineBasicMaterial
          color={colors.outlineColor}
          depthTest
          depthWrite={false}
        />
      </lineSegments>
      </group>

      <mesh geometry={startFinishGeometry} renderOrder={TRACK_OVERLAY_RENDER_ORDER}>
        <meshBasicMaterial
          vertexColors
          side={THREE.DoubleSide}
          depthTest
          depthWrite={false}
        />
      </mesh>

      <mesh geometry={directionArrowGeometry} renderOrder={TRACK_OVERLAY_RENDER_ORDER}>
        <meshBasicMaterial
          color={colors.markerColor}
          side={THREE.DoubleSide}
          depthTest
          depthWrite={false}
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

    </group>
  );
}
