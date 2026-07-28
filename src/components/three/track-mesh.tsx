"use client";

import { useMemo, useEffect, useCallback, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  buildTrackCurveWithY,
  buildTrackCurve,
  computeBounds,
  densifyCoords,
  sceneRadiusFromBounds,
  stripClosingDuplicate,
  REAL_ELEVATION_SCALE,
} from "@/lib/geo-utils";
import { smoothTerrainTrackProfile } from "@/lib/elevation";
import {
  buildExtrudedTrack,
  buildTrackOutline,
  buildSectorMesh,
  buildSectorSplitLineGeometry,
  type HalfWidth,
} from "@/lib/track-geometry";
import { sampleWidthAt, type TrackWidthProfile } from "@/lib/track-width";
import {
  buildKerbGeometry,
  buildTrackEdgeLineGeometry,
} from "@/lib/track-kerbs";
import { buildStartGridGeometry, startGridSlots } from "@/lib/start-grid";
import StartGridCars from "@/components/three/start-grid-cars";
import RaceCameraRig from "@/components/three/race-camera-rig";
import type { GridEntry } from "@/lib/f1-teams";
import { START_LIGHT_ROWS } from "@/lib/start-lights";
import {
  buildStartFinishGantryGeometry,
  buildStartFinishGeometry,
  buildStartLineGeometry,
  findNearestCurveS,
  resolveStartFinishPlacement,
  type StartFinishPlacement,
} from "@/lib/start-finish";
import { buildStartLightsGeometry } from "@/lib/start-lights";
import type { CircuitGeoJSON } from "@/lib/f1-circuits";
import {
  MARKER_COLORS,
  type TrackMarkers,
  type TrackViewMode,
} from "@/lib/track-markers";
import type { EnvironmentBundle } from "@/lib/environment-types";
import { buildTerrainSampler, terrainHeightNear } from "@/lib/terrain-sampler";
import EnvironmentLayer from "@/components/environment-layer";
import StudioStage from "@/components/three/studio-stage";
import type { CameraPreset } from "@/components/track-viewer";
import {
  TRACK_SURFACE_RAISE,
  TRACK_PAINT_RAISE,
  TRACK_OVERLAY_RAISE,
  TRACK_RENDER_ORDER,
  TRACK_OVERLAY_RENDER_ORDER,
  TERRAIN_TRACK_OFFSET,
  TERRAIN_TRACK_CLEARANCE_SAMPLE_RADIUS_M,
  TERRAIN_TRACK_MAX_SEGMENT_M,
  TERRAIN_TRACK_SMOOTH_RADIUS_M,
  TERRAIN_TRACK_WALL_DEPTH,
  disposeGeometry,
  getSceneColors,
} from "@/lib/scene-config";

/** Asphalt in race view. Warm-neutral rather than pure grey, which reads blue. */
const ASPHALT_COLOR = "#3a3a3d";

/** An unlit start lamp — a dark lens against the black panel, not a hole in it. */
const LAMP_OFF_COLOR = "#4a1c20";
/** Lit: brighter than any red in the scene, so it reads as a light source. */
const LAMP_ON_COLOR = "#ff2318";

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
}: TrackMeshProps) {
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates;
  const hasEnvironment = !!environmentBundle;

  // Race view is the "what it actually looks like" mode: asphalt instead of
  // the stylised red ribbon, the circuit's real width wherever the dataset
  // has it, and a car in every grid box.
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

  // Sample the max terrain height in a small neighbourhood so the track
  // ribbon never dips under a nearby terrain peak (flat-shaded triangles
  // can sit above the bilinear value).  Radius is kept small (12 m) to
  // avoid the floating look that the old 46 m radius caused.
  const trackTerrainHeightNear = useCallback(
    (lon: number, lat: number): number => {
      if (!terrainSampler) return 0;
      return terrainHeightNear(
        terrainSampler,
        lon,
        lat,
        TERRAIN_TRACK_CLEARANCE_SAMPLE_RADIUS_M,
      );
    },
    [terrainSampler],
  );

  const { curve, peakY, minY } = useMemo(() => {
    if (terrainSampler) {
      let min = Infinity;
      let max = -Infinity;
      const denseCoords = densifyCoords(coords, TERRAIN_TRACK_MAX_SEGMENT_M);
      // Smooth the raw per-vertex terrain heights before they become curve Y:
      // sampled straight off the DEM the ribbon ripples with every grid cell.
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

  // The narrow/wide gradient is a diagnostic overlay, not part of the scene —
  // race view wants plain asphalt even though it uses the same real widths.
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
        terrainSampler ? TERRAIN_TRACK_WALL_DEPTH : undefined,
        widthColorAt,
      ),
    [curve, halfWidth, groundY, samples, terrainSampler, widthColorAt],
  );

  const outlineGeometry = useMemo(
    () => buildTrackOutline(curve, halfWidth, TRACK_OVERLAY_RAISE, samples),
    [curve, halfWidth, samples],
  );

  // Kerbs sit a couple of centimeters above the surface and take a deeper
  // polygon offset than it, so they never z-fight with the ribbon they border;
  // overlay markers still draw on top via TRACK_OVERLAY_RENDER_ORDER.
  const kerbGeometry = useMemo(
    () =>
      buildKerbGeometry(
        curve,
        halfWidth,
        TRACK_SURFACE_RAISE + 0.02,
        samples,
      ),
    [curve, halfWidth, samples],
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

  // Race view paints the line the way it exists on the circuit; the other
  // modes keep the checkered map symbol.
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

  const startLights = useMemo(
    () =>
      raceView
        ? buildStartLightsGeometry(
            curve,
            startFinishPlacement.s,
            markerHalfWidth,
            TRACK_OVERLAY_RAISE,
            markers?.directionSign ?? 1,
          )
        : null,
    [
      raceView,
      curve,
      startFinishPlacement.s,
      markerHalfWidth,
      markers?.directionSign,
    ],
  );

  const startFinishGantryGeometry = useMemo(
    () =>
      buildStartFinishGantryGeometry(
        curve,
        startFinishPlacement.s,
        markerHalfWidth,
        TRACK_OVERLAY_RAISE,
        raceView ? "plain" : "checkered",
      ),
    [curve, startFinishPlacement.s, markerHalfWidth, raceView],
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

  /**
   * Undefined unless the calibration tool is open.
   *
   * An r3f mesh with any pointer handler joins the interaction list, and every
   * pointer move then raycasts it — the whole track ribbon, triangle by
   * triangle, on each event of a drag. The handler only ever does anything for
   * the admin calibration page, so outside it the mesh should not be
   * interactive at all rather than interactive-and-returning-early.
   */
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
    // Race view frames the grid, not the circuit — RaceCameraRig owns the
    // camera there. Child effects run before the parent's, so without this the
    // overview would land on top of the rig's framing on every mount.
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

      {kerbGeometry && (
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
          />
          <RaceCameraRig slots={gridSlots} focusIndex={focusIndex} />
        </>
      )}

      {startLights && (
        <>
          <mesh geometry={startLights.panel}>
            <meshStandardMaterial
              color="#0a0a0c"
              roughness={0.55}
              metalness={0.15}
            />
          </mesh>
          {startLights.lamps.map((lamp, index) => {
            // Lamps are emitted column-major, so the first `lit` columns are
            // the first `lit * rows` lamps.
            const on = index < startLightsLit * START_LIGHT_ROWS;
            return (
              <mesh key={`start-lamp-${index}`} geometry={lamp}>
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
