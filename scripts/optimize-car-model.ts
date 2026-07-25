/**
 * Shrink a car .glb to something a browser can reasonably download.
 *
 * Marketplace car models are authored for offline renders, and the Sketchfab
 * exporter adds its own overhead on top. The Ferrari SF-25 that prompted this
 * arrived at 25.7 MB with 316k triangles, 40 materials and — the real culprit —
 * up to six TEXCOORD sets per mesh where the materials read exactly one. Five
 * dead UV sets across 230k vertices is roughly 9 MB of nothing.
 *
 * Every step below is chosen so the result still loads through a plain
 * GLTFLoader with no side-car decoder:
 *
 *   dedup + prune    Drop unreferenced accessors, materials and textures, and
 *                    the unused vertex attributes that dominate this file.
 *   simplify         Optional. The viewer frames the car from ~20 m, where a
 *                    third of the triangles are smaller than a pixel.
 *   weld             Merge coincident vertices so simplification and
 *                    quantization have a clean topology to work on.
 *   textureCompress  PNG -> WebP and a resolution cap. Several of these maps
 *                    are flat colours stored at 1024x1024.
 *   quantize         Pack attributes into integers via KHR_mesh_quantization,
 *                    which three.js supports natively. Draco and Meshopt
 *                    compress harder but each needs a decoder shipped and
 *                    wired into the loader; that trade is not worth it until
 *                    quantization alone stops being enough.
 *
 * Usage:
 *   bun scripts/optimize-car-model.ts cars/ferrari_sf_25.glb
 *   bun scripts/optimize-car-model.ts cars/ferrari_sf_25.glb --texture-size 256 --ratio 0.35
 *
 * Writes <name>.opt.glb next to the input, so the original stays put and both
 * can be compared side by side in the admin model lab.
 */

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  prune,
  quantize,
  simplify,
  textureCompress,
  weld,
} from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface Options {
  input: string;
  textureSize: number;
  /** Target fraction of the original triangle count; 1 disables simplification. */
  ratio: number;
  /** Largest allowed deviation during simplification, as a fraction of scene size. */
  error: number;
}

function parseArgs(argv: string[]): Options | null {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) flags.set(arg.slice(2), argv[++i] ?? "");
    else positional.push(arg);
  }
  if (positional.length === 0) return null;
  return {
    input: positional[0],
    textureSize: Number(flags.get("texture-size") ?? 512),
    ratio: Number(flags.get("ratio") ?? 1),
    error: Number(flags.get("error") ?? 0.001),
  };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.log(
      "usage: bun scripts/optimize-car-model.ts <model.glb> [--texture-size 512] [--ratio 1] [--error 0.001]",
    );
    process.exit(2);
  }

  const before = (await stat(options.input)).size;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(options.input);

  const countTriangles = () =>
    document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .reduce((sum, primitive) => {
        const indices = primitive.getIndices();
        const position = primitive.getAttribute("POSITION");
        const count = indices?.getCount() ?? position?.getCount() ?? 0;
        return sum + count / 3;
      }, 0);

  const trianglesBefore = countTriangles();
  const texturesBefore = document.getRoot().listTextures().length;

  const transforms = [
    dedup(),
    // keepAttributes: false is what removes TEXCOORD_1..5 and unreferenced
    // TANGENT data. It is the single largest win on Sketchfab exports.
    prune({ keepAttributes: false, keepLeaves: false }),
    weld(),
  ];

  if (options.ratio < 1) {
    transforms.push(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: options.ratio,
        error: options.error,
      }),
    );
  }

  transforms.push(
    textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      resize: [options.textureSize, options.textureSize],
    }),
    quantize({
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizeColor: 8,
    }),
    // A second prune: simplification and dedup can strand accessors that were
    // referenced when the pipeline started.
    prune({ keepAttributes: false, keepLeaves: false }),
  );

  await document.transform(...transforms);

  const output = join(
    dirname(options.input),
    `${basename(options.input).replace(/\.glb$/i, "")}.opt.glb`,
  );
  await writeFile(output, await io.writeBinary(document));

  const after = (await readFile(output)).byteLength;
  const trianglesAfter = countTriangles();

  console.log(`in    ${options.input}`);
  console.log(`out   ${output}`);
  console.log(
    `size  ${mb(before)} -> ${mb(after)}  (${(
      (1 - after / before) *
      100
    ).toFixed(1)}% smaller)`,
  );
  console.log(
    `tris  ${Math.round(trianglesBefore).toLocaleString()} -> ${Math.round(
      trianglesAfter,
    ).toLocaleString()}`,
  );
  console.log(
    `tex   ${texturesBefore} -> ${document.getRoot().listTextures().length}, capped at ${options.textureSize}px, webp`,
  );
}

main();
