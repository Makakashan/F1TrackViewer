"use client";

/** Mounts the baked city. Belts arrive far first, so there is a horizon before a skyline. */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import { BAKED_MESH_COLORS, type BakedMeshKind } from "@/lib/env/diorama-palette";
import {
  CITY_BELT_ORDER,
  cityBeltUrl,
  type CityBelt,
  type CityManifest,
} from "@/lib/env/city-loader";

export interface CityLayerProps {
  manifest: CityManifest;
  /** The theme the scene is drawn in. The bake ships the light one. */
  resolvedTheme: "light" | "dark";
  onBeltLoaded?: (belt: CityBelt) => void;
  /** The look spike draws its own barrier along the track. */
  hideBarrier?: boolean;
  /** Admin only: draw the ground and nothing else, so its shading is its own. */
  terrainOnly?: boolean;
}

/** Repaint a belt for the theme by mesh name; the GLB carries only the light palette. */
function paintForTheme(group: THREE.Group, theme: "light" | "dark") {
  const palette = BAKED_MESH_COLORS[theme];
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const color = palette[node.name as BakedMeshKind];
    if (!color) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if ("color" in material) (material as THREE.MeshStandardMaterial).color.set(color);
    }
  });
}

/**
 * Meshes that z-fight with the ground: the ones that lie *on* it, and the
 * plinth's wall, which the seabed's edge meets in its own plane.
 */
const DECAL_MESHES = new Set(["park", "pool", "pitch", "plinth"]);

/**
 * `polygonOffset` instead of lifting the geometry: decals sit 0.12 m up, under the
 * depth precision at range, and a real lift would float them up close.
 */
function liftDecals(group: THREE.Group) {
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const name = node.name.replace(/_\d+$/, "");
    // The sea is the other way round: land is held only 0.25 m over it, and a
    // coastal flat like Jeddah's showed the water through it from a distance.
    const sign = DECAL_MESHES.has(name) ? -1 : name === "water" ? 1 : 0;
    if (!sign) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = 2 * sign;
      material.polygonOffsetUnits = 4 * sign;
      material.needsUpdate = true;
    }
  });
}

/** The look spike draws its own barrier along the track; the baked one would stand beside it. */
function setBarrierVisible(group: THREE.Object3D, visible: boolean) {
  group.traverse((node) => {
    if (node instanceof THREE.Mesh && node.name === "barrier") node.visible = visible;
  });
}

/** Everything but the ground off, so a shadow on the terrain is the terrain's own. */
const TERRAIN_TAB_KEEPS = new Set([
  "terrain",
  "water",
  "pier",
  "portal",
  "tunnel",
  "boreRoad",
  "plinth",
]);
function setTerrainOnly(group: THREE.Object3D, only: boolean) {
  group.traverse((node) => {
    // Water, quays, decks and the portal's sleeve are ground: hidden, the tab
    // shows pits the app never has. The loader numbers same-named meshes.
    if (node instanceof THREE.Mesh) {
      const kind = node.name.replace(/_\d+$/, "");
      node.visible = !only || TERRAIN_TAB_KEEPS.has(kind);
    }
  });
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

export default function CityLayer({
  manifest,
  resolvedTheme,
  onBeltLoaded,
  hideBarrier = false,
  terrainOnly = false,
}: CityLayerProps) {
  const invalidate = useThree((state) => state.invalidate);
  const rootRef = useRef<THREE.Group>(null);
  // A belt lands between renders and has to arrive already painted, so the
  // loader reads the theme through a ref rather than depending on it — a
  // dependency there would refetch every belt on a theme switch.
  const themeRef = useRef(resolvedTheme);
  const hideBarrierRef = useRef(hideBarrier);
  const terrainOnlyRef = useRef(terrainOnly);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const loaded: THREE.Group[] = [];
    let cancelled = false;

    (async () => {
      // Every device loads every belt: each belt owns its own blocks of ground, so
      // a phone that skipped the core was left with the sea round the track.
      for (const belt of CITY_BELT_ORDER) {
        try {
          const gltf = await loader.loadAsync(cityBeltUrl(manifest.circuitId, belt));
          if (cancelled) {
            disposeGroup(gltf.scene);
            return;
          }
          gltf.scene.name = `city-${belt}`;
          paintForTheme(gltf.scene, themeRef.current);
          liftDecals(gltf.scene);
          setBarrierVisible(gltf.scene, !hideBarrierRef.current);
          setTerrainOnly(gltf.scene, terrainOnlyRef.current);
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
  }, [manifest.circuitId, invalidate, onBeltLoaded]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    themeRef.current = resolvedTheme;
    paintForTheme(root, resolvedTheme);
    invalidate();
  }, [resolvedTheme, invalidate]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    hideBarrierRef.current = hideBarrier;
    setBarrierVisible(root, !hideBarrier);
    invalidate();
  }, [hideBarrier, invalidate]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    terrainOnlyRef.current = terrainOnly;
    setTerrainOnly(root, terrainOnly);
    if (!terrainOnly) setBarrierVisible(root, !hideBarrierRef.current);
    invalidate();
  }, [terrainOnly, invalidate]);

  useEffect(() => {
    if (error) console.warn(`city layer: ${error}`);
  }, [error]);

  return <group ref={rootRef} name="city" />;
}
