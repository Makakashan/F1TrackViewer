/**
 * Measure a loaded glTF scene: what it costs to draw and how big it is.
 *
 * The numbers a manifest can record stop at file size. Everything that decides
 * whether a model is usable — triangle count, how many draw calls it forces,
 * how much texture memory it pins, whether it is even the right size in metres
 * — only exists once the file is parsed, so it is computed here from the live
 * scene graph rather than from the glTF JSON.
 */

import * as THREE from "three";

/**
 * Length of a current-generation Formula 1 car, in metres. Used only to report
 * the factor a model would need to be scaled by; nothing here rescales.
 */
export const REFERENCE_CAR_LENGTH = 5.6;

export interface MaterialStat {
  name: string;
  /** Hex string, or null for materials with no base colour (e.g. raw shaders). */
  color: string | null;
  metalness: number | null;
  roughness: number | null;
  /** Map slots in use, e.g. ["map", "normalMap"]. */
  maps: string[];
  transparent: boolean;
}

export interface TextureStat {
  name: string;
  width: number;
  height: number;
  /** Uncompressed RGBA bytes including a full mip chain. */
  bytes: number;
}

export interface GltfStats {
  triangles: number;
  vertices: number;
  meshes: number;
  /** One per mesh/material pair — the real draw-call count. */
  drawCalls: number;
  nodes: number;
  materials: MaterialStat[];
  textures: TextureStat[];
  textureBytes: number;
  animations: { name: string; duration: number }[];
  /** Bounding box size on the raw axes, in the file's own units. */
  size: { x: number; y: number; z: number };
  /**
   * Bounding box centre and floor, in the file's own units.
   *
   * Recorded here because this is the one place the scene is measured while
   * still detached. Box3.setFromObject walks world matrices, so re-measuring
   * after the object has been parented into a scaled group returns world-space
   * bounds and silently multiplies any offset derived from them.
   */
  center: { x: number; y: number; z: number };
  minY: number;
  /**
   * Bounding box resolved into car terms. Models arrive facing +X or +Z with
   * no way to tell from the file which it is, so length is simply the longer
   * horizontal extent — reporting raw x/y/z as L/W/H mislabels half of them.
   */
  footprint: { length: number; width: number; height: number };
  /** Longest horizontal axis — what a car's length normalization keys off. */
  longestAxis: number;
  /** Factor that would bring the model to REFERENCE_CAR_LENGTH. */
  scaleToReference: number;
}

/** A mip chain converges to 4/3 of the base level. */
const MIPMAP_OVERHEAD = 4 / 3;

function textureSize(texture: THREE.Texture): { w: number; h: number } {
  const image = texture.image as
    | { width?: number; height?: number }
    | undefined;
  return { w: image?.width ?? 0, h: image?.height ?? 0 };
}

function collectMaps(material: THREE.Material): string[] {
  const slots = [
    "map",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "emissiveMap",
    "alphaMap",
    "clearcoatMap",
    "sheenColorMap",
    "specularMap",
  ] as const;
  const record = material as unknown as Record<string, THREE.Texture | null>;
  return slots.filter((slot) => record[slot]);
}

export function computeGltfStats(
  scene: THREE.Object3D,
  animations: THREE.AnimationClip[] = [],
): GltfStats {
  let triangles = 0;
  let vertices = 0;
  let meshes = 0;
  let drawCalls = 0;
  let nodes = 0;

  // Deduplicate by object identity: glTF shares materials and textures across
  // primitives, and counting them per mesh would badly overstate both the
  // material list and texture memory.
  const materials = new Map<THREE.Material, MaterialStat>();
  const textures = new Map<THREE.Texture, TextureStat>();

  scene.traverse((object) => {
    nodes++;
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    meshes++;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position");
    if (position) vertices += position.count;
    if (geometry.index) triangles += geometry.index.count / 3;
    else if (position) triangles += position.count / 3;

    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    drawCalls += list.length;

    for (const material of list) {
      if (!material || materials.has(material)) continue;
      const standard = material as THREE.MeshStandardMaterial;
      materials.set(material, {
        name: material.name || material.type,
        color: standard.color ? `#${standard.color.getHexString()}` : null,
        metalness:
          typeof standard.metalness === "number" ? standard.metalness : null,
        roughness:
          typeof standard.roughness === "number" ? standard.roughness : null,
        maps: collectMaps(material),
        transparent: material.transparent,
      });

      const record = material as unknown as Record<string, THREE.Texture | null>;
      for (const slot of collectMaps(material)) {
        const texture = record[slot];
        if (!texture || textures.has(texture)) continue;
        const { w, h } = textureSize(texture);
        textures.set(texture, {
          name: texture.name || slot,
          width: w,
          height: h,
          bytes: Math.round(w * h * 4 * MIPMAP_OVERHEAD),
        });
      }
    }
  });

  const box = new THREE.Box3().setFromObject(scene);
  const empty = box.isEmpty();
  const size = empty ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  const center = empty
    ? new THREE.Vector3()
    : box.getCenter(new THREE.Vector3());
  const longestAxis = Math.max(size.x, size.z);

  const textureList = [...textures.values()].sort((a, b) => b.bytes - a.bytes);

  return {
    triangles: Math.round(triangles),
    vertices,
    meshes,
    drawCalls,
    nodes,
    materials: [...materials.values()],
    textures: textureList,
    textureBytes: textureList.reduce((sum, t) => sum + t.bytes, 0),
    animations: animations.map((clip) => ({
      name: clip.name,
      duration: clip.duration,
    })),
    size: { x: size.x, y: size.y, z: size.z },
    center: { x: center.x, y: center.y, z: center.z },
    minY: empty ? 0 : box.min.y,
    footprint: {
      length: longestAxis,
      width: Math.min(size.x, size.z),
      height: size.y,
    },
    longestAxis,
    scaleToReference:
      longestAxis > 1e-6 ? REFERENCE_CAR_LENGTH / longestAxis : 1,
  };
}
