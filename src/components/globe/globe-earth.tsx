"use client";

import { OrbitControls, Stars } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import GlobeMarkers, {
  markerPositionForCircuit,
  type GlobeCircuit,
} from "./globe-marker";
import { CountryOutline, GlobeHalo } from "./globe-overlays";
import {
  EARTH_DAY_URL,
  EARTH_RADIUS,
  EARTH_RELIEF_URL,
  ReliefSampler,
  createEarthMaterial,
  latLonToVector3,
} from "./globe-surface";

interface GlobeEarthProps {
  circuits: GlobeCircuit[];
  selectedCircuit: GlobeCircuit | null;
  hoveredCircuit: GlobeCircuit | null;
  focusCircuit: GlobeCircuit | null;
  /** Rotates the globe to face this point without changing zoom/FOV. */
  focusRegion?: { lat: number; lon: number } | null;
  cardTopPx?: number;
  /** App light/dark theme — the backdrop, stars and halo follow it. */
  theme: "light" | "dark";
  onHoverCircuit: (circuit: GlobeCircuit) => void;
  onSelectCircuit: (circuit: GlobeCircuit | null) => void;
  onClearHover: () => void;
  onEarthReady?: () => void;
  onActiveMarkerScreenPosition?: (
    point: { x: number; y: number } | null,
  ) => void;
}

const VOID_COLOR = "#0a0a0a";
const MARKER_LIFT = 0.002;
const GLOBE_ROTATION_Y = -0.35;
const CLOSE_MARKER_THRESHOLD_RADIANS = 0.018;
/** Sphere segments: dense enough on a desktop for the relief to break the silhouette, half that on a phone. */
const SEGMENTS_DESKTOP = 768;
const SEGMENTS_MOBILE = 384;

interface EarthMaps {
  day: THREE.Texture;
  relief: THREE.Texture;
  sampler: ReliefSampler;
}

function useEarthMaps() {
  // "failed" still lets the page past its loader: markers and the list work without the Earth.
  const [maps, setMaps] = useState<EarthMaps | "failed" | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    Promise.all([
      loader.loadAsync(EARTH_DAY_URL),
      loader.loadAsync(EARTH_RELIEF_URL),
    ]).then(([day, relief]) => {
      if (cancelled) {
        day.dispose();
        relief.dispose();
        return;
      }
      day.colorSpace = THREE.SRGBColorSpace;
      day.anisotropy = 8;
      relief.colorSpace = THREE.NoColorSpace;
      relief.anisotropy = 8;
      for (const texture of [day, relief]) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
      }
      setMaps({ day, relief, sampler: new ReliefSampler(relief.image) });
    }, () => {
      if (!cancelled) setMaps("failed");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return maps;
}

function EarthSphere({ maps }: { maps: EarthMaps }) {
  const { size } = useThree();
  const segments = size.width < 768 ? SEGMENTS_MOBILE : SEGMENTS_DESKTOP;
  const material = useMemo(
    () => createEarthMaterial(maps.day, maps.relief),
    [maps],
  );
  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh material={material}>
      <sphereGeometry args={[EARTH_RADIUS, segments, segments / 2]} />
    </mesh>
  );
}

function angularDistanceRadians(a: GlobeCircuit, b: GlobeCircuit) {
  const lat1 = THREE.MathUtils.degToRad(a.lat);
  const lat2 = THREE.MathUtils.degToRad(b.lat);
  const deltaLat = lat2 - lat1;
  const deltaLon = THREE.MathUtils.degToRad(b.lon - a.lon);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function buildMarkerOffsets(circuits: GlobeCircuit[]) {
  const parents = new Map(circuits.map((circuit) => [circuit.id, circuit.id]));

  function find(id: string): string {
    const parent = parents.get(id) ?? id;
    if (parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  }

  function union(a: string, b: string) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parents.set(rootB, rootA);
  }

  circuits.forEach((circuit, index) => {
    circuits.slice(index + 1).forEach((otherCircuit) => {
      if (
        angularDistanceRadians(circuit, otherCircuit) <
        CLOSE_MARKER_THRESHOLD_RADIANS
      ) {
        union(circuit.id, otherCircuit.id);
      }
    });
  });

  const groups = new Map<string, GlobeCircuit[]>();
  circuits.forEach((circuit) => {
    const root = find(circuit.id);
    groups.set(root, [...(groups.get(root) ?? []), circuit]);
  });

  const offsets = new Map<string, { angle: number; magnitude: number }>();
  groups.forEach((group) => {
    if (group.length < 2) return;

    const sortedGroup = [...group].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const magnitude = Math.min(0.028, 0.014 + sortedGroup.length * 0.004);
    const phase = sortedGroup.reduce(
      (sum, circuit) => sum + circuit.id.charCodeAt(0),
      0,
    );

    sortedGroup.forEach((circuit, index) => {
      offsets.set(circuit.id, {
        angle: (Math.PI * 2 * index) / sortedGroup.length + phase * 0.01,
        magnitude,
      });
    });
  });

  return offsets;
}

export default function GlobeEarth({
  circuits,
  selectedCircuit,
  hoveredCircuit,
  focusCircuit,
  focusRegion,
  cardTopPx,
  theme,
  onHoverCircuit,
  onSelectCircuit,
  onClearHover,
  onEarthReady,
  onActiveMarkerScreenPosition,
}: GlobeEarthProps) {
  const { camera, size, invalidate } = useThree();
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const focusTargetRef = useRef<THREE.Vector3 | null>(null);
  const focusStartRef = useRef<THREE.Vector3 | null>(null);
  const focusProgressRef = useRef(0);
  const focusDistanceRef = useRef(5);
  const focusFovRef = useRef(42);
  const focusStartFovRef = useRef(42);
  const fovProgressRef = useRef(0);
  const fovAnimatingRef = useRef(false);
  const lastFocusCircuitIdRef = useRef<string | null>(null);
  const lastFocusRegionKeyRef = useRef<string | null>(null);
  const userInteractedRef = useRef(false);
  const projectedMarkerRef = useRef(new THREE.Vector3());
  const lastScreenPointRef = useRef<{ x: number; y: number } | null>(null);
  const markerOffsets = useMemo(() => buildMarkerOffsets(circuits), [circuits]);
  const activeCircuit = hoveredCircuit ?? selectedCircuit;
  const loadedMaps = useEarthMaps();
  const maps = loadedMaps === "failed" ? null : loadedMaps;
  const markerPositions = useMemo(
    () =>
      circuits.map((circuit) => {
        const offset = markerOffsets.get(circuit.id);
        const radius = maps ? maps.sampler.radiusAt(circuit.lat, circuit.lon) : EARTH_RADIUS;
        return markerPositionForCircuit(circuit, radius + MARKER_LIFT, offset);
      }),
    [circuits, markerOffsets, maps],
  );

  useEffect(() => {
    if (loadedMaps) onEarthReady?.();
  }, [loadedMaps, onEarthReady]);

  useEffect(() => {
    if (!focusCircuit) {
      focusTargetRef.current = null;
      focusStartRef.current = null;
      focusStartFovRef.current = (camera as THREE.PerspectiveCamera).fov;
      focusFovRef.current = 42;
      fovProgressRef.current = 0;
      fovAnimatingRef.current = true;
      lastFocusCircuitIdRef.current = null;
      userInteractedRef.current = false;
      return;
    }
    if (lastFocusCircuitIdRef.current !== focusCircuit.id) {
      userInteractedRef.current = false;
      lastFocusCircuitIdRef.current = focusCircuit.id;
      focusStartRef.current = camera.position.clone().normalize();
      focusStartFovRef.current = (camera as THREE.PerspectiveCamera).fov;
      focusProgressRef.current = 0;
      focusFovRef.current = 30;
      fovProgressRef.current = 0;
      fovAnimatingRef.current = true;
    }
    if (userInteractedRef.current) return;

    const direction = latLonToVector3(focusCircuit.lat, focusCircuit.lon, 1)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), GLOBE_ROTATION_Y)
      .normalize();
    const distance = THREE.MathUtils.clamp(camera.position.length(), 3.7, 6.5);
    const target = direction.clone().multiplyScalar(distance);

    const isMobileViewport = size.width < 768;
    if (
      isMobileViewport &&
      cardTopPx &&
      cardTopPx > 0 &&
      size.height > 0
    ) {
      const TOP_MARGIN_PX = 28;
      const markerY = size.height / 2;
      const rawLiftPx = markerY - cardTopPx + TOP_MARGIN_PX;
      const maxLiftPx = Math.max(0, markerY - 48);
      const liftPx = Math.max(0, Math.min(rawLiftPx, maxLiftPx));
      if (liftPx > 0) {
        const persp = camera as THREE.PerspectiveCamera;
        const fovRad = THREE.MathUtils.degToRad(persp.fov);
        const markerRadius = EARTH_RADIUS + MARKER_LIFT;
        const dMarker = Math.max(distance - markerRadius, 0.001);
        // Camera pivots around the globe center (lookAt 0,0,0).
        const worldShift =
          (liftPx *
            2 *
            dMarker *
            Math.tan(fovRad / 2) *
            distance) /
          (markerRadius * size.height);
        const upWorld = new THREE.Vector3(0, 1, 0).sub(
          direction.clone().multiplyScalar(direction.y),
        );
        if (upWorld.lengthSq() > 1e-4) {
          upWorld.normalize();
          target.add(upWorld.multiplyScalar(-worldShift));
        }
      }
    }

    focusDistanceRef.current = distance;
    focusTargetRef.current = target;
  }, [camera, focusCircuit, cardTopPx, size.width, size.height]);

  useEffect(() => {
    if (!focusRegion) return;
    const key = `${focusRegion.lat.toFixed(2)},${focusRegion.lon.toFixed(2)}`;
    if (lastFocusRegionKeyRef.current === key) return;
    const first = lastFocusRegionKeyRef.current === null;
    lastFocusRegionKeyRef.current = key;

    const direction = latLonToVector3(focusRegion.lat, focusRegion.lon, 1)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), GLOBE_ROTATION_Y)
      .normalize();
    const distance = camera.position.length();
    // The page opens already facing the region; only later changes turn the globe.
    if (first) {
      camera.position.copy(direction.multiplyScalar(distance));
      camera.lookAt(0, 0, 0);
      controlsRef.current?.update();
      return;
    }

    focusStartRef.current = camera.position.clone().normalize();
    focusDistanceRef.current = distance;
    focusTargetRef.current = direction.clone().multiplyScalar(distance);
    focusProgressRef.current = 0;
  }, [camera, focusRegion]);

  useFrame(() => {
    if (focusTargetRef.current || fovAnimatingRef.current) invalidate();
    if (focusTargetRef.current && focusStartRef.current) {
      focusProgressRef.current = Math.min(focusProgressRef.current + 0.03, 1);
      const t = focusProgressRef.current;

      const startDir = focusStartRef.current;
      const endDir = focusTargetRef.current.clone().normalize();

      const axis = new THREE.Vector3().crossVectors(startDir, endDir);
      const sinAngle = axis.length();
      const cosAngle = startDir.dot(endDir);

      let currentDir: THREE.Vector3;
      if (sinAngle < 0.001) {
        currentDir = startDir.clone().lerp(endDir, t).normalize();
      } else {
        axis.normalize();
        const angle = Math.atan2(sinAngle, cosAngle);
        const q = new THREE.Quaternion().setFromAxisAngle(axis, angle * t);
        currentDir = startDir.clone().applyQuaternion(q).normalize();
      }

      camera.position.copy(currentDir.multiplyScalar(focusDistanceRef.current));
      camera.lookAt(0, 0, 0);
      controlsRef.current?.target.set(0, 0, 0);
      controlsRef.current?.update();

      if (focusProgressRef.current >= 1) {
        focusTargetRef.current = null;
        focusStartRef.current = null;
      }
    }

    if (fovAnimatingRef.current) {
      fovProgressRef.current = Math.min(fovProgressRef.current + 0.03, 1);
      const t = fovProgressRef.current;
      const persp = camera as THREE.PerspectiveCamera;
      const fov =
        focusStartFovRef.current +
        (focusFovRef.current - focusStartFovRef.current) * t;
      Object.assign(persp, { fov });
      persp.updateProjectionMatrix();

      if (fovProgressRef.current >= 1) {
        fovAnimatingRef.current = false;
      }
    }

    if (!onActiveMarkerScreenPosition) return;
    if (!activeCircuit) {
      if (lastScreenPointRef.current) {
        lastScreenPointRef.current = null;
        onActiveMarkerScreenPosition(null);
      }
      return;
    }

    const markerIndex = circuits.indexOf(activeCircuit);
    if (markerIndex < 0) return;
    const markerPosition = markerPositions[markerIndex]
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), GLOBE_ROTATION_Y);
    const facing = markerPosition
      .clone()
      .normalize()
      .dot(camera.position.clone().normalize());
    if (facing < -0.02) {
      if (lastScreenPointRef.current) {
        lastScreenPointRef.current = null;
        onActiveMarkerScreenPosition(null);
      }
      return;
    }

    const projected = projectedMarkerRef.current.copy(markerPosition).project(camera);
    const nextPoint = {
      x: ((projected.x + 1) / 2) * size.width,
      y: ((-projected.y + 1) / 2) * size.height,
    };
    const lastPoint = lastScreenPointRef.current;
    if (
      !lastPoint ||
      Math.abs(lastPoint.x - nextPoint.x) > 0.5 ||
      Math.abs(lastPoint.y - nextPoint.y) > 0.5
    ) {
      lastScreenPointRef.current = nextPoint;
      onActiveMarkerScreenPosition(nextPoint);
    }
  });

  return (
    <>
      {theme === "dark" && <color attach="background" args={[VOID_COLOR]} />}
      {theme === "dark" && (
        <Stars
          radius={80}
          depth={35}
          count={1900}
          factor={2.6}
          saturation={0}
          fade
          speed={0.22}
        />
      )}
      <GlobeHalo theme={theme} />
      <group rotation={[0, GLOBE_ROTATION_Y, 0]}>
        {maps && (
          <>
            <EarthSphere maps={maps} />
            <CountryOutline country={activeCircuit?.country ?? null} sampler={maps.sampler} />
          </>
        )}
        {loadedMaps && (
          <GlobeMarkers
            circuits={circuits}
            positions={markerPositions}
            selectedId={selectedCircuit?.id ?? null}
            hoveredId={hoveredCircuit?.id ?? null}
            onHover={onHoverCircuit}
            onSelect={onSelectCircuit}
            onBlur={onClearHover}
          />
        )}
      </group>
      <OrbitControls
        ref={controlsRef}
        enablePan={false}
        enableRotate
        enableZoom
        minDistance={3.1}
        maxDistance={6.8}
        rotateSpeed={0.55}
        zoomSpeed={0.7}
        dampingFactor={0.08}
        enableDamping
        makeDefault
        onStart={() => {
          userInteractedRef.current = true;
          focusTargetRef.current = null;
        }}
      />
    </>
  );
}
