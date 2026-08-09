"use client";

import { useMemo, useEffect, useCallback, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  buildTrackCurveWithY,
  buildTrackCurve,
  computeBounds,
  densifyCoords,
  lonLatToXZ,
  sceneRadiusFromBounds,
  stripClosingDuplicate,
  xzToLonLat,
  REAL_ELEVATION_SCALE,
} from "@/lib/geo-utils";
import { smoothTerrainTrackProfile } from "@/lib/track/elevation";
import {
  buildExtrudedTrack,
  buildTrackOutline,
  buildSectorMesh,
  buildSectorSplitLineGeometry,
  type HalfWidth,
} from "@/lib/track/track-geometry";
import { sampleWidthAt, type TrackWidthProfile } from "@/lib/track/track-width";
import {
  buildKerbGeometry,
  buildTrackEdgeLineGeometry,
} from "@/lib/track/track-kerbs";
import {
  APRON_GROUND_TOLERANCE_M,
  buildTrackApronGeometry,
  buildFootprintIndex,
  sampleApronRoom,
  type ApronClearance,
} from "@/lib/track/track-apron";
import { buildStartGridGeometry, startGridSlots } from "@/lib/race/start-grid";
import StartGridCars from "@/components/three/start-grid-cars";
import RaceCameraRig from "@/components/three/race-camera-rig";
import type { GridEntry } from "@/lib/race/f1-teams";
import { START_LIGHT_ROWS } from "@/lib/race/start-lights";
import {
  buildStartFinishGantryGeometry,
  buildStartFinishGeometry,
  buildStartLineGeometry,
  findNearestCurveS,
  resolveStartFinishPlacement,
  type StartFinishPlacement,
} from "@/lib/track/start-finish";
import { buildStartLightsGeometry } from "@/lib/race/start-lights";
import { buildSpeedProfile } from "@/lib/race/speed-profile";
import { buildRacingLine } from "@/lib/track/racing-line";
import { halfWidthAt } from "@/lib/track/track-geometry";
import type { RaceController } from "@/hooks/use-race-simulation";
import type { CircuitGeoJSON } from "@/lib/f1-circuits";
import {
  MARKER_COLORS,
  type TrackMarkers,
  type TrackViewMode,
} from "@/lib/track/track-markers";
import type { EnvironmentBundle } from "@/lib/env/environment-types";
import { buildTerrainSampler } from "@/lib/env/terrain-sampler";
import EnvironmentLayer from "@/components/three/environment-layer";
import StudioStage from "@/components/three/studio-stage";
import type { CameraPreset } from "@/components/track/track-viewer";
import {
  TRACK_SURFACE_RAISE,
  TRACK_PAINT_RAISE,
  TRACK_OVERLAY_RAISE,
  TRACK_RENDER_ORDER,
  TRACK_OVERLAY_RENDER_ORDER,
  TRACK_PROP_RENDER_ORDER,
  TERRAIN_TRACK_OFFSET,
  TERRAIN_TRACK_MAX_SEGMENT_M,
  TERRAIN_TRACK_SMOOTH_RADIUS_M,
  TERRAIN_TRACK_WALL_DIG_M,
  TERRAIN_TRACK_MIN_WALL_M,
  disposeGeometry,
  getSceneColors,
} from "@/lib/scene-config";

/** Asphalt in race view. Warm-neutral rather than pure grey, which reads blue. */
const ASPHALT_COLOR = "#3a3a3d";

/** An unlit start lamp — a dark lens against the black panel, not a hole in it. */
const LAMP_OFF_COLOR = "#4a1c20";
/** Lit: brighter than any red in the scene, so it reads as a light source. */
const LAMP_ON_COLOR = "#ff2318";

const UP = new THREE.Vector3(0, 1, 0);

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
  /** Race view only: which grid slot the camera sits on. */
  focusIndex?: number;
  /** Race view only: how many start light columns are lit, 0–5. */
  startLightsLit?: number;
  /** Race view only: livery per grid slot, in running order. */
  gridEntries?: GridEntry[];
  /** Race view only: the running simulation, if there is one. */
  raceSim?: RaceController | null;
  /** Seeds the race. */
  raceSeed?: string;
  /** Race view only: race distance in laps. */
  raceLaps?: number;
  /** Race view only: chase camera on, or free camera. */
  cameraFollow?: boolean;
  /** Race view only: the user took the camera. */
  onCameraDetach?: () => void;
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
  focusIndex = 0,
  startLightsLit = 0,
  gridEntries,
  raceSim,
  raceSeed,
  raceLaps = 1,
  cameraFollow,
  onCameraDetach,
}: TrackMeshProps) {
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates;
  const hasEnvironment = !!environmentBundle;

  // Race view is the "what it actually looks like" mode.
  const raceView = viewMode === "realistic";

  const realWidthActive = (raceView || !!realWidthEnabled) && !!widthProfile;
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

  const trackTerrainHeightNear = useCallback(
    (lon: number, lat: number): number => terrainSampler?.heightAt(lon, lat) ?? 0,
    [terrainSampler],
  );

  /** Closes the ribbon's side wall in the ground rather than at a fixed depth. */
  const trackSkirtBottom = useMemo(() => {
    if (!terrainSampler) return undefined;
    const { centerLon, centerLat } = bounds;
    return (x: number, z: number, topY: number) => {
      const [lon, lat] = xzToLonLat(x, z, centerLon, centerLat);
      const ground = terrainSampler.heightAt(lon, lat) - TERRAIN_TRACK_WALL_DIG_M;
      return Math.min(ground, topY - TERRAIN_TRACK_MIN_WALL_M);
    };
  }, [terrainSampler, bounds]);

  const { curve, peakY, minY } = useMemo(() => {
    if (terrainSampler) {
      let min = Infinity;
      let max = -Infinity;
      const denseCoords = densifyCoords(coords, TERRAIN_TRACK_MAX_SEGMENT_M);
      // Smooth the raw per-vertex terrain heights before they become curve Y.
      const profileCoords = stripClosingDuplicate(denseCoords);
      const rawY = profileCoords.map(([lon, lat]) =>
        trackTerrainHeightNear(lon, lat),
      );
      const smoothedY = smoothTerrainTrackProfile(
        rawY,
        profileCoords,
        TERRAIN_TRACK_SMOOTH_RADIUS_M,
      );
      const c = buildTrackCurveWithY(denseCoords, bounds, (_lon, _lat, i) => {
        const y = smoothedY[i] + TERRAIN_TRACK_OFFSET;
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
  }, [bounds, coords, elevations, hasEnvironment, trackTerrainHeightNear, terrainSampler]);

  const groundY = useMemo(
    () => (hasEnvironment ? minY - 1 : -peakY - trackWidth * 2 - 1),
    [hasEnvironment, minY, peakY, trackWidth],
  );
  // In terrain mode the terrain bottom sits at baseY=0.
  const stageFloorY = hasEnvironment
    ? terrainSampler
      ? -1
      : groundY - 2
    : groundY - 0.5;

  const samples = useMemo(() => {
    const length = feature.properties.length;
    return Math.max(400, Math.min(2000, Math.round(length / 4)));
  }, [feature.properties.length]);

  // The narrow/wide gradient is a diagnostic overlay, not part of the scene.
  const widthColorAt = useMemo(() => {
    if (raceView || !realWidthActive || !widthProfile) return undefined;
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
  }, [raceView, realWidthActive, widthProfile]);

  const trackGeometry = useMemo(
    () =>
      buildExtrudedTrack(
        curve,
        halfWidth,
        TRACK_SURFACE_RAISE,
        groundY,
        samples,
        trackSkirtBottom,
        widthColorAt,
      ),
    [curve, halfWidth, groundY, samples, trackSkirtBottom, widthColorAt],
  );

  const outlineGeometry = useMemo(
    () => buildTrackOutline(curve, halfWidth, TRACK_OVERLAY_RAISE, samples),
    [curve, halfWidth, samples],
  );

  // Where the paved verge may go.
  const apronClearance = useMemo<ApronClearance | null>(() => {
    if (!environmentBundle) return null;
    const { centerLon, centerLat } = bounds;
    const footprints = environmentBundle.buildings.buildings
      .map((building) =>
        building.footprint.map(([lon, lat]) => {
          const p = lonLatToXZ(lon, lat, centerLon, centerLat);
          return [p.x, p.z] as [number, number];
        }),
      )
      .filter((ring) => ring.length >= 3);
    const index = buildFootprintIndex(footprints);
    return (point, centre) => {
      if (index(point.x, point.z)) return false;
      if (!terrainSampler) return true;
      // Ground against ground: the rendered surface sits well clear of the terrain.
      const [lon, lat] = xzToLonLat(point.x, point.z, centerLon, centerLat);
      const [centreLon, centreLat] = xzToLonLat(
        centre.x,
        centre.z,
        centerLon,
        centerLat,
      );
      const here = terrainSampler.heightAt(lon, lat);
      const road = terrainSampler.heightAt(centreLon, centreLat);
      return Math.abs(here - road) <= APRON_GROUND_TOLERANCE_M;
    };
  }, [bounds, environmentBundle, terrainSampler]);

  // Always sampled, even with nothing to bump into.
  const apronRoom = useMemo(
    () => sampleApronRoom(curve, halfWidth, samples, apronClearance),
    [apronClearance, curve, halfWidth, samples],
  );

  // Asphalt beyond the white line, so the kerb has something to lie on.
  const apronGeometry = useMemo(
    () =>
      buildTrackApronGeometry(
        curve,
        halfWidth,
        TRACK_SURFACE_RAISE - 0.01,
        samples,
        apronRoom,
      ),
    [curve, halfWidth, samples, apronRoom],
  );

  // Kerbs sit a couple of centimeters above the surface and take a deeper polygon offset than it.
  const kerbGeometry = useMemo(
    () =>
      buildKerbGeometry(
        curve,
        halfWidth,
        TRACK_SURFACE_RAISE + 0.02,
        samples,
        { room: apronRoom },
      ),
    [curve, halfWidth, samples, apronRoom],
  );

  const edgeLineGeometry = useMemo(
    () =>
      buildTrackEdgeLineGeometry(
        curve,
        halfWidth,
        TRACK_SURFACE_RAISE + 0.02,
        samples,
      ),
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

  // Race view paints the line the way it exists on the circuit.
  const startFinishGeometry = useMemo(
    () =>
      raceView
        ? buildStartLineGeometry(
            curve,
            startFinishPlacement.s,
            halfWidth,
            TRACK_PAINT_RAISE,
          )
        : buildStartFinishGeometry(
            curve,
            startFinishPlacement.s,
            markerHalfWidth,
            TRACK_PAINT_RAISE,
          ),
    [raceView, curve, startFinishPlacement.s, halfWidth, markerHalfWidth],
  );

  const startGridGeometry = useMemo(
    () =>
      buildStartGridGeometry(
        curve,
        startFinishPlacement.s,
        halfWidth,
        TRACK_PAINT_RAISE,
        markers?.directionSign ?? 1,
      ),
    [curve, startFinishPlacement.s, halfWidth, markers?.directionSign],
  );

  // One source for the cars and for the camera that follows them.
  const gridSlots = useMemo(
    () =>
      raceView
        ? startGridSlots(
            curve,
            startFinishPlacement.s,
            halfWidth,
            markers?.directionSign ?? 1,
          )
        : [],
    [raceView, curve, startFinishPlacement.s, halfWidth, markers?.directionSign],
  );

  // `raceEnabled` rather than the simulation object itself.
  const raceEnabled = !!raceSim;

  // Hand the simulation the track it runs on.
  const raceSetup = useMemo(() => {
    if (!raceView || !raceEnabled || gridSlots.length === 0) return null;
    const speedProfile = buildSpeedProfile(curve, samples);
    const racingLine = buildRacingLine(curve, samples, halfWidth);
    if (!speedProfile || !racingLine) return null;
    return {
      slots: gridSlots,
      speedProfile,
      racingLine,
      halfWidthAtS: (s: number) => halfWidthAt(halfWidth, s),
      lapLengthMeters: curve.getLength(),
      seed: raceSeed ?? String(feature.properties.id ?? "circuit"),
      laps: Math.max(1, raceLaps),
    };
  }, [
    raceLaps,
    raceView,
    raceEnabled,
    gridSlots,
    curve,
    samples,
    halfWidth,
    feature,
    raceSeed,
  ]);

  const attachRace = raceSim?.attach;
  useEffect(() => {
    attachRace?.(raceSetup);
  }, [attachRace, raceSetup]);

  /** Where a car sits and which way it points, given how far round it is and how far off the centerline. */
  const poseAt = useCallback(
    (
      s: number,
      lateral: number,
      position: THREE.Vector3,
      quaternion: THREE.Quaternion,
    ) => {
      const wrapped = ((s % 1) + 1) % 1;
      const point = curve.getPointAt(wrapped);
      const tangent = curve
        .getTangentAt(wrapped)
        .normalize()
        .multiplyScalar(markers?.directionSign ?? 1);
      const across = new THREE.Vector3()
        .crossVectors(tangent, UP)
        .normalize();
      position.copy(point).addScaledVector(across, lateral);
      quaternion.setFromAxisAngle(UP, Math.atan2(tangent.x, tangent.z));
    },
    [curve, markers?.directionSign],
  );

  const startLights = useMemo(
    () =>
      raceView
        ? buildStartLightsGeometry(
            curve,
            startFinishPlacement.s,
            halfWidth,
            TRACK_OVERLAY_RAISE,
            markers?.directionSign ?? 1,
          )
        : null,
    [
      raceView,
      curve,
      startFinishPlacement.s,
      halfWidth,
      markers?.directionSign,
    ],
  );

  const startFinishGantryGeometry = useMemo(
    () =>
      buildStartFinishGantryGeometry(
        curve,
        startFinishPlacement.s,
        // Race view builds the real structure, so it takes the width the asphalt actually has under it.
        raceView ? halfWidth : markerHalfWidth,
        TRACK_OVERLAY_RAISE,
        raceView ? "plain" : "checkered",
      ),
    [curve, startFinishPlacement.s, halfWidth, markerHalfWidth, raceView],
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
        trackSkirtBottom,
      ),
    );
  }, [showSectors, curve, markers, halfWidth, groundY, samples, trackSkirtBottom]);

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
      // Built beside the kerb and rebuilt on the same inputs, but never freed with it.
      apronGeometry?.dispose();
      kerbGeometry?.dispose();
      edgeLineGeometry.dispose();
      startFinishGeometry.dispose();
      startGridGeometry?.dispose();
      startLights?.panel.dispose();
      startLights?.lamps.forEach((lamp) => lamp.dispose());
      disposeGeometry(startFinishGantryGeometry.posts);
      disposeGeometry(startFinishGantryGeometry.beam);
    };
  }, [
    trackGeometry,
    outlineGeometry,
    apronGeometry,
    kerbGeometry,
    edgeLineGeometry,
    startFinishGeometry,
    startGridGeometry,
    startLights,
    startFinishGantryGeometry,
  ]);

  useEffect(() => {
    return () => {
      sectorGeometries.forEach((g) => g.dispose());
      splitLineGeometries.forEach((g) => g.dispose());
    };
  }, [sectorGeometries, splitLineGeometries]);

  /** Undefined unless the calibration tool is open. */
  const calibrateOnPointerDown = useMemo(() => {
    if (!calibrationEnabled) return undefined;
    return (event: { stopPropagation: () => void; point: THREE.Vector3 }) => {
      event.stopPropagation();
      onCalibrateStartFinish?.(findNearestCurveS(curve, event.point, samples));
    };
  }, [calibrationEnabled, curve, samples, onCalibrateStartFinish]);

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

  // Deliberately excludes `peakY` from the deps.
  const peakYRef = useRef(peakY);
  useEffect(() => {
    peakYRef.current = peakY;
  });
  useEffect(() => {
    // Race view frames the grid, not the circuit — RaceCameraRig owns the camera there.
    if (raceView) return;
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
  }, [raceView, camera, controls, radius, cameraFraming]);

  // Excludes `peakY` from the deps for the same reason as above.
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
          trackHalfWidthM={markerHalfWidth}
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
              onPointerDown={calibrateOnPointerDown}
            >
              <meshStandardMaterial
                vertexColors
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
            onPointerDown={calibrateOnPointerDown}
          >
            <meshBasicMaterial
              key={widthColorAt ? "real-width-colors" : "solid-track"}
              vertexColors
              color={
                widthColorAt
                  ? "#ffffff"
                  : raceView
                    ? ASPHALT_COLOR
                    : colors.trackColor
              }
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

      <mesh geometry={edgeLineGeometry} renderOrder={TRACK_RENDER_ORDER}>
        <meshBasicMaterial
          color="#f2f4f7"
          side={THREE.DoubleSide}
          depthTest
          depthWrite
          toneMapped={false}
          polygonOffset
          polygonOffsetFactor={-6}
          polygonOffsetUnits={-6}
        />
      </mesh>

      {/* Paved verge and kerbs belong to the race view. The map view is a
          schematic — there the ribbon is the circuit's shape, and a second
          strip traced around it in the sector colour reads as an outline
          somebody forgot to turn off. */}
      {raceView && apronGeometry && (
        <mesh geometry={apronGeometry} renderOrder={TRACK_RENDER_ORDER}>
          <meshBasicMaterial
            color={ASPHALT_COLOR}
            side={THREE.DoubleSide}
            depthTest
            depthWrite
            toneMapped={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      )}

      {raceView && kerbGeometry && (
        <mesh geometry={kerbGeometry} renderOrder={TRACK_RENDER_ORDER}>
          <meshBasicMaterial
            vertexColors
            side={THREE.DoubleSide}
            depthTest
            depthWrite
            toneMapped={false}
            polygonOffset
            polygonOffsetFactor={-6}
            polygonOffsetUnits={-6}
          />
        </mesh>
      )}

      {/* A schematic outline of the map. On asphalt with kerbs it reads as a
          stray white thread along the edge, so race view drops it. */}
      {!raceView && (
        <lineSegments
          geometry={outlineGeometry}
          renderOrder={TRACK_OVERLAY_RENDER_ORDER}
        >
          <lineBasicMaterial
            color={colors.outlineColor}
            depthTest
            depthWrite={false}
          />
        </lineSegments>
      )}
      </group>

      <mesh geometry={startFinishGeometry} renderOrder={TRACK_OVERLAY_RENDER_ORDER}>
        <meshBasicMaterial
          key={raceView ? "start-line" : "start-finish-checkered"}
          vertexColors={!raceView}
          color={raceView ? "#f2f4f7" : "#ffffff"}
          side={THREE.DoubleSide}
          depthTest
          depthWrite={false}
          toneMapped={false}
          polygonOffset
          polygonOffsetFactor={-10}
          polygonOffsetUnits={-10}
        />
      </mesh>

      {startGridGeometry && (
        <mesh
          geometry={startGridGeometry}
          renderOrder={TRACK_OVERLAY_RENDER_ORDER}
        >
          <meshBasicMaterial
            color={MARKER_COLORS.startFinish}
            side={THREE.DoubleSide}
            depthTest
            depthWrite={false}
            toneMapped={false}
            polygonOffset
            polygonOffsetFactor={-10}
            polygonOffsetUnits={-10}
          />
        </mesh>
      )}

      {raceView && (
        <>
          <StartGridCars
            slots={gridSlots}
            surfaceRaise={TRACK_SURFACE_RAISE}
            entries={gridEntries}
            raceSim={raceSim ?? null}
            poseAt={poseAt}
          />
          <RaceCameraRig
            slots={gridSlots}
            focusIndex={focusIndex}
            raceSim={raceSim ?? null}
            poseAt={poseAt}
            follow={cameraFollow}
            onDetach={onCameraDetach}
          />
        </>
      )}

      {startLights && (
        <>
          <mesh geometry={startLights.panel} renderOrder={TRACK_PROP_RENDER_ORDER}>
            <meshStandardMaterial
              color="#0a0a0c"
              roughness={0.55}
              metalness={0.15}
            />
          </mesh>
          {startLights.lamps.map((lamp, index) => {
            // Lamps are emitted column-major, so the first `lit` columns are the first `lit * rows` lamps.
            const on = index < startLightsLit * START_LIGHT_ROWS;
            return (
              <mesh
                key={`start-lamp-${index}`}
                geometry={lamp}
                renderOrder={TRACK_PROP_RENDER_ORDER}
              >
                <meshBasicMaterial
                  color={on ? LAMP_ON_COLOR : LAMP_OFF_COLOR}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                />
              </mesh>
            );
          })}
        </>
      )}

      <mesh
        geometry={startFinishGantryGeometry.posts}
        renderOrder={TRACK_PROP_RENDER_ORDER}
      >
        <meshStandardMaterial
          color="#050507"
          emissive="#000000"
          emissiveIntensity={0}
          roughness={0.48}
          metalness={0.2}
        />
      </mesh>
      <mesh
        geometry={startFinishGantryGeometry.beam}
        renderOrder={TRACK_PROP_RENDER_ORDER}
      >
        <meshStandardMaterial
          vertexColors
          roughness={0.42}
          metalness={0.12}
        />
      </mesh>

    </group>
  );
}
