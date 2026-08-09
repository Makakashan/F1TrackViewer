"use client";

import { Grid, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useStore } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import CarFleet, { type CarFleetStats } from "@/components/three/car-fleet";

export interface FleetViewportProps {
  url: string;
  count: number;
  onStats: (stats: CarFleetStats) => void;
  onFps: (fps: number) => void;
}

/** Samples the real frame rate once a second. */
function FpsProbe({ onFps }: { onFps: (fps: number) => void }) {
  const frames = useRef(0);
  const since = useRef(performance.now());

  useFrame(() => {
    frames.current++;
    const now = performance.now();
    const elapsed = now - since.current;
    if (elapsed < 1000) return;
    onFps(Math.round((frames.current * 1000) / elapsed));
    frames.current = 0;
    since.current = now;
  });

  return null;
}

/** Frame the formation from its own extent. */
function FrameFormation({ radius }: { radius: number }) {
  const store = useStore();

  useEffect(() => {
    if (!(radius > 0)) return;
    const { camera, controls } = store.getState();
    const perspective = camera as THREE.PerspectiveCamera;
    const fov = (perspective.fov * Math.PI) / 180;
    const distance = (radius / Math.tan(fov / 2)) * 1.15;

    perspective.position.set(distance * 0.55, distance * 0.42, distance * 0.72);
    perspective.near = Math.max(distance / 200, 0.5);
    // Kept tight.
    perspective.far = distance * 6;
    perspective.updateProjectionMatrix();

    const orbit = controls as unknown as {
      target?: THREE.Vector3;
      update?: () => void;
    } | null;
    orbit?.target?.set(0, 0, 0);
    orbit?.update?.();
  }, [radius, store]);

  return null;
}

export default function FleetViewport({
  url,
  count,
  onStats,
  onFps,
}: FleetViewportProps) {
  const [radius, setRadius] = useState(0);

  const handleStats = useCallback(
    (stats: CarFleetStats) => {
      setRadius(stats.formationRadius);
      onStats(stats);
    },
    [onStats],
  );

  return (
    <div className="h-full w-full">
      <Canvas
        camera={{ position: [34, 20, 34], fov: 42, near: 0.5, far: 400 }}
        // Capped at 1.5 rather than the usual 2.
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#111318"]} />
        <ambientLight intensity={0.8} />
        <hemisphereLight args={["#dfe6f2", "#31353d", 0.9]} />
        <directionalLight position={[40, 60, 30]} intensity={2.4} />
        <directionalLight
          position={[-40, 30, -25]}
          intensity={1.1}
          color="#9fc4ff"
        />

        <Suspense fallback={null}>
          <CarFleet url={url} count={count} onStats={handleStats} />
        </Suspense>
        <FrameFormation radius={radius} />

        <Grid
          args={[200, 200]}
          cellSize={2}
          cellThickness={0.6}
          cellColor="#2c313b"
          sectionSize={10}
          sectionThickness={1.1}
          sectionColor="#454d5c"
          // Bounded by the formation rather than a constant, so the floor never outgrows the subject.
          fadeDistance={Math.max(radius * 3, 60)}
          fadeStrength={1.2}
          infiniteGrid
        />

        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          minDistance={6}
          maxDistance={600}
        />
        <FpsProbe onFps={onFps} />
      </Canvas>
    </div>
  );
}
