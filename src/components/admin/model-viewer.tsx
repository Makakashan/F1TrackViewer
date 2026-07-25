"use client";

import { Canvas, useStore } from "@react-three/fiber";
import { Grid, OrbitControls, useGLTF, useProgress } from "@react-three/drei";
import { Suspense, useEffect, useMemo } from "react";
import * as THREE from "three";
import { computeGltfStats, type GltfStats } from "@/lib/gltf-stats";

export interface ModelViewerProps {
  url: string;
  wireframe: boolean;
  autoRotate: boolean;
  /** Rescale to a real car's length so models can be compared like for like. */
  normalize: boolean;
  showGrid: boolean;
  onStats: (stats: GltfStats) => void;
}

/**
 * Studio rig, built by hand rather than with drei's <Environment>: that pulls
 * an HDR from a CDN, which would make an offline or air-gapped admin session
 * render the car black. Three lights and an ambient fill are enough to read
 * bodywork shape, which is the whole job here.
 */
function StudioLights() {
  return (
    <>
      {/* Lit brighter than a scene rig would be. Inspection models are often
          matte black — an unliveried car especially — and a realistic key/fill
          ratio renders those as a silhouette with no readable panel lines. */}
      <ambientLight intensity={0.85} />
      <hemisphereLight args={["#dfe6f2", "#31353d", 0.9]} />
      <directionalLight position={[6, 9, 5]} intensity={2.8} />
      <directionalLight position={[-7, 5, -4]} intensity={1.3} color="#9fc4ff" />
      <directionalLight position={[0, 3, -9]} intensity={1} color="#ff6a5e" />
    </>
  );
}

/**
 * Pull the camera back far enough to hold the whole model, once.
 *
 * A fixed starting position cannot serve an inspector: models arrive authored
 * in metres, centimetres or arbitrary units, and with the scale toggle off a
 * hardcoded distance frames one model perfectly and puts the next one either
 * inside the near plane or in the far distance. Deriving it from the bounds and
 * the field of view makes the opening shot the same for every asset.
 *
 * Camera and controls are read from the store rather than useThree() values:
 * mutating a hook's return value is what the immutability lint rule exists to
 * catch, and this genuinely has to write to the live camera.
 */
function FrameCamera({ length, height }: { length: number; height: number }) {
  const store = useStore();

  useEffect(() => {
    if (!(length > 0)) return;
    const { camera, controls } = store.getState();
    const perspective = camera as THREE.PerspectiveCamera;

    const radius = Math.max(length, height) * 0.5;
    const fov = (perspective.fov * Math.PI) / 180;
    // Enough headroom that a three-quarter view of a long, low car never
    // clips at the corners, without leaving the subject stranded in the middle
    // of an empty grid.
    const distance = (radius / Math.tan(fov / 2)) * 1.25;

    perspective.position.set(
      distance * 0.6,
      distance * 0.42,
      distance * 0.68,
    );
    perspective.near = Math.max(distance / 500, 0.0001);
    perspective.far = distance * 100;
    perspective.updateProjectionMatrix();

    const orbit = controls as unknown as {
      target?: THREE.Vector3;
      update?: () => void;
    } | null;
    // Aim a little below the midpoint: a car's visual mass sits low, and
    // centring the bounding box leaves it sinking out of the bottom of frame.
    orbit?.target?.set(0, height * 0.45, 0);
    orbit?.update?.();
  }, [length, height, store]);

  return null;
}

function Model({
  url,
  wireframe,
  normalize,
  onStats,
}: Omit<ModelViewerProps, "autoRotate" | "showGrid">) {
  const gltf = useGLTF(url);

  // Clone the scene *and* its materials. useGLTF caches by URL, so mutating
  // what it returns — which the wireframe toggle does — would leak into every
  // later mount of the same model, including after switching away and back.
  const scene = useMemo(() => {
    const root = gltf.scene.clone(true);
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => m.clone())
        : mesh.material.clone();
    });
    return root;
  }, [gltf.scene]);

  // Measured on the original scene, never the clone: cloning materials above
  // gives every mesh its own instance, which would defeat the identity-based
  // deduplication and report one material and one texture set per mesh.
  const stats = useMemo(
    () => computeGltfStats(gltf.scene, gltf.animations),
    [gltf.scene, gltf.animations],
  );

  useEffect(() => {
    onStats(stats);
  }, [stats, onStats]);

  useEffect(() => {
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of list) {
        (material as THREE.MeshStandardMaterial).wireframe = wireframe;
      }
    });
  }, [scene, wireframe]);

  // Sit the model on the grid and centre it horizontally, so switching models
  // does not also move the subject out of frame.
  //
  // The bounds come from stats, which measured the scene before it was
  // parented. Re-measuring here would read through this very group's scale —
  // Box3.setFromObject works in world space — and the offset would compound
  // every time the scale toggle re-ran the calculation.
  const { scale, offset } = useMemo(() => {
    const factor = normalize ? stats.scaleToReference : 1;
    return {
      scale: factor,
      offset: new THREE.Vector3(
        -stats.center.x,
        -stats.minY,
        -stats.center.z,
      ).multiplyScalar(factor),
    };
  }, [normalize, stats.scaleToReference, stats.center, stats.minY]);

  return (
    <>
      <FrameCamera
        length={stats.footprint.length * scale}
        height={stats.footprint.height * scale}
      />
      <group position={offset} scale={scale}>
        <primitive object={scene} />
      </group>
    </>
  );
}

function LoadingOverlay() {
  const { progress, active } = useProgress();
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm">
      <div className="w-56">
        <div className="mb-2 flex items-baseline justify-between font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          <span>Loading</span>
          <span className="tabular-nums text-foreground">
            {progress.toFixed(0)}%
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-border">
          <div
            className="h-full bg-primary transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

export default function ModelViewer({
  url,
  wireframe,
  autoRotate,
  normalize,
  showGrid,
  onStats,
}: ModelViewerProps) {
  return (
    <div className="relative h-full w-full">
      <Canvas
        // Keyed by URL so switching models tears the scene down rather than
        // leaving the previous car's geometry resident.
        key={url}
        camera={{ position: [7, 4.2, 8.5], fov: 42, near: 0.05, far: 500 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#111318"]} />
        <StudioLights />
        <Suspense fallback={null}>
          <Model
            url={url}
            wireframe={wireframe}
            normalize={normalize}
            onStats={onStats}
          />
        </Suspense>
        {showGrid && (
          <Grid
            args={[40, 40]}
            cellSize={0.5}
            cellThickness={0.6}
            cellColor="#2c313b"
            sectionSize={2.5}
            sectionThickness={1.1}
            sectionColor="#454d5c"
            fadeDistance={45}
            fadeStrength={1.4}
            infiniteGrid
            followCamera={false}
          />
        )}
        <OrbitControls
          makeDefault
          autoRotate={autoRotate}
          autoRotateSpeed={0.9}
          enableDamping
          dampingFactor={0.08}
          minDistance={1.5}
          maxDistance={80}
          target={[0, 0.7, 0]}
        />
      </Canvas>
      <LoadingOverlay />
    </div>
  );
}
