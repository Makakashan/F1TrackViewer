/** Copies the circuit GeoJSON into `public/` so a page view never hits GitHub's rate limit. */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CACHE_DIR = join(REPO_ROOT, ".cache", "circuit-geojson");
const OUT_DIR = join(REPO_ROOT, "public", "circuits");
const RAW_BASE = "https://raw.githubusercontent.com/bacinger/f1-circuits/master";

interface CircuitProperties {
  id: string;
  Location: string;
  Name: string;
}

interface CircuitGeoJSON {
  bbox: [number, number, number, number];
  features: { properties: CircuitProperties }[];
}

async function cachedIds(): Promise<string[]> {
  try {
    const files = await readdir(CACHE_DIR);
    return files.filter((f) => f.endsWith(".geojson")).map((f) => f.slice(0, -".geojson".length));
  } catch {
    return [];
  }
}

/** Ids the app is expected to offer, from the index the globe already ships. */
async function indexIds(): Promise<string[]> {
  const raw = await readFile(join(REPO_ROOT, "public", "circuits-index.json"), "utf8");
  const index = JSON.parse(raw) as { circuits: { id: string }[] };
  return index.circuits.map((circuit) => circuit.id);
}

async function loadCircuit(id: string): Promise<CircuitGeoJSON> {
  const cached = join(CACHE_DIR, `${id}.geojson`);
  try {
    return JSON.parse(await readFile(cached, "utf8")) as CircuitGeoJSON;
  } catch {
    const response = await fetch(`${RAW_BASE}/circuits/${id}.geojson`);
    if (!response.ok) throw new Error(`${id}: ${response.status} from GitHub`);
    const text = await response.text();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cached, text);
    return JSON.parse(text) as CircuitGeoJSON;
  }
}

async function main(): Promise<void> {
  const ids = [...new Set([...(await indexIds()), ...(await cachedIds())])].sort();
  await mkdir(OUT_DIR, { recursive: true });

  const locations: { id: string; name: string; location: string; lat: number; lon: number }[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    let geojson: CircuitGeoJSON;
    try {
      geojson = await loadCircuit(id);
    } catch (error) {
      missing.push(`${id} (${String(error)})`);
      continue;
    }
    await writeFile(join(OUT_DIR, `${id}.geojson`), JSON.stringify(geojson));

    const properties = geojson.features[0]?.properties;
    const [minLon, minLat, maxLon, maxLat] = geojson.bbox;
    locations.push({
      id,
      name: properties?.Name ?? id,
      location: properties?.Location ?? "",
      // The dataset's own centre, so the list and the scene agree on where a
      // circuit is without a second source to keep in step.
      lat: (minLat + maxLat) / 2,
      lon: (minLon + maxLon) / 2,
    });
  }

  locations.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(join(OUT_DIR, "index.json"), `${JSON.stringify(locations, null, 2)}\n`);

  console.log(`circuits: ${locations.length} written to public/circuits/`);
  if (missing.length) console.log(`missing: ${missing.join(", ")}`);
}

await main();
