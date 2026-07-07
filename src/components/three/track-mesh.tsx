"use client";

import { useMemo, useEffect, useCallback } from "react";
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

  const maxTerrainHeightNear = useCallback(
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
        const y = maxTerrainHeightNear(lon, lat) + TERRAIN_TRACK_OFFSET;
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
  }, [bounds, coords, elevations, hasEnvironment, maxTerrainHeightNear, terrainSampler]);

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

  useEffect(() => {
    const verticalFudge = 1 + Math.min(1, peakY / Math.max(radius, 1));
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

  return (
    <group>
      {hasEnvironment && (
        <EnvironmentLayer
          bundle={environmentBundle!}
          trackCoordinates={coords}
          originLon={bounds.centerLon}
          originLat={bounds.centerLat}
          baseY={terrainSampler ? 0 : groundY}
          showTerrain={environmentTerrain}
          resolvedTheme={resolvedTheme}
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
            <meshStandardMaterial
              key={realWidthActive ? "real-width-colors" : "solid-track"}
              vertexColors={realWidthActive}
              color={realWidthActive ? "#ffffff" : colors.trackColor}
              emissive={realWidthActive ? "#000000" : colors.trackEmissive}
              emissiveIntensity={realWidthActive ? 0 : colors.trackEmissiveIntensity}
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

      {!hasEnvironment && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, groundY - 0.5, 0]}
        >
          <circleGeometry args={[radius * 4, 64]} />
          <meshStandardMaterial
            color={colors.groundColor}
            roughness={1}
            metalness={0}
          />
        </mesh>
      )}

      {!hasEnvironment && (
        <>
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, groundY + 0.1, 0]}
          >
            <ringGeometry args={[radius * 1.6, radius * 1.62, 96]} />
            <meshBasicMaterial color={colors.ringColor1} />
          </mesh>
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, groundY + 0.2, 0]}
          >
            <ringGeometry args={[radius * 2.4, radius * 2.42, 96]} />
            <meshBasicMaterial color={colors.ringColor2} />
          </mesh>
        </>
      )}
    </group>
  );
}
