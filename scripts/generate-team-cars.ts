/** Build one car per 2025 team from a single base model. */

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
  const errorIndex = argv.indexOf("--error");
  // The default is tight enough that simplification barely bites on this model (76 meshes.
  const error = errorIndex >= 0 ? Number(argv[errorIndex + 1]) : 0.001;
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
      error,
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
