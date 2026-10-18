/** Writing baked meshes out as quantised, meshopt-compressed GLB. */

import { writeFile } from "node:fs/promises";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMeshQuantization } from "@gltf-transform/extensions";
import { meshopt, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { BAKED_MESH_COLORS, type BakedMeshKind } from "../../src/lib/env/diorama-palette";
import { isEmpty, type Mesh } from "./mesh";

export type MeshKind = BakedMeshKind;

/** The light set is what the bake writes; the dark one is the runtime's. */
const MESH_COLOR = BAKED_MESH_COLORS.light;

/** glTF base colour is linear; the palette is written the way CSS reads it. */
function srgbToLinear(hex: string): [number, number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(16), channel(8), channel(0), 1];
}

/** Meshes whose edges meet another file's share one quantisation lattice, or seams crack. */
const SEAMED_KINDS: ReadonlySet<MeshKind> = new Set(["terrain", "plinth"]);

/** The box every seamed mesh is quantised on: its centre and half its widest side. */
interface Lattice {
  offset: [number, number, number];
  scale: number;
}

export function latticeOf(meshes: Mesh[]): Lattice {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i++) {
      const axis = i % 3;
      if (mesh.positions[i] < min[axis]) min[axis] = mesh.positions[i];
      if (mesh.positions[i] > max[axis]) max[axis] = mesh.positions[i];
    }
  }
  const offset = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2) as Lattice["offset"];
  const scale = Math.max(...[0, 1, 2].map((axis) => (max[axis] - min[axis]) / 2));
  return { offset, scale };
}

export async function writeGlb(
  path: string,
  parts: { kind: MeshKind; mesh: Mesh }[],
  lattice: Lattice,
): Promise<number> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();

  const add = (kind: MeshKind, mesh: Mesh, positions: Float32Array<ArrayBuffer> | Int16Array<ArrayBuffer>) => {
    const material = document
      .createMaterial(kind)
      .setBaseColorFactor(srgbToLinear(MESH_COLOR[kind]))
      .setRoughnessFactor(kind === "water" ? 0.25 : 0.95)
      .setMetallicFactor(0)
      .setDoubleSided(false);

    const primitive = document
      .createPrimitive()
      .setMaterial(material)
      .setAttribute(
        "POSITION",
        document
          .createAccessor()
          .setType("VEC3")
          .setArray(positions)
          .setNormalized(positions instanceof Int16Array)
          .setBuffer(buffer),
      )
      .setAttribute(
        "NORMAL",
        document.createAccessor().setType("VEC3").setArray(new Float32Array(mesh.normals)).setBuffer(buffer),
      )
      .setAttribute(
        "COLOR_0",
        mesh.colors
          ? document
              .createAccessor()
              .setType("VEC3")
              .setArray(new Float32Array(mesh.colors))
              .setBuffer(buffer)
          : null,
      )
      .setIndices(
        document.createAccessor().setType("SCALAR").setArray(new Uint32Array(mesh.indices)).setBuffer(buffer),
      );

    const node = document.createNode(kind).setMesh(document.createMesh(kind).addPrimitive(primitive));
    scene.addChild(node);
    return node;
  };

  for (const { kind, mesh } of parts) {
    if (!isEmpty(mesh) && !SEAMED_KINDS.has(kind)) add(kind, mesh, new Float32Array(mesh.positions));
  }
  await MeshoptEncoder.ready;
  await document.transform(meshopt({ encoder: MeshoptEncoder }));

  // Quantised here rather than by `meshopt`, which would fit each its own box:
  // 14 bits spread over the int16 the way `quantize` stores them.
  const { offset, scale } = lattice;
  for (const { kind, mesh } of parts) {
    if (isEmpty(mesh) || !SEAMED_KINDS.has(kind)) continue;
    const positions = new Int16Array(mesh.positions.length);
    for (let i = 0; i < positions.length; i++) {
      const value = (mesh.positions[i] - offset[i % 3]) / scale;
      const step = Math.round(Math.min(1, Math.abs(value)) * 8191);
      positions[i] = Math.sign(value) * ((step << 2) | (step >> 11));
    }
    add(kind, mesh, positions).setTranslation(offset).setScale([scale, scale, scale]);
  }
  document.createExtension(KHRMeshQuantization).setRequired(true);
  await document.transform(
    quantize({ pattern: /^COLOR_0$/ }),
    reorder({ encoder: MeshoptEncoder, target: "size" }),
  );

  const glb = await new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder })
    .writeBinary(document);
  await writeFile(path, glb);
  return glb.byteLength;
}
