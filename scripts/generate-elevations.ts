import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchElevations } from "../src/lib/geo-utils";
import type { CircuitGeoJSON, CircuitLocation } from "../src/lib/f1-circuits";

const RAW_BASE =
  "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
const ELEVATION_VERSION = 2;
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage:
  bun run elevations:generate
  bun run elevations:generate -- mc-1929 be-1921

Generates static elevation profiles in public/elevations/*.json.
Pass circuit ids to generate only specific circuits.`);
  process.exit(0);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function main() {
  const outDir = join(process.cwd(), "public", "elevations");
  await mkdir(outDir, { recursive: true });

  const circuits = await fetchJson<CircuitLocation[]>(
    `${RAW_BASE}/f1-locations.json`,
  );
  const requestedIds = new Set(args.filter((arg) => !arg.startsWith("-")));
  const selectedCircuits = requestedIds.size
    ? circuits.filter((circuit) => requestedIds.has(circuit.id))
    : circuits;

  for (const circuit of selectedCircuits) {
    const geojson = await fetchJson<CircuitGeoJSON>(
      `${RAW_BASE}/circuits/${circuit.id}.geojson`,
    );
    const coords = geojson.features[0]?.geometry.coordinates ?? [];
    const elevations = await fetchElevations(coords);

    if (!elevations) {
      console.warn(`skip ${circuit.id}: elevation API unavailable`);
      continue;
    }

    await writeFile(
      join(outDir, `${circuit.id}.json`),
      `${JSON.stringify(
        {
          version: ELEVATION_VERSION,
          source: "Open-Meteo Elevation API",
          generatedAt: new Date().toISOString(),
          circuitId: circuit.id,
          elevations,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`wrote ${circuit.id} (${elevations.length} points)`);

    // Keep the public API calm when generating all circuits at once.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
