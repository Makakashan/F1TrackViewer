"use client";

import { useEffect, useMemo, useRef } from "react";
import { useCursor } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { latLonToVector3 } from "./globe-surface";

export interface GlobeCircuit {
  id: string;
  name: string;
  shortName: string;
  country: string;
  lat: number;
  lon: number;
  type: string;
  hasEnvironment: boolean;
  hasTerrain: boolean;
}

export interface MarkerOffset {
  angle: number;
  magnitude: number;
}

export function markerPositionForCircuit(
  circuit: Pick<GlobeCircuit, "lat" | "lon">,
  radius: number,
  visualOffset?: MarkerOffset,
) {
  const basePosition = latLonToVector3(circuit.lat, circuit.lon, radius);
  if (!visualOffset || visualOffset.magnitude <= 0) return basePosition;

  const surfaceNormal = basePosition.clone().normalize();
  const east = new THREE.Vector3(0, 1, 0).cross(surfaceNormal);
  if (east.lengthSq() < 0.0001) east.set(1, 0, 0);
  east.normalize();
  const north = surfaceNormal.clone().cross(east).normalize();
  const tangentOffset = east
    .multiplyScalar(Math.cos(visualOffset.angle) * visualOffset.magnitude)
    .add(
      north.multiplyScalar(
        Math.sin(visualOffset.angle) * visualOffset.magnitude,
      ),
    );

  return basePosition.add(tangentOffset).normalize().multiplyScalar(radius);
}

/** Half the side of a marker's quad: room for the widest pulse ring. */
const QUAD_HALF = 0.09;
/** Within this of the quad's centre a pointer counts as on the marker. */
const HIT_RADIUS = 0.06;
const STATE_IDLE = 0;
const STATE_HOVERED = 1;
const STATE_SELECTED = 2;

const markerMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    defines: { QUAD_HALF: QUAD_HALF.toFixed(4) },
    transparent: true,
    depthWrite: false,
    // The relief stands taller than a marker's quad in the mountains; the horizon fade hides the far side instead.
    depthTest: false,
    vertexShader: /* glsl */ `
      attribute float state;
      uniform float time;
      varying vec2 vPoint;
      varying float vFade;
      varying float vState;

      void main() {
        vec4 centre = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float facing = dot(normalize(centre.xyz), normalize(cameraPosition));
        float fade = smoothstep(-0.08, 0.25, facing);
        vFade = state > 0.5 ? clamp(fade, 0.35, 1.0) : fade;
        vState = state;
        float scale = state > 1.5 ? 1.55 * (1.0 + sin(time * 2.4) * 0.1) : state > 0.5 ? 1.45 : 1.0;
        vPoint = position.xy * scale;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position * scale, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float time;
      varying vec2 vPoint;
      varying float vFade;
      varying float vState;

      const vec3 RED = vec3(0.882, 0.024, 0.0);

      float band(float d, float inner, float outer, float aa) {
        return smoothstep(inner - aa, inner, d) * (1.0 - smoothstep(outer, outer + aa, d));
      }

      void main() {
        float scale = vState > 1.5 ? 1.55 * (1.0 + sin(time * 2.4) * 0.1) : vState > 0.5 ? 1.45 : 1.0;
        float d = length(vPoint) / scale;
        float aa = fwidth(d);
        float isActive = step(0.5, vState);

        // A soft red halo peaking just outside the dot.
        float g = d / 0.04;
        float glow = g < 0.42 ? mix(0.06, 0.42, smoothstep(0.0, 0.42, g)) : 0.42 * (1.0 - smoothstep(0.42, 1.0, g));
        glow *= mix(0.7, 1.5, isActive);

        float core = 1.0 - smoothstep(0.015 - aa, 0.015, d);
        float rim = band(d, 0.015, 0.0185, aa);

        float cycle = fract(time * 1.3);
        float pulseScale = 1.0 + cycle * 2.2;
        float pulse = isActive * band(d, 0.022 * pulseScale, 0.026 * pulseScale, aa) * (1.0 - cycle) * (1.0 - cycle) * 0.6;

        vec3 color = RED;
        float alpha = glow;
        color = mix(color, vec3(1.0), max(rim, pulse));
        alpha = max(alpha, max(rim * mix(0.9, 1.0, isActive), pulse));
        color = mix(color, RED, core);
        alpha = max(alpha, core);

        gl_FragColor = vec4(color, alpha * vFade);
        #include <colorspace_fragment>
      }
    `,
  });

/** Only markers on the near side, and only within the dot's reach, take the pointer. */
function nearSideRaycast(camera: THREE.Camera) {
  const centre = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  return function (this: THREE.InstancedMesh, raycaster: THREE.Raycaster, hits: THREE.Intersection[]) {
    const found: THREE.Intersection[] = [];
    THREE.InstancedMesh.prototype.raycast.call(this, raycaster, found);
    for (const hit of found) {
      if (hit.instanceId === undefined) continue;
      this.getMatrixAt(hit.instanceId, matrix);
      centre.setFromMatrixPosition(matrix.premultiply(this.matrixWorld));
      if (hit.point.distanceTo(centre) > HIT_RADIUS) continue;
      if (centre.normalize().dot(camera.position) < -0.02 * camera.position.length()) continue;
      hits.push(hit);
    }
  };
}

interface GlobeMarkersProps {
  circuits: GlobeCircuit[];
  /** Where each marker stands, in globe space. */
  positions: THREE.Vector3[];
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (circuit: GlobeCircuit) => void;
  onSelect: (circuit: GlobeCircuit) => void;
  onBlur: () => void;
}

/** Every circuit marker in one instanced draw; the dot, rim, glow and pulse are drawn by the fragment shader. */
export default function GlobeMarkers({
  circuits,
  positions,
  selectedId,
  hoveredId,
  onHover,
  onSelect,
  onBlur,
}: GlobeMarkersProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const { camera, invalidate } = useThree();
  const geometry = useMemo(() => {
    const quad = new THREE.PlaneGeometry(QUAD_HALF * 2, QUAD_HALF * 2);
    quad.setAttribute(
      "state",
      new THREE.InstancedBufferAttribute(new Float32Array(circuits.length), 1),
    );
    return quad;
  }, [circuits.length]);
  const material = useMemo(() => markerMaterial(), []);
  const active = selectedId !== null || hoveredId !== null;
  useCursor(hoveredId !== null);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const forward = new THREE.Vector3(0, 0, 1);
    const unit = new THREE.Vector3(1, 1, 1);
    positions.forEach((position, index) => {
      rotation.setFromUnitVectors(forward, position.clone().normalize());
      mesh.setMatrixAt(index, matrix.compose(position, rotation, unit));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [positions, invalidate]);

  useEffect(() => {
    const state = geometry.getAttribute("state") as THREE.InstancedBufferAttribute;
    circuits.forEach((circuit, index) => {
      state.setX(
        index,
        circuit.id === selectedId ? STATE_SELECTED : circuit.id === hoveredId ? STATE_HOVERED : STATE_IDLE,
      );
    });
    state.needsUpdate = true;
    invalidate();
  }, [circuits, geometry, selectedId, hoveredId, invalidate]);

  useFrame(({ clock }) => {
    if (!active || !meshRef.current) return;
    (meshRef.current.material as THREE.ShaderMaterial).uniforms.time.value = clock.elapsedTime;
    // The pulse is the only thing on the globe that moves on its own.
    invalidate();
  });

  const raycast = useMemo(() => nearSideRaycast(camera), [camera]);

  const circuitOf = (event: ThreeEvent<PointerEvent | MouseEvent>) =>
    event.instanceId === undefined ? undefined : circuits[event.instanceId];

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, circuits.length]}
      raycast={raycast}
      frustumCulled={false}
      renderOrder={2}
      onPointerMove={(event) => {
        event.stopPropagation();
        const circuit = circuitOf(event);
        if (circuit && circuit.id !== hoveredId) onHover(circuit);
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        onBlur();
      }}
      onClick={(event) => {
        event.stopPropagation();
        const circuit = circuitOf(event);
        if (circuit) onSelect(circuit);
      }}
    />
  );
}
