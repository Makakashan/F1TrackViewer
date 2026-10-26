"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { EARTH_RADIUS, latLonToVector3, type ReliefSampler } from "./globe-surface";

const HALO_LOOK = {
  // A thin blue limb of atmosphere against space.
  dark: { rim: new THREE.Color("#4f9dff"), rimStrength: 0.55, rimFalloff: 14, shadowStrength: 0 },
  // On a light page a wider haze melts the edge into the sky, and a shadow below lets the globe hang over something.
  light: { rim: new THREE.Color("#8fbaff"), rimStrength: 0.55, rimFalloff: 6, shadowStrength: 0.4 },
} as const;

/** Atmosphere rim and drop shadow on one camera-facing quad behind the globe. */
export function GlobeHalo({ theme }: { theme: "light" | "dark" }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          rim: { value: HALO_LOOK[theme].rim },
          rimStrength: { value: HALO_LOOK[theme].rimStrength },
          rimFalloff: { value: HALO_LOOK[theme].rimFalloff },
          shadowStrength: { value: HALO_LOOK[theme].shadowStrength },
        },
        transparent: true,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying vec2 vPoint;
          void main() {
            vPoint = position.xy;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 rim;
          uniform float rimStrength;
          uniform float rimFalloff;
          uniform float shadowStrength;
          varying vec2 vPoint;
          void main() {
            float r = length(vPoint);
            float glow = r < 1.0 ? 0.0 : exp(-(r - 1.0) * rimFalloff) * rimStrength;
            // A flat soft ellipse under the globe, as if it hovered above a floor.
            vec2 e = (vPoint - vec2(0.04, -1.12)) / vec2(0.82, 0.13);
            float shadow = (1.0 - smoothstep(0.15, 1.0, length(e))) * shadowStrength;
            vec3 color = mix(vec3(0.08, 0.12, 0.2), rim, glow / max(glow + shadow, 1e-4));
            gl_FragColor = vec4(color, max(glow, shadow));
            #include <colorspace_fragment>
          }
        `,
      }),
    [theme],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // The silhouette's radius in the plane through the centre, so r = 1 is the limb at any zoom.
    const d = camera.position.length();
    mesh.scale.setScalar((EARTH_RADIUS * d) / Math.sqrt(d * d - EARTH_RADIUS * EARTH_RADIUS));
    mesh.quaternion.copy(camera.quaternion);
  });

  return (
    <mesh ref={meshRef} material={material} renderOrder={-1}>
      <planeGeometry args={[3, 3]} />
    </mesh>
  );
}

const COUNTRY_BORDERS_URL = "/data/country-borders.json";
/** Circuit countries whose name in the borders data is different. */
const BORDER_NAMES: Record<string, string> = { "United States": "United States of America" };
const OUTLINE_LIFT = 0.003;

interface BorderFeature {
  n: string;
  /** polygons → rings → [lon, lat] */
  p: [number, number][][][];
}

let bordersRequest: Promise<BorderFeature[]> | null = null;
function loadBorders() {
  bordersRequest ??= fetch(COUNTRY_BORDERS_URL)
    .then((res) => (res.ok ? (res.json() as Promise<BorderFeature[]>) : []))
    .catch(() => []);
  return bordersRequest;
}

/** Traces the outline of one country on the relief: the country of the circuit in focus. */
export function CountryOutline({ country, sampler }: { country: string | null; sampler: ReliefSampler }) {
  const [features, setFeatures] = useState<BorderFeature[] | null>(null);

  useEffect(() => {
    if (!country || features) return;
    let cancelled = false;
    loadBorders().then((data) => {
      if (!cancelled) setFeatures(data);
    });
    return () => {
      cancelled = true;
    };
  }, [country, features]);

  const geometry = useMemo(() => {
    const feature = country && features?.find((f) => f.n === (BORDER_NAMES[country] ?? country));
    if (!feature) return null;
    const vertices: number[] = [];
    const point = (lon: number, lat: number) => {
      const v = latLonToVector3(lat, lon, sampler.radiusAt(lat, lon) + OUTLINE_LIFT);
      vertices.push(v.x, v.y, v.z);
    };
    for (const polygon of feature.p) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
          point(...ring[i]);
          point(...ring[(i + 1) % ring.length]);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    return geo;
  }, [country, features, sampler]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry) return null;
  return (
    // Over the relief rather than in it: the camera turns to the country, so it is always on the near side.
    <lineSegments geometry={geometry} renderOrder={1}>
      <lineBasicMaterial color="#ffffff" transparent opacity={0.85} depthWrite={false} depthTest={false} />
    </lineSegments>
  );
}
