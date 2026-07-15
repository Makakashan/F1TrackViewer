"use client";

import { OrbitControls, Stars } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import GlobeMarker, {
  latLonToVector3,
  markerPositionForCircuit,
  type GlobeCircuit,
} from "./globe-marker";

interface GlobeEarthProps {
  circuits: GlobeCircuit[];
  selectedCircuit: GlobeCircuit | null;
  hoveredCircuit: GlobeCircuit | null;
  focusCircuit: GlobeCircuit | null;
  /** Rotates the globe to face this point without changing zoom/FOV — used
   * for the continent filter chips, as opposed to focusCircuit's tight zoom. */
  focusRegion?: { lat: number; lon: number } | null;
  cardTopPx?: number;
  onHoverCircuit: (circuit: GlobeCircuit) => void;
  onSelectCircuit: (circuit: GlobeCircuit | null) => void;
  onClearHover: () => void;
  onEarthReady?: () => void;
  onActiveMarkerScreenPosition?: (
    point: { x: number; y: number } | null,
  ) => void;
}

const EARTH_RADIUS = 2;
const MARKER_SURFACE_OFFSET = 0.002;
const GLOBE_ROTATION_Y = -0.35;
const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const EARTH_DAY_TEXTURE = `${PUBLIC_BASE_PATH}/textures/earth/earth-day.jpg`;
const EARTH_CLOUDS_TEXTURE = `${PUBLIC_BASE_PATH}/textures/earth/earth-clouds.png`;
const CLOSE_MARKER_THRESHOLD_RADIANS = 0.018;
const SUN_DIRECTION = new THREE.Vector3(0.55, 0.32, 0.78).normalize();

interface EarthTextureSet {
  day: THREE.Texture;
  specular: THREE.Texture;
  generatedClouds: THREE.Texture;
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
  ctx.fillRect(size * 0.42, size * 0.16, size * 0.34, size * 0.32);
  ctx.fillStyle = "rgba(180, 146, 88, 0.9)";
  ctx.fillRect(size * 0.47, size * 0.47, size * 0.24, size * 0.22);

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
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function isLikelyOcean(r: number, g: number, b: number, luma: number) {
  return b > g * 0.82 && b > r * 1.08 && luma < 0.58;
}

function createEarthTextureSet(source: THREE.Texture): EarthTextureSet {
  const image = source.image as CanvasImageSource | undefined;
  const day = configureTexture(source);
  if (!image) {
    const fallback = createFallbackEarthTexture() ?? day;
    return {
      day,
      specular: fallback.clone(),
      generatedClouds: fallback.clone(),
    };
  }

  const width = 2048;
  const height = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    const fallback = createFallbackEarthTexture() ?? day;
    return {
      day,
      specular: fallback.clone(),
      generatedClouds: fallback.clone(),
    };
  }

  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const specularCanvas = document.createElement("canvas");
  const cloudCanvas = document.createElement("canvas");
  specularCanvas.width = cloudCanvas.width = width;
  specularCanvas.height = cloudCanvas.height = height;
  const specularCtx = specularCanvas.getContext("2d");
  const cloudCtx = cloudCanvas.getContext("2d");

  if (!specularCtx || !cloudCtx) {
    const fallback = createFallbackEarthTexture() ?? day;
    return {
      day,
      specular: fallback.clone(),
      generatedClouds: fallback.clone(),
    };
  }

  const specularImageData = specularCtx.createImageData(width, height);
  const specularData = specularImageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
    const ocean = isLikelyOcean(r, g, b, luma);
    const value = ocean ? Math.round(150 + (1 - luma) * 75) : 8;
    specularData[i] = value;
    specularData[i + 1] = value;
    specularData[i + 2] = value;
    specularData[i + 3] = 255;
  }
  specularCtx.putImageData(specularImageData, 0, 0);

  let seed = 1337;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  cloudCtx.clearRect(0, 0, width, height);
  for (let i = 0; i < 620; i += 1) {
    const x = random() * width;
    const y = (0.16 + random() * 0.68) * height;
    const radiusX = 22 + random() * 120;
    const radiusY = 4 + random() * 18;
    const alpha = 0.018 + random() * 0.052;
    cloudCtx.save();
    cloudCtx.translate(x, y);
    cloudCtx.rotate((random() - 0.5) * 0.75);
    const cloud = cloudCtx.createRadialGradient(0, 0, 0, 0, 0, radiusX);
    cloud.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    cloud.addColorStop(0.45, `rgba(255, 255, 255, ${alpha * 0.55})`);
    cloud.addColorStop(1, "rgba(255, 255, 255, 0)");
    cloudCtx.scale(1, radiusY / radiusX);
    cloudCtx.fillStyle = cloud;
    cloudCtx.beginPath();
    cloudCtx.arc(0, 0, radiusX, 0, Math.PI * 2);
    cloudCtx.fill();
    cloudCtx.restore();
  }
  cloudCtx.globalCompositeOperation = "screen";
  const polarHaze = cloudCtx.createLinearGradient(0, 0, 0, height);
  polarHaze.addColorStop(0, "rgba(255,255,255,0.13)");
  polarHaze.addColorStop(0.16, "rgba(255,255,255,0)");
  polarHaze.addColorStop(0.84, "rgba(255,255,255,0)");
  polarHaze.addColorStop(1, "rgba(255,255,255,0.1)");
  cloudCtx.fillStyle = polarHaze;
  cloudCtx.fillRect(0, 0, width, height);

  const specular = configureTexture(new THREE.CanvasTexture(specularCanvas));
  const generatedClouds = configureTexture(new THREE.CanvasTexture(cloudCanvas));
  generatedClouds.colorSpace = THREE.SRGBColorSpace;
  return { day, specular, generatedClouds };
}

function useEarthTexture(url: string) {
  const [textureSet, setTextureSet] = useState<EarthTextureSet | null>(null);
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
        setTextureSet(createEarthTextureSet(loadedTexture));
        setLoading(false);
      },
      undefined,
      () => {
        if (cancelled) return;
        const fallback = createFallbackEarthTexture();
        if (fallback) setTextureSet(createEarthTextureSet(fallback));
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [url]);

  return { textureSet, loading };
}

function useOptionalTexture(url: string) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

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
      },
      undefined,
      () => {
        if (!cancelled) setTexture(null);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [url]);

  return texture;
}

function CloudLayer({ texture }: { texture: THREE.Texture }) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (!ref.current) return;
    ref.current.rotation.y += delta * 0.01;
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[EARTH_RADIUS * 1.012, 128, 64]} />
      <meshStandardMaterial
        map={texture}
        transparent
        opacity={0.26}
        depthWrite={false}
        roughness={1}
        color="#f2fbff"
        emissive="#9dccff"
        emissiveIntensity={0.035}
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

function EarthSphere({
  textures,
  cloudTexture,
}: {
  textures: EarthTextureSet;
  cloudTexture: THREE.Texture | null;
}) {
  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: textures.day },
        specularMap: { value: textures.specular },
        sunDirection: { value: SUN_DIRECTION },
        atmosphereColor: { value: new THREE.Color("#77cfff") },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPosition;

        void main() {
          vUv = uv;
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D dayMap;
        uniform sampler2D specularMap;
        uniform vec3 sunDirection;
        uniform vec3 atmosphereColor;

        varying vec2 vUv;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPosition;

        vec3 saturateColor(vec3 color, float amount) {
          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          return mix(vec3(luma), color, amount);
        }

        void main() {
          vec3 normal = normalize(vWorldNormal);
          vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
          float sunAmount = dot(normal, normalize(sunDirection));
          float wrappedLight = smoothstep(-0.78, 1.0, sunAmount);
          float directLight = smoothstep(-0.15, 1.0, sunAmount);
          float fresnel = pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), 2.35);

          vec3 dayColor = texture2D(dayMap, vUv).rgb;
          float ocean = texture2D(specularMap, vUv).r;
          float oceanMask = smoothstep(0.28, 0.66, ocean);
          vec3 halfDirection = normalize(normalize(sunDirection) + viewDirection);
          float oceanGlint = pow(max(dot(normal, halfDirection), 0.0), 82.0) * ocean;

          vec3 landGrade = saturateColor(pow(dayColor, vec3(0.9)), 1.12);
          landGrade = mix(landGrade, vec3(1.0, 0.92, 0.72), smoothstep(0.52, 0.86, landGrade.r) * 0.1);
          vec3 oceanGrade = mix(dayColor, vec3(0.02, 0.12, 0.22), 0.14);
          oceanGrade = saturateColor(oceanGrade, 0.98);

          vec3 baseColor = mix(landGrade, oceanGrade, oceanMask);
          vec3 color = baseColor * (0.68 + wrappedLight * 0.42);
          color += vec3(0.015, 0.055, 0.09) * oceanMask * (0.08 + directLight * 0.16);
          color += vec3(0.72, 0.9, 1.0) * oceanGlint * 0.34;
          color += atmosphereColor * fresnel * (0.18 + wrappedLight * 0.22);
          color = pow(color + vec3(0.006, 0.009, 0.012), vec3(0.98));

          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
  }, [textures]);

  return (
    <group>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS, 192, 112]} />
        <primitive object={material} attach="material" />
      </mesh>
      <GlobeGrid radius={EARTH_RADIUS * 1.006} />
      <CloudLayer texture={cloudTexture ?? textures.generatedClouds} />
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS * 1.05, 128, 64]} />
        <meshBasicMaterial
          color="#5ecbff"
          transparent
          opacity={0.11}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS * 1.018, 128, 64]} />
        <meshBasicMaterial
          color="#8edfff"
          transparent
          opacity={0.042}
          side={THREE.FrontSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function GlobeGrid({ radius }: { radius: number }) {
  const { lineGeometry, dotGeometry } = useMemo(() => {
    const vertices: number[] = [];
    const dots: number[] = [];
    const segments = 144;

    for (let lat = -60; lat <= 60; lat += 30) {
      const phi = THREE.MathUtils.degToRad(90 - lat);
      for (let i = 0; i < segments; i++) {
        const thetaA = (i / segments) * Math.PI * 2;
        const thetaB = ((i + 1) / segments) * Math.PI * 2;
        vertices.push(
          -radius * Math.sin(phi) * Math.cos(thetaA),
          radius * Math.cos(phi),
          radius * Math.sin(phi) * Math.sin(thetaA),
          -radius * Math.sin(phi) * Math.cos(thetaB),
          radius * Math.cos(phi),
          radius * Math.sin(phi) * Math.sin(thetaB),
        );
      }
    }

    for (let lon = -150; lon <= 180; lon += 30) {
      const theta = THREE.MathUtils.degToRad(lon + 180);
      for (let i = 0; i < segments; i++) {
        const phiA = THREE.MathUtils.degToRad(12 + (156 * i) / segments);
        const phiB = THREE.MathUtils.degToRad(12 + (156 * (i + 1)) / segments);
        vertices.push(
          -radius * Math.sin(phiA) * Math.cos(theta),
          radius * Math.cos(phiA),
          radius * Math.sin(phiA) * Math.sin(theta),
          -radius * Math.sin(phiB) * Math.cos(theta),
          radius * Math.cos(phiB),
          radius * Math.sin(phiB) * Math.sin(theta),
        );
      }
    }

    for (let lat = -60; lat <= 60; lat += 30) {
      const phi = THREE.MathUtils.degToRad(90 - lat);
      for (let lon = -150; lon <= 180; lon += 30) {
        const theta = THREE.MathUtils.degToRad(lon + 180);
        dots.push(
          -radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.cos(phi),
          radius * Math.sin(phi) * Math.sin(theta),
        );
      }
    }

    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    const gridDotsGeometry = new THREE.BufferGeometry();
    gridDotsGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(dots, 3),
    );
    return { lineGeometry: gridGeometry, dotGeometry: gridDotsGeometry };
  }, [radius]);

  return (
    <>
      <lineSegments geometry={lineGeometry}>
        <lineBasicMaterial
          color="#d9f6ff"
          transparent
          opacity={0.16}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
      <points geometry={dotGeometry}>
        <pointsMaterial
          color="#ffffff"
          size={0.014}
          transparent
          opacity={0.38}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </>
  );
}

export default function GlobeEarth({
  circuits,
  selectedCircuit,
  hoveredCircuit,
  focusCircuit,
  focusRegion,
  cardTopPx,
  onHoverCircuit,
  onSelectCircuit,
  onClearHover,
  onEarthReady,
  onActiveMarkerScreenPosition,
}: GlobeEarthProps) {
  const { camera, size } = useThree();
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
  const { textureSet: earthTextures, loading: earthLoading } =
    useEarthTexture(EARTH_DAY_TEXTURE);
  const cloudTexture = useOptionalTexture(EARTH_CLOUDS_TEXTURE);

  useEffect(() => {
    if (!earthLoading && earthTextures) onEarthReady?.();
  }, [earthLoading, earthTextures, onEarthReady]);

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
        const markerRadius = EARTH_RADIUS + MARKER_SURFACE_OFFSET;
        const dMarker = Math.max(distance - markerRadius, 0.001);
        // Camera pivots around the globe center (lookAt 0,0,0), so a camera
        // shift of `s` moves the marker by `s * markerRadius / distance`.
        // Solve for the camera shift that lifts the marker by `liftPx` px.
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
    lastFocusRegionKeyRef.current = key;

    const direction = latLonToVector3(focusRegion.lat, focusRegion.lon, 1)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), GLOBE_ROTATION_Y)
      .normalize();
    const distance = camera.position.length();

    focusStartRef.current = camera.position.clone().normalize();
    focusDistanceRef.current = distance;
    focusTargetRef.current = direction.clone().multiplyScalar(distance);
    focusProgressRef.current = 0;
  }, [camera, focusRegion]);

  useFrame(() => {
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
      persp.fov = focusStartFovRef.current + (focusFovRef.current - focusStartFovRef.current) * t;
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

    const markerPosition = markerPositionForCircuit(
      activeCircuit,
      EARTH_RADIUS + MARKER_SURFACE_OFFSET,
      markerOffsets.get(activeCircuit.id),
    ).applyAxisAngle(new THREE.Vector3(0, 1, 0), GLOBE_ROTATION_Y);
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
      <color attach="background" args={["#03050a"]} />
      <fog attach="fog" args={["#03050a", 8, 13]} />
      <ambientLight intensity={0.1} />
      <directionalLight
        position={[5.5, 3.2, 6.2]}
        intensity={1.38}
        color="#f3fbff"
      />
      <directionalLight
        position={[-4.5, 0.5, -4.2]}
        intensity={0.42}
        color="#4bbcff"
      />
      <pointLight position={[-4, -2, -3]} intensity={0.35} color="#e10600" />
      <Stars
        radius={80}
        depth={35}
        count={1900}
        factor={2.6}
        saturation={0}
        fade
        speed={0.22}
      />
      <group rotation={[0, GLOBE_ROTATION_Y, 0]}>
        {earthTextures && (
          <>
            <EarthSphere textures={earthTextures} cloudTexture={cloudTexture} />
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
          userInteractedRef.current = true;
          focusTargetRef.current = null;
        }}
      />
    </>
  );
}
