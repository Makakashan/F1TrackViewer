"use client";

/**
 * Mounts the baked city (docs/city-generation.md D6, D14).
 *
 * The belts arrive far first, so the scene has a horizon before it has a
 * skyline. Nothing is built here — the geometry comes off disk the shape it
 * will be drawn in.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import {
  CITY_BELT_ORDER,
  cityBeltUrl,
  type CityBelt,
  type CityManifest,
} from "@/lib/env/city-loader";

export interface CityLayerProps {
  manifest: CityManifest;
  /** Weaker devices stop at the city belt and skip the core's detail. */
  lowDetail?: boolean;
  onBeltLoaded?: (belt: CityBelt) => void;
}

function disposeGroup(group: THREE.Group) {
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.dispose();
    const material = node.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

export default function CityLayer({ manifest, lowDetail, onBeltLoaded }: CityLayerProps) {
  const invalidate = useThree((state) => state.invalidate);
  const rootRef = useRef<THREE.Group>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const belts = CITY_BELT_ORDER.filter((belt) => !(lowDetail && belt === "core"));
    const loaded: THREE.Group[] = [];
    let cancelled = false;

    (async () => {
      for (const belt of belts) {
        try {
          const gltf = await loader.loadAsync(cityBeltUrl(manifest.circuitId, belt));
          if (cancelled) {
            disposeGroup(gltf.scene);
            return;
          }
          gltf.scene.name = `city-${belt}`;
          root.add(gltf.scene);
          loaded.push(gltf.scene);
          onBeltLoaded?.(belt);
          // frameloop is "demand": a belt that arrives outside a render is a
          // change nothing would otherwise draw.
          invalidate();
        } catch (err) {
          if (!cancelled) setError(`${belt}: ${String(err)}`);
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const group of loaded) {
        root.remove(group);
        disposeGroup(group);
      }
      invalidate();
    };
  }, [manifest.circuitId, lowDetail, invalidate, onBeltLoaded]);

  useEffect(() => {
    if (error) console.warn(`city layer: ${error}`);
  }, [error]);

  return <group ref={rootRef} name="city" />;
}
