/**
 * Build one car per 2025 team from a single base model.
 *
 * The base model is shared geometry — a generic current-generation car with no
 * livery — and each team differs only by the three colours in
 * scripts/f1-teams-2025.ts. Generating them here rather than shipping ten
 * authored assets means a change to the palette, the optimizer or the base
 * model propagates to the whole grid with one command.
 *
 * The optimizer runs in-process rather than as ten subprocesses: each run
 * parses and rewrites a 14 MB glTF, and paying the startup and parse cost ten
 * times over adds up for no benefit.
 *
 * Usage:
 *   bun scripts/generate-team-cars.ts cars/apx_gp.glb
 *   bun scripts/generate-team-cars.ts cars/apx_gp.glb --ratio 0.3
 */

import { join } from "node:path";
import { TEAMS_2025 } from "./f1-teams-2025";
import { optimizeModel } from "./optimize-car-model";

const OUTPUT_DIR = join(new URL("..", import.meta.url).pathname, "cars");

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const ratioIndex = argv.indexOf("--ratio");
  const ratio = ratioIndex >= 0 ? Number(argv[ratioIndex + 1]) : 1;
  const suffix = ratio < 1 ? "_lod" : "";

  const input = positional[0];
  if (!input) {
    console.log(
      "usage: bun scripts/generate-team-cars.ts <base.glb> [--ratio 0.3]",
    );
    process.exit(2);
  }

  console.log(`base  ${input}`);
  console.log(`teams ${TEAMS_2025.length}${ratio < 1 ? `, ratio ${ratio}` : ""}\n`);

  let totalGzip = 0;
  for (const team of TEAMS_2025) {
    const output = join(OUTPUT_DIR, `f1_${team.id}${suffix}.glb`);
    const result = await optimizeModel({
      input,
      output,
      textureSize: 512,
      ratio,
      error: 0.001,
      stripTextures: false,
      paint: true,
      livery: team.livery,
      keepDecals: false,
      gzip: false,
      quiet: true,
    });
    totalGzip += result.gzipBytes;
    console.log(
      `${team.name.padEnd(18)} ${team.livery.body}  ` +
        `${mb(result.gzipBytes).padStart(8)} gz  ` +
        `${result.trianglesAfter.toLocaleString().padStart(9)} tris`,
    );
  }

  console.log(
    `\n${TEAMS_2025.length} cars, ${mb(totalGzip)} total over the wire`,
  );
  console.log("run `bun run cars:generate` to publish them");
}

main();
