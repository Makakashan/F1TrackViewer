"use client";

import { OrbitControls, Stars } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import GlobeMarker, {
  latLonToVector3,
  type GlobeCircuit,
} from "./globe-marker";

interface GlobeEarthProps {
  circuits: GlobeCircuit[];
  selectedCircuit: GlobeCircuit | null;
  hoveredCircuit: GlobeCircuit | null;
  focusCircuit: GlobeCircuit | null;
  onHoverCircuit: (circuit: GlobeCircuit) => void;
  onSelectCircuit: (circuit: GlobeCircuit | null) => void;
  onClearHover: () => void;
  onEarthReady?: () => void;
}

const EARTH_RADIUS = 2;
const MARKER_SURFACE_OFFSET = 0.004;
const GLOBE_ROTATION_Y = -0.35;
const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const EARTH_DAY_TEXTURE = `${PUBLIC_BASE_PATH}/textures/earth/earth-day.jpg`;
const EARTH_CLOUDS_TEXTURE = `${PUBLIC_BASE_PATH}/textures/earth/earth-clouds.png`;
const CLOSE_MARKER_THRESHOLD_RADIANS = 0.018;

function lonLatToTexturePoint(lon: number, lat: number, size: number) {
  return {
    x: ((lon + 180) / 360) * size,
    y: ((90 - lat) / 180) * (size / 2),
  };
}

function drawLand(
  ctx: CanvasRenderingContext2D,
  size: number,
  points: [number, number][],
) {
  ctx.beginPath();
  points.forEach(([lon, lat], index) => {
    const point = lonLatToTexturePoint(lon, lat, size);
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.fill();
}

function createFallbackEarthTexture() {
  const size = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size / 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const ocean = ctx.createLinearGradient(0, 0, 0, canvas.height);
  ocean.addColorStop(0, "#082747");
  ocean.addColorStop(0.5, "#0b4167");
  ocean.addColorStop(1, "#061d35");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(86, 124, 68, 0.94)";
  [
    [
      [-168, 72],
      [-138, 69],
      [-105, 56],
      [-124, 42],
      [-116, 30],
      [-98, 19],
      [-82, 25],
      [-66, 44],
      [-55, 56],
      [-76, 70],
      [-118, 74],
    ],
    [
      [-82, 13],
      [-62, 9],
      [-48, -7],
      [-36, -22],
      [-52, -55],
      [-69, -48],
      [-78, -20],
    ],
    [
      [-11, 36],
      [8, 60],
      [44, 68],
      [88, 58],
      [126, 62],
      [162, 49],
      [146, 22],
      [112, 7],
      [82, 18],
      [54, 11],
      [32, 30],
      [12, 36],
    ],
    [
      [-18, 36],
      [26, 34],
      [51, 9],
      [42, -35],
      [18, -35],
      [-8, -3],
    ],
    [
      [112, -11],
      [154, -19],
      [146, -42],
      [114, -34],
    ],
    [
      [-52, 76],
      [-18, 72],
      [-24, 60],
      [-48, 58],
      [-62, 66],
    ],
    [
      [44, 34],
      [73, 31],
      [88, 20],
      [74, 8],
      [48, 16],
    ],
  ].forEach((shape) => drawLand(ctx, size, shape as [number, number][]));

  ctx.strokeStyle = "rgba(190, 230, 255, 0.09)";
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const top = lonLatToTexturePoint(lon, 82, size);
    const bottom = lonLatToTexturePoint(lon, -82, size);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const left = lonLatToTexturePoint(-180, lat, size);
    const right = lonLatToTexturePoint(180, lat, size);
    ctx.beginPath();
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

function configureTexture(texture: THREE.Texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function useOptionalTexture(url: string, required = false) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (loadedTexture) => {
        if (cancelled) {
          loadedTexture.dispose();
          return;
        }
        setTexture(configureTexture(loadedTexture));
        setMissing(false);
        setLoading(false);
      },
      undefined,
      () => {
        if (cancelled) return;
        setTexture(null);
        setMissing(true);
        setLoading(false);
        if (required && process.env.NODE_ENV === "development") {
          console.warn(
            `GlobeLanding: missing Earth texture ${url}; using stylized fallback.`,
          );
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [required, url]);

  return { texture, missing, loading };
}

function CloudLayer({ texture }: { texture: THREE.Texture }) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (!ref.current) return;
    ref.current.rotation.y += delta * 0.012;
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[EARTH_RADIUS * 1.012, 128, 64]} />
      <meshStandardMaterial
        map={texture}
        transparent
        opacity={0.28}
        depthWrite={false}
        roughness={1}
      />
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
    const magnitude = Math.min(0.042, 0.022 + sortedGroup.length * 0.004);
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

function EarthSphere({
  dayTexture,
  cloudTexture,
}: {
  dayTexture: THREE.Texture | null;
  cloudTexture: THREE.Texture | null;
}) {
  const fallbackTexture = useMemo(() => createFallbackEarthTexture(), []);
  const texture = dayTexture ?? fallbackTexture;
  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      map: texture,
      color: "#ffffff",
      roughness: dayTexture ? 0.68 : 0.84,
      metalness: 0.02,
      emissive: "#031226",
      emissiveIntensity: dayTexture ? 0.03 : 0.1,
    });
  }, [dayTexture, texture]);

  return (
    <group>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS, 160, 96]} />
        <primitive object={material} attach="material" />
      </mesh>
      {dayTexture && cloudTexture && <CloudLayer texture={cloudTexture} />}
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS * 1.035, 96, 48]} />
        <meshBasicMaterial
          color="#75bfff"
          transparent
          opacity={0.08}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS * 1.008, 96, 48]} />
        <meshBasicMaterial
          color="#8fc7ff"
          transparent
          opacity={0.035}
          side={THREE.FrontSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

export default function GlobeEarth({
  circuits,
  selectedCircuit,
  hoveredCircuit,
  focusCircuit,
  onHoverCircuit,
  onSelectCircuit,
  onClearHover,
  onEarthReady,
}: GlobeEarthProps) {
  const { camera } = useThree();
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const focusTargetRef = useRef<THREE.Vector3 | null>(null);
  const lastFocusCircuitIdRef = useRef<string | null>(null);
  const markerOffsets = useMemo(() => buildMarkerOffsets(circuits), [circuits]);
  const {
    texture: dayTexture,
    missing: dayTextureMissing,
    loading: dayTextureLoading,
  } = useOptionalTexture(EARTH_DAY_TEXTURE, true);
  const { texture: cloudTexture } = useOptionalTexture(EARTH_CLOUDS_TEXTURE);
  const earthReady =
    Boolean(dayTexture) || (!dayTextureLoading && dayTextureMissing);

  useEffect(() => {
    if (earthReady) onEarthReady?.();
  }, [earthReady, onEarthReady]);

  useEffect(() => {
    if (!focusCircuit) return;
    if (lastFocusCircuitIdRef.current === focusCircuit.id) return;
    lastFocusCircuitIdRef.current = focusCircuit.id;
    const direction = latLonToVector3(focusCircuit.lat, focusCircuit.lon, 1)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), GLOBE_ROTATION_Y)
      .normalize();
    const distance = THREE.MathUtils.clamp(camera.position.length(), 3.7, 5.2);
    focusTargetRef.current = direction.multiplyScalar(distance);
  }, [camera, focusCircuit]);

  useFrame(() => {
    if (!focusTargetRef.current) return;
    camera.position.lerp(focusTargetRef.current, 0.08);
    camera.lookAt(0, 0, 0);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();

    if (camera.position.distanceTo(focusTargetRef.current) < 0.03) {
      focusTargetRef.current = null;
    }
  });

  return (
    <>
      <color attach="background" args={["#03050a"]} />
      <fog attach="fog" args={["#03050a", 8, 13]} />
      <ambientLight intensity={0.18} />
      <directionalLight position={[4.5, 2.6, 5.4]} intensity={3.3} />
      <directionalLight position={[-3.5, 1.2, -3]} intensity={0.55} color="#7dbdff" />
      <pointLight position={[-4, -2, -3]} intensity={0.45} color="#e10600" />
      <Stars
        radius={80}
        depth={35}
        count={1400}
        factor={3}
        saturation={0}
        fade
        speed={0.35}
      />
      <group rotation={[0, GLOBE_ROTATION_Y, 0]}>
        {earthReady && (
          <>
            <EarthSphere
              dayTexture={dayTexture}
              cloudTexture={cloudTexture}
            />
            {circuits.map((circuit) => (
              <GlobeMarker
                key={circuit.id}
                circuit={circuit}
                radius={EARTH_RADIUS + MARKER_SURFACE_OFFSET}
                visualOffset={markerOffsets.get(circuit.id)}
                selected={selectedCircuit?.id === circuit.id}
                hovered={hoveredCircuit?.id === circuit.id}
                onHover={onHoverCircuit}
                onSelect={onSelectCircuit}
                onBlur={onClearHover}
              />
            ))}
          </>
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
          focusTargetRef.current = null;
        }}
      />
    </>
  );
}
