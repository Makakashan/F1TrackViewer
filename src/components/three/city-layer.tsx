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
  /** Weaker devices stop at the city belt and skip the core's detail. */
  lowDetail?: boolean;
  /** Whether the sun casts a shadow map this scene has to take part in. */
  shadows?: boolean;
  onBeltLoaded?: (belt: CityBelt) => void;
}

/**
 * Repaints a loaded belt for the theme.
 *
 * The bake writes one palette into the GLB's materials, so the dark theme used
 * to get a white model in a black room. Each mesh is named for its kind, which
 * is the material it was given, so the colour is a lookup rather than a guess —
 * and setting it costs nothing per frame: the value lives in the material.
 */
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

/** Meshes that lie *on* the ground rather than being it, and z-fight with it. */
const DECAL_MESHES = new Set(["park", "pool", "pitch"]);

/**
 * Lifts the flat surfaces off the ground in the depth buffer.
 *
 * A park, a pool and a pitch are baked 0.12 m above the terrain, which is the
 * depth buffer's whole precision at two kilometres — camera near is 2 m and far
 * 20 km, so at that range a step of about 0.12 m is one unit of depth and the
 * two surfaces flickered against each other across the city. Lifting the
 * geometry instead would make a park float when the camera is on the street;
 * `polygonOffset` biases the comparison rather than the model, which is what it
 * is for.
 */
function liftDecals(group: THREE.Group) {
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    if (!DECAL_MESHES.has(node.name)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = -2;
      material.polygonOffsetUnits = -4;
      material.needsUpdate = true;
    }
  });
}

/**
 * Which meshes take part in the sun's shadow.
 *
 * A wall casts and takes one; the ground only takes. Water takes nothing — a
 * shadow on the sea reads as a stain, and the quad is one triangle pair over
 * the whole bay. The far belt is in it too: at a kilometre a block's shadow is
 * the only thing that says the block has depth.
 */
const SHADOW_CASTERS = new Set<BakedMeshKind>([
  "building",
  "model",
  "prop",
  "propDark",
  "barrier",
  "portal",
  "plinth",
]);
const SHADOW_CATCHERS = new Set<BakedMeshKind>([
  "terrain",
  "pier",
  "shore",
  "park",
  "pitch",
  "building",
  "model",
  "prop",
  "propDark",
  "plinth",
  "boreRoad",
]);

function setShadows(group: THREE.Group, on: boolean): void {
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const kind = node.name as BakedMeshKind;
    // The far belt takes shadow but does not cast one: at 600 m and beyond a
    // block's own shadow is a few pixels, and it is a third of the geometry
    // the sun's pass would have to draw.
    const belt = node.parent?.name ?? node.name;
    const casts = SHADOW_CASTERS.has(kind) && belt !== "city-far";
    node.castShadow = on && casts;
    node.receiveShadow = on && SHADOW_CATCHERS.has(kind);
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
  lowDetail,
  shadows = false,
  onBeltLoaded,
}: CityLayerProps) {
  const invalidate = useThree((state) => state.invalidate);
  const rootRef = useRef<THREE.Group>(null);
  // A belt lands between renders and has to arrive already painted, so the
  // loader reads the theme through a ref rather than depending on it — a
  // dependency there would refetch every belt on a theme switch.
  const themeRef = useRef(resolvedTheme);
  // Read through a ref for the same reason the theme is: a belt lands between
  // renders and has to arrive already set, and a dependency here would refetch
  // every belt when the quality setting changes.
  const shadowsRef = useRef(shadows);
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
          paintForTheme(gltf.scene, themeRef.current);
          liftDecals(gltf.scene);
          setShadows(gltf.scene, shadowsRef.current);
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
    const root = rootRef.current;
    if (!root) return;
    themeRef.current = resolvedTheme;
    paintForTheme(root, resolvedTheme);
    invalidate();
  }, [resolvedTheme, invalidate]);

  useEffect(() => {
    const root = rootRef.current;
    shadowsRef.current = shadows;
    if (!root) return;
    setShadows(root, shadows);
    invalidate();
  }, [shadows, invalidate]);

  useEffect(() => {
    if (error) console.warn(`city layer: ${error}`);
  }, [error]);

  return <group ref={rootRef} name="city" />;
}
