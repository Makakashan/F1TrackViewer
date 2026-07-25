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

import { NodeIO, type Document, type Texture } from "@gltf-transform/core";
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
import { gzipSync } from "node:zlib";

/** sRGB -> linear. glTF factors are linear; texture pixels are not. */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Average colour of a texture, in linear space.
 *
 * Downsampled to 16x16 first: the mean of a livery is the same at that size,
 * and it avoids decoding a full 1024x1024 per material. Averaging is done
 * after the transfer function, not before — mixing sRGB values directly
 * biases every result toward the light end.
 */
async function averageColor(
  texture: Texture,
): Promise<[number, number, number] | null> {
  const image = texture.getImage();
  if (!image) return null;
  try {
    const { data, info } = await sharp(Buffer.from(image))
      .resize(16, 16, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let r = 0;
    let g = 0;
    let b = 0;
    const pixels = info.width * info.height;
    for (let i = 0; i < pixels; i++) {
      r += srgbToLinear(data[i * 3]);
      g += srgbToLinear(data[i * 3 + 1]);
      b += srgbToLinear(data[i * 3 + 2]);
    }
    return [r / pixels, g / pixels, b / pixels];
  } catch {
    return null;
  }
}

/** "#e10600" -> linear [r, g, b], the space glTF factors live in. */
function hexToLinear(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const int = parseInt(full, 16);
  return [
    srgbToLinear((int >> 16) & 255),
    srgbToLinear((int >> 8) & 255),
    srgbToLinear(int & 255),
  ];
}

interface PaintRule {
  pattern: RegExp;
  color: string;
  metalness: number;
  roughness: number;
}

/**
 * Flat-colour scheme applied by material name.
 *
 * An untextured car exports as uniform white: every material carries a
 * baseColorFactor of 1,1,1 and there is nothing else to tell the parts apart.
 * The geometry does distinguish them — models of this kind name their materials
 * after the part — so a name-keyed palette restores the read without any maps,
 * and survives re-exporting the model because it is applied at build time
 * rather than baked in.
 *
 * Order matters: the first pattern that matches wins, so the narrow rules
 * (steering-wheel carbon, tyre sidewalls) sit above the broad ones.
 */
const PAINT_RULES: PaintRule[] = [
  // Rubber first — "TYRE_SIDES" must not fall through to a generic rule.
  { pattern: /tyre.*(thread|tread)/i, color: "#141519", metalness: 0, roughness: 0.95 },
  { pattern: /tyre/i, color: "#17181c", metalness: 0, roughness: 0.88 },
  { pattern: /rim|wheel_hub/i, color: "#8b9099", metalness: 0.85, roughness: 0.3 },
  { pattern: /disc|brake|caliper/i, color: "#2b2b2e", metalness: 0.2, roughness: 0.62 },
  { pattern: /mirror/i, color: "#cfd6e0", metalness: 1, roughness: 0.06 },
  { pattern: /rear_light|light/i, color: "#c8102e", metalness: 0, roughness: 0.35 },
  { pattern: /led|lcd|screen/i, color: "#dfe6f2", metalness: 0, roughness: 0.25 },
  { pattern: /steeringwheel|sw_handle/i, color: "#202329", metalness: 0.1, roughness: 0.7 },
  { pattern: /carbon/i, color: "#1a1c21", metalness: 0.3, roughness: 0.45 },
  { pattern: /decal|number/i, color: "#e8ecf2", metalness: 0, roughness: 0.4 },
  { pattern: /detail/i, color: "#2a2e35", metalness: 0.35, roughness: 0.5 },
  { pattern: /generic/i, color: "#4a4f58", metalness: 0.2, roughness: 0.6 },
  // Bodywork last: "paint" is the broadest term and would otherwise swallow
  // anything named e.g. "sw_paint".
  { pattern: /paint|body|livery/i, color: "", metalness: 0.25, roughness: 0.32 },
];

/**
 * Paint materials by name. `bodyColor` fills in for the bodywork rule, which
 * is the one colour worth choosing per car rather than fixing in the table.
 */
function paintByName(document: Document, bodyColor: string) {
  const painted: string[] = [];
  const skipped: string[] = [];

  for (const material of document.getRoot().listMaterials()) {
    const name = material.getName() || "";
    const rule = PAINT_RULES.find((candidate) => candidate.pattern.test(name));
    if (!rule) {
      skipped.push(name || "(unnamed)");
      continue;
    }
    const alpha = material.getBaseColorFactor()[3] ?? 1;
    material.setBaseColorFactor([
      ...hexToLinear(rule.color || bodyColor),
      alpha,
    ]);
    material.setMetallicFactor(rule.metalness);
    material.setRoughnessFactor(rule.roughness);
    painted.push(name);
  }

  return { painted, skipped };
}

/**
 * Strip every texture, keeping each material's identity as a flat colour.
 *
 * Wanted for two unrelated reasons at once. It removes the livery — team
 * marks, sponsor logos, driver numbers — which is the part of a marketplace
 * car that carries somebody else's trademarks. And it deletes the entire
 * texture budget, which on this asset is most of the file and all of the
 * texture VRAM.
 *
 * Materials keep the average colour of the map they lose, so tyres stay black,
 * carbon stays dark and paint keeps its hue. Without that every material falls
 * back to its baseColorFactor, which for a texture-driven material is white —
 * a single white blob with no readable parts.
 */
async function stripCosmetics(document: Document): Promise<number> {
  let recoloured = 0;

  for (const material of document.getRoot().listMaterials()) {
    const base = material.getBaseColorTexture();
    if (base) {
      const average = await averageColor(base);
      if (average) {
        const alpha = material.getBaseColorFactor()[3] ?? 1;
        material.setBaseColorFactor([...average, alpha]);
        recoloured++;
      }
      material.setBaseColorTexture(null);
    }
    material.setNormalTexture(null);
    material.setMetallicRoughnessTexture(null);
    material.setEmissiveTexture(null);
    material.setOcclusionTexture(null);
  }

  // Orphaned textures and their images are cleared by the prune that follows.
  return recoloured;
}

interface Options {
  input: string;
  textureSize: number;
  /** Target fraction of the original triangle count; 1 disables simplification. */
  ratio: number;
  /** Largest allowed deviation during simplification, as a fraction of scene size. */
  error: number;
  /** Drop all textures, collapsing each material to a flat colour. */
  stripTextures: boolean;
  /** Apply the name-keyed palette; empty string disables painting. */
  bodyColor: string;
  paint: boolean;
  /** Also write a .glb.gz next to the output. */
  gzip: boolean;
}

function parseArgs(argv: string[]): Options | null {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  // Boolean flags take no value; treating them like the rest would swallow the
  // next argument.
  const booleans = new Set(["strip-textures", "gzip", "paint"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    flags.set(name, booleans.has(name) ? "true" : (argv[++i] ?? ""));
  }
  if (positional.length === 0) return null;
  return {
    input: positional[0],
    textureSize: Number(flags.get("texture-size") ?? 512),
    ratio: Number(flags.get("ratio") ?? 1),
    error: Number(flags.get("error") ?? 0.001),
    stripTextures: flags.has("strip-textures"),
    // --body implies --paint: asking for a colour and getting a white car
    // would be a surprising way to spend a build.
    paint: flags.has("paint") || flags.has("body"),
    bodyColor: flags.get("body") || "#e10600",
    gzip: flags.has("gzip"),
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

  let recoloured = 0;
  if (options.stripTextures) {
    recoloured = await stripCosmetics(document);
  }

  let paintReport: { painted: string[]; skipped: string[] } | null = null;
  if (options.paint) {
    // After stripCosmetics, so an explicit palette wins over colours averaged
    // out of the maps it removed.
    paintReport = paintByName(document, options.bodyColor);
  }

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

  if (!options.stripTextures) {
    transforms.push(
      textureCompress({
        encoder: sharp,
        targetFormat: "webp",
        resize: [options.textureSize, options.textureSize],
      }),
    );
  }

  transforms.push(
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

  const bytes = await readFile(output);
  const after = bytes.byteLength;
  const trianglesAfter = countTriangles();
  const texturesAfter = document.getRoot().listTextures().length;

  // Report the gzipped size whether or not a .gz is written: that is what
  // actually crosses the wire, since both Next's dev/standalone server and
  // GitHub Pages compress responses. Textured GLBs barely move — WebP and PNG
  // are already compressed — but a stripped model is quantized integers and
  // vertex data, which gzip does very well on.
  const gzipped = gzipSync(bytes, { level: 9 });

  if (options.gzip) {
    await writeFile(`${output}.gz`, gzipped);
  }

  console.log(`in    ${options.input}`);
  console.log(`out   ${output}`);
  console.log(
    `size  ${mb(before)} -> ${mb(after)}  (${(
      (1 - after / before) * 100
    ).toFixed(1)}% smaller)`,
  );
  console.log(
    `gzip  ${mb(gzipped.byteLength)} over the wire  (${(
      (1 - gzipped.byteLength / before) * 100
    ).toFixed(1)}% off the original)${options.gzip ? ` -> ${output}.gz` : ""}`,
  );
  console.log(
    `tris  ${Math.round(trianglesBefore).toLocaleString()} -> ${Math.round(
      trianglesAfter,
    ).toLocaleString()}`,
  );
  console.log(
    options.stripTextures
      ? `tex   ${texturesBefore} -> ${texturesAfter} (stripped; ${recoloured} materials recoloured from their maps)`
      : `tex   ${texturesBefore} -> ${texturesAfter}${
          texturesAfter ? `, capped at ${options.textureSize}px, webp` : ""
        }`,
  );
  if (paintReport) {
    console.log(
      `paint ${paintReport.painted.length} materials, body ${options.bodyColor}`,
    );
    if (paintReport.skipped.length) {
      console.log(
        `      unmatched, left as-is: ${paintReport.skipped.join(", ")}`,
      );
    }
  }
}

main();
