/**
 * MVP3 Monaco diorama generator.
 *
 * Pipeline:
 *   1. Read bacinger/f1-circuits GeoJSON for the requested circuit.
 *   2. Compute track bbox, pad by ~1000 m, snap to a clean box.
 *   3. Query Overpass API for buildings / water / roads / landuse.
 *   4. Query Open-Meteo Elevation API for a 64×64 terrain grid.
 *   5. Write cleaned JSON to `public/environments/{circuitId}/`.
 *
 * Raw API responses and a small on-disk cache live under `data/` and are
 * git-ignored — only the polished `public/environments/**` files are
 * committed, so the deployed site never calls Overpass or Open-Meteo.
 *
 * Usage:
 *   bun run environment:generate -- mc-1929
 *   bun run environment:generate -- --refresh mc-1929
 *   bun run environment:generate -- --skip-terrain mc-1929
 */

import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  BuildingFeature,
  BuildingsFile,
  EnvironmentManifest,
  LanduseFile,
  LandusePolygon,
  RoadLine,
  RoadsFile,
  SurfaceFile,
  TerrainFile,
  WaterFile,
  WaterPolygon,
  EnvironmentIndex,
} from "../src/lib/environment-types";
import { ENVIRONMENT_ATTRIBUTION } from "../src/lib/environment-types";
import type { CircuitGeoJSON, CircuitLocation } from "../src/lib/f1-circuits";

const RAW_BASE = "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const OVERPASS_RETRY_DELAY_MS = 5_000;
const OVERPASS_USER_AGENT = "F1TrackViewer/0.1 (https://github.com/Makakashan/F1TrackViewer)";
const OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
const OPEN_TOPO_DATA_URL = "https://api.opentopodata.org/v1/mapzen";
const OPEN_METEO_BATCH_SIZE = 100;
const OPEN_TOPO_DATA_BATCH_SIZE = 100; // OpenTopoData accepts up to 100 locations per request
const OPEN_METEO_INTER_BATCH_MS = 2_500;
const OPEN_METEO_MAX_RETRIES = 8;
const OPEN_METEO_BACKOFF_BASE_MS = 10_000;
const OPEN_TOPO_DATA_INTER_BATCH_MS = 1_000; // OpenTopoData limit: 1000 calls/day, 1 call/sec
const OPEN_TOPO_DATA_MAX_RETRIES = 5;

interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

interface Args {
  circuitIds: string[];
  all: boolean;
  refresh: boolean;
  skipTerrain: boolean;
  skipOverpass: boolean;
  partialTerrain: boolean;
  terrainProvider: "open-meteo" | "opentopodata";
  terrainGridSize: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let all = false;
  let refresh = false;
  let skipTerrain = false;
  let skipOverpass = false;
  let partialTerrain = false;
  let terrainProvider: "open-meteo" | "opentopodata" = "opentopodata";
  let terrainGridSize = 64;
  for (const arg of argv) {
    if (arg === "--all") all = true;
    else if (arg === "--refresh") refresh = true;
    else if (arg === "--skip-terrain") skipTerrain = true;
    else if (arg === "--skip-overpass") skipOverpass = true;
    else if (arg === "--partial-terrain") partialTerrain = true;
    else if (arg.startsWith("--grid-size=")) {
      const v = Number.parseInt(arg.split("=")[1] ?? "", 10);
      if (Number.isFinite(v) && v >= 16 && v <= 256) {
        terrainGridSize = v;
      } else {
        console.warn(`invalid --grid-size value: ${arg}; keeping ${terrainGridSize}`);
      }
    }
    else if (arg.startsWith("--provider=")) {
      const v = arg.split("=")[1];
      if (v === "open-meteo" || v === "opentopodata") {
        terrainProvider = v;
      } else {
        console.warn(`unknown terrain provider: ${v}, defaulting to opentopodata`);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("--")) {
      console.warn(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return {
    circuitIds: positional,
    all,
    refresh,
    skipTerrain,
    skipOverpass,
    partialTerrain,
    terrainProvider,
    terrainGridSize,
  };
}

const USAGE = `Usage:
  bun run environment:generate -- mc-1929
  bun run environment:generate -- --all
  bun run environment:generate -- --all --partial-terrain --grid-size=64
  bun run environment:generate -- --refresh mc-1929
  bun run environment:generate -- --skip-terrain mc-1929
  bun run environment:generate -- --skip-overpass mc-1929
  bun run environment:generate -- --partial-terrain mc-1929
  bun run environment:generate -- --grid-size=128 mc-1929
  bun run environment:generate -- --provider=opentopodata mc-1929
  bun run environment:generate -- --provider=open-meteo mc-1929

Generates static environment JSON in public/environments/{circuitId}/.
  --all                    Generate environments for every circuit in
                           bacinger/f1-circuits f1-locations.json.
  --refresh                Ignore on-disk Overpass / Open-Meteo cache.
  --skip-terrain           Skip terrain grid (writes a flat terrain.json).
  --skip-overpass          Skip Overpass fetches (keep existing files untouched).
  --partial-terrain        If rate-limited, write terrain.json with whatever
                           heights were collected and zero-fill the rest.
  --grid-size=N            Terrain sample grid resolution. Default 64.
                           Use 128 for cleaner coastlines; max 256.
  --provider=opentopodata  Use OpenTopoData (default; slower but reliable).
  --provider=open-meteo    Use Open-Meteo Elevation API (faster but daily quota).`;

// ─── geometry helpers ────────────────────────────────────────────────────

function getTrackBBox(coords: [number, number][]): BBox {
  return coords.reduce<BBox>(
    (acc, [lon, lat]) => ({
      minLon: Math.min(acc.minLon, lon),
      minLat: Math.min(acc.minLat, lat),
      maxLon: Math.max(acc.maxLon, lon),
      maxLat: Math.max(acc.maxLat, lat),
    }),
    {
      minLon: Infinity,
      minLat: Infinity,
      maxLon: -Infinity,
      maxLat: -Infinity,
    },
  );
}

/**
 * Pad a bbox by `meters` in each direction, converting meters → degrees at
 * the bbox center latitude. Same approach as @turf/buffer for small areas.
 */
function padBBox(bbox: BBox, meters: number): BBox {
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const dLat = meters / metersPerDegLat;
  const dLon = meters / metersPerDegLon;
  return {
    minLon: bbox.minLon - dLon,
    minLat: bbox.minLat - dLat,
    maxLon: bbox.maxLon + dLon,
    maxLat: bbox.maxLat + dLat,
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function postForm(url: string, body: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": OVERPASS_USER_AGENT,
    },
    body,
  });
}

// ─── on-disk cache ─────────────────────────────────────────────────────────

async function readCache<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeCache(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Overpass ──────────────────────────────────────────────────────────────

interface OverpassNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

interface OverpassRelationMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
}

interface OverpassRelation {
  type: "relation";
  id: number;
  members: OverpassRelationMember[];
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: (OverpassNode | OverpassWay | OverpassRelation)[];
}

/**
 * Run an Overpass QL query, falling back to the secondary endpoint if the
 * primary rate-limits. Results are cached per-query on disk.
 */
async function runOverpass(
  query: string,
  cachePath: string,
  refresh: boolean,
): Promise<OverpassResponse> {
  if (!refresh) {
    const cached = await readCache<OverpassResponse>(cachePath);
    if (cached) {
      console.log(`  cache hit: ${cachePath}`);
      return cached;
    }
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt];
    try {
      console.log(`  overpass: ${endpoint}`);
      const res = await postForm(endpoint, `data=${encodeURIComponent(query)}`);
      if (!res.ok) {
        console.warn(`    HTTP ${res.status} from ${endpoint}`);
        lastError = new Error(`${endpoint}: HTTP ${res.status}`);
        if (res.status === 429 || res.status === 504) {
          console.warn(`    backing off ${OVERPASS_RETRY_DELAY_MS}ms before next endpoint`);
          await new Promise((r) => setTimeout(r, OVERPASS_RETRY_DELAY_MS));
        }
        continue;
      }
      const text = await res.text();
      try {
        const json = JSON.parse(text) as OverpassResponse;
        await writeCache(cachePath, json);
        return json;
      } catch (err) {
        lastError = err;
        console.warn(`    invalid JSON from ${endpoint}: ${String(err).slice(0, 200)}`);
        continue;
      }
    } catch (err) {
      lastError = err;
      console.warn(`    network error from ${endpoint}: ${String(err).slice(0, 200)}`);
      // try next endpoint
    }
  }
  throw lastError ?? new Error("All Overpass endpoints failed");
}

function bboxFragment(bbox: BBox): string {
  // Overpass bbox order: south, west, north, east  (lat, lon, lat, lon)
  return `(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon})`;
}

// ─── main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.all && !args.circuitIds.length) {
    console.error("No circuit ids supplied. Pass at least one, e.g. mc-1929, or use --all.");
    console.error(USAGE);
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const rawDir = join(projectRoot, "data", "raw");
  const cacheDir = join(projectRoot, "data", "cache");
  const publicEnvironmentsDir = join(projectRoot, "public", "environments");
  const circuitIds = args.all
    ? await fetchAllCircuitIds()
    : args.circuitIds;

  for (const circuitId of circuitIds) {
    console.log(`\n=== ${circuitId} ===`);
    const outDir = join(publicEnvironmentsDir, circuitId);
    await mkdir(outDir, { recursive: true });

    const existingManifest = await readJsonIfExists<EnvironmentManifest>(
      join(outDir, "manifest.json"),
    );
    let padded: BBox;
    if (args.skipOverpass && args.skipTerrain && existingManifest) {
      padded = existingManifest.bbox;
      console.log(`  using existing manifest bbox: ${JSON.stringify(padded)}`);
    } else {
      const geojson = await fetchJson<CircuitGeoJSON>(
        `${RAW_BASE}/circuits/${circuitId}.geojson`,
      );
      const coords = geojson.features[0]?.geometry.coordinates ?? [];
      if (!coords.length) {
        console.warn(`  no coordinates for ${circuitId}, skipping`);
        continue;
      }

      const trackBBox = getTrackBBox(coords);
      padded = padBBox(trackBBox, 1_000);
      console.log(`  track bbox: ${JSON.stringify(trackBBox)}`);
      console.log(`  padded bbox: ${JSON.stringify(padded)}`);
    }

    const manifest: EnvironmentManifest = {
      schemaVersion: 1,
      circuitId,
      style: "low-poly-diorama",
      sources: {
        buildings: "openstreetmap",
        water: "openstreetmap",
        roads: "openstreetmap",
        landuse: "openstreetmap",
        terrain: "open-meteo-elevation",
      },
      attribution: ENVIRONMENT_ATTRIBUTION,
      center: {
        lon: (padded.minLon + padded.maxLon) / 2,
        lat: (padded.minLat + padded.maxLat) / 2,
      },
      bbox: padded,
      paddingMeters: 1_000,
      generatedAt: new Date().toISOString().slice(0, 10),
    };

    await writeJson(join(outDir, "manifest.json"), manifest);
    console.log(`  wrote manifest.json`);

    if (!args.skipOverpass) {
      await generateOverpassLayer(
        "buildings",
        join(outDir, "buildings.json"),
        () => generateBuildings(circuitId, padded, outDir, rawDir, cacheDir, args.refresh),
        () => ({
          schemaVersion: 1,
          circuitId,
          buildings: [],
        } satisfies BuildingsFile),
      );
      await generateOverpassLayer(
        "water",
        join(outDir, "water.json"),
        () => generateWater(circuitId, padded, outDir, rawDir, cacheDir, args.refresh),
        () => ({
          schemaVersion: 1,
          circuitId,
          polygons: [],
        } satisfies WaterFile),
      );
      await generateOverpassLayer(
        "roads",
        join(outDir, "roads.json"),
        () => generateRoads(circuitId, padded, outDir, rawDir, cacheDir, args.refresh),
        () => ({
          schemaVersion: 1,
          circuitId,
          roads: [],
        } satisfies RoadsFile),
      );
      await generateOverpassLayer(
        "landuse",
        join(outDir, "landuse.json"),
        () => generateLanduse(circuitId, padded, outDir, rawDir, cacheDir, args.refresh),
        () => ({
          schemaVersion: 1,
          circuitId,
          polygons: [],
        } satisfies LanduseFile),
      );
    } else {
      console.log("  --skip-overpass: keeping existing buildings/water/roads/landuse");
    }

    if (!args.skipTerrain) {
      await generateTerrain(
        circuitId,
        padded,
        outDir,
        rawDir,
        cacheDir,
        args.refresh,
        args.partialTerrain,
        args.terrainProvider,
        args.terrainGridSize,
      );
    } else {
      const existingTerrain = await readJsonIfExists<TerrainFile>(
        join(outDir, "terrain.json"),
      );
      if (existingTerrain) {
        console.log("  --skip-terrain: keeping existing terrain.json");
      } else {
        console.log("  --skip-terrain: writing flat terrain.json");
        await writeJson<TerrainFile>(join(outDir, "terrain.json"), {
          schemaVersion: 1,
          circuitId,
          gridSize: 0,
          widthMeters: 0,
          heightMeters: 0,
          minElevation: 0,
          maxElevation: 0,
          heights: [],
        });
      }
    }

    await generateSurface(circuitId, padded, outDir);
  }

  await writeEnvironmentIndex(publicEnvironmentsDir);
}

async function fetchAllCircuitIds(): Promise<string[]> {
  const locations = await fetchJson<CircuitLocation[]>(
    `${RAW_BASE}/f1-locations.json`,
  );
  const ids = locations.map((location) => location.id).filter(Boolean);
  ids.sort();
  console.log(`Generating ${ids.length} environment bundles (--all)`);
  return ids;
}

async function generateOverpassLayer<T>(
  label: string,
  outPath: string,
  generate: () => Promise<void>,
  emptyFile: () => T,
): Promise<void> {
  try {
    await generate();
  } catch (error) {
    console.warn(`  WARNING: ${label} generation failed: ${formatError(error)}`);
    if (await fileExists(outPath)) {
      console.warn(`  keeping existing ${label}.json`);
      return;
    }
    await writeJson(outPath, emptyFile());
    console.warn(`  wrote empty ${label}.json fallback`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ─── per-source generators (filled in subsequent commits) ────────────────

async function generateBuildings(
  circuitId: string,
  bbox: BBox,
  outDir: string,
  rawDir: string,
  cacheDir: string,
  refresh: boolean,
): Promise<void> {
  const cachePath = join(cacheDir, "overpass", `${circuitId}-buildings.json`);
  const query = `[out:json][timeout:60];
(
  way["building"]${bboxFragment(bbox)};
  relation["building"]${bboxFragment(bbox)};
);
out body;
>;
out skel qt;`;
  const response = await runOverpass(query, cachePath, refresh);
  await writeCache(join(rawDir, "overpass", `${circuitId}-buildings.raw.json`), response);

  const { nodes, ways, relations } = indexOverpass(response);
  const buildings: BuildingFeature[] = [];

  for (const way of ways) {
    if (!way.tags?.building) continue;
    const footprint = wayToCoords(way, nodes);
    if (footprint.length < 3) continue;
    const height = resolveBuildingHeight(way.tags);
    buildings.push({
      id: `osm-way-${way.id}`,
      kind: classifyBuilding(way.tags),
      height,
      footprint,
    });
  }

  for (const rel of relations) {
    if (!rel.tags?.building) continue;
    const outerMembers = rel.members.filter((m) => m.type === "way" && m.role === "outer");
    if (!outerMembers.length) continue;
    // MVP: use first outer ring only. Multi-ring buildings are rare in Monaco.
    const firstWay = ways.find((w) => w.id === outerMembers[0].ref);
    if (!firstWay) continue;
    const footprint = wayToCoords(firstWay, nodes);
    if (footprint.length < 3) continue;
    buildings.push({
      id: `osm-relation-${rel.id}`,
      kind: classifyBuilding(rel.tags),
      height: resolveBuildingHeight(rel.tags),
      footprint,
    });
  }

  // Keep geometry density sane for Monaco. Buildings are sorted by footprint
  // area (largest first) so the cap keeps the most prominent structures.
  const ranked = buildings
    .map((b) => ({ b, area: polygonArea(b.footprint) }))
    .sort((a, b) => b.area - a.area)
    .slice(0, 800)
    .map((x) => x.b);

  const file: BuildingsFile = {
    schemaVersion: 1,
    circuitId,
    buildings: ranked,
  };
  await writeJson(join(outDir, "buildings.json"), file);
  console.log(`  wrote buildings.json (${ranked.length} features, raw ${buildings.length})`);
}

async function generateWater(
  circuitId: string,
  bbox: BBox,
  outDir: string,
  rawDir: string,
  cacheDir: string,
  refresh: boolean,
): Promise<void> {
  const cachePath = join(cacheDir, "overpass", `${circuitId}-water.json`);
  const query = `[out:json][timeout:60];
(
  way["natural"="water"]${bboxFragment(bbox)};
  relation["natural"="water"]${bboxFragment(bbox)};
  way["water"]${bboxFragment(bbox)};
  relation["water"]${bboxFragment(bbox)};
);
out body;
>;
out skel qt;`;
  const response = await runOverpass(query, cachePath, refresh);
  await writeCache(join(rawDir, "overpass", `${circuitId}-water.raw.json`), response);

  const { nodes, ways, relations } = indexOverpass(response);
  const polygons: WaterPolygon[] = [];

  for (const way of ways) {
    if (!way.tags?.water && way.tags?.natural !== "water") continue;
    const pts = wayToCoords(way, nodes);
    if (pts.length < 3) continue;
    polygons.push({ id: `osm-way-${way.id}`, kind: "water", points: pts });
  }

  for (const rel of relations) {
    if (!rel.tags?.water && rel.tags?.natural !== "water") continue;
    const outer = rel.members.find((m) => m.type === "way" && m.role === "outer");
    if (!outer) continue;
    const way = ways.find((w) => w.id === outer.ref);
    if (!way) continue;
    const pts = wayToCoords(way, nodes);
    if (pts.length < 3) continue;
    polygons.push({ id: `osm-relation-${rel.id}`, kind: "water", points: pts });
  }

  const file: WaterFile = { schemaVersion: 1, circuitId, polygons };
  await writeJson(join(outDir, "water.json"), file);
  console.log(`  wrote water.json (${polygons.length} polygons)`);
}

async function generateRoads(
  circuitId: string,
  bbox: BBox,
  outDir: string,
  rawDir: string,
  cacheDir: string,
  refresh: boolean,
): Promise<void> {
  const cachePath = join(cacheDir, "overpass", `${circuitId}-roads.json`);
  const query = `[out:json][timeout:60];
(
  way["highway"]${bboxFragment(bbox)};
);
out body;
>;
out skel qt;`;
  const response = await runOverpass(query, cachePath, refresh);
  await writeCache(join(rawDir, "overpass", `${circuitId}-roads.raw.json`), response);

  const { nodes, ways } = indexOverpass(response);
  const roads: RoadLine[] = [];

  for (const way of ways) {
    if (!way.tags?.highway) continue;
    // Skip the race track itself — it's tagged as highway=service or
    // construction in places; we only want the surrounding street grid.
    const pts = wayToCoords(way, nodes);
    if (pts.length < 2) continue;
    roads.push({
      id: `osm-way-${way.id}`,
      kind: "road",
      highway: way.tags.highway,
      points: pts,
    });
  }

  const file: RoadsFile = { schemaVersion: 1, circuitId, roads };
  await writeJson(join(outDir, "roads.json"), file);
  console.log(`  wrote roads.json (${roads.length} lines)`);
}

async function generateLanduse(
  circuitId: string,
  bbox: BBox,
  outDir: string,
  rawDir: string,
  cacheDir: string,
  refresh: boolean,
): Promise<void> {
  const cachePath = join(cacheDir, "overpass", `${circuitId}-landuse.json`);
  const query = `[out:json][timeout:60];
(
  way["landuse"]${bboxFragment(bbox)};
  relation["landuse"]${bboxFragment(bbox)};
  way["leisure"="park"]${bboxFragment(bbox)};
  relation["leisure"="park"]${bboxFragment(bbox)};
  way["natural"="wood"]${bboxFragment(bbox)};
  relation["natural"="wood"]${bboxFragment(bbox)};
);
out body;
>;
out skel qt;`;
  const response = await runOverpass(query, cachePath, refresh);
  await writeCache(join(rawDir, "overpass", `${circuitId}-landuse.raw.json`), response);

  const { nodes, ways, relations } = indexOverpass(response);
  const polygons: LandusePolygon[] = [];

  const classify = (tags: Record<string, string> = {}): LandusePolygon["kind"] => {
    if (tags.leisure === "park") return "park";
    if (tags.natural === "wood") return "wood";
    if (tags.landuse === "grass") return "grass";
    if (tags.landuse === "residential") return "residential";
    if (tags.landuse === "commercial") return "commercial";
    if (tags.landuse === "industrial") return "industrial";
    return "other";
  };

  for (const way of ways) {
    if (!way.tags?.landuse && !way.tags?.leisure && !way.tags?.natural) continue;
    const pts = wayToCoords(way, nodes);
    if (pts.length < 3) continue;
    polygons.push({
      id: `osm-way-${way.id}`,
      kind: classify(way.tags),
      landuse: way.tags.landuse,
      points: pts,
    });
  }

  for (const rel of relations) {
    if (!rel.tags?.landuse && !rel.tags?.leisure && !rel.tags?.natural) continue;
    const outer = rel.members.find((m) => m.type === "way" && m.role === "outer");
    if (!outer) continue;
    const way = ways.find((w) => w.id === outer.ref);
    if (!way) continue;
    const pts = wayToCoords(way, nodes);
    if (pts.length < 3) continue;
    polygons.push({
      id: `osm-relation-${rel.id}`,
      kind: classify(rel.tags),
      landuse: rel.tags.landuse,
      points: pts,
    });
  }

  const file: LanduseFile = { schemaVersion: 1, circuitId, polygons };
  await writeJson(join(outDir, "landuse.json"), file);
  console.log(`  wrote landuse.json (${polygons.length} polygons)`);
}

async function generateTerrain(
  circuitId: string,
  bbox: BBox,
  outDir: string,
  rawDir: string,
  cacheDir: string,
  refresh: boolean,
  partialTerrain: boolean,
  provider: "open-meteo" | "opentopodata",
  gridSize: number,
): Promise<void> {
  const cacheKey = `${circuitId}-terrain-${provider}-${gridSize}`;
  const cachePath = join(cacheDir, "open-meteo", `${cacheKey}.json`);
  const partialPath = join(cacheDir, "open-meteo", `${cacheKey}.partial.json`);
  const rawPath = join(rawDir, "open-meteo", `${cacheKey}.raw.json`);

  let heights: number[] | null = null;
  if (!refresh) {
    heights = await readCache<number[]>(cachePath);
    if (heights) console.log(`  cache hit: ${cachePath}`);
  }

  if (!heights) {
    const points: { lat: number; lon: number }[] = [];
    for (let row = 0; row < gridSize; row++) {
      const lat = bbox.minLat + ((bbox.maxLat - bbox.minLat) * row) / (gridSize - 1);
      for (let col = 0; col < gridSize; col++) {
        const lon = bbox.minLon + ((bbox.maxLon - bbox.minLon) * col) / (gridSize - 1);
        points.push({ lat, lon });
      }
    }

    const batchSize =
      provider === "open-meteo" ? OPEN_METEO_BATCH_SIZE : OPEN_TOPO_DATA_BATCH_SIZE;
    const chunks: { lat: number; lon: number }[][] = [];
    for (let i = 0; i < points.length; i += batchSize) {
      chunks.push(points.slice(i, i + batchSize));
    }
    console.log(`  ${provider}: ${points.length} points in ${chunks.length} batches (batch size ${batchSize})`);

    // Resume from partial cache if present so a 429 doesn't lose progress.
    const partial = await readCache<{ done: number[] }>(partialPath);
    heights = partial?.done ?? [];
    const startBatch = Math.floor(heights.length / batchSize);

    let aborted = false;
    for (let i = startBatch; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = provider === "open-meteo"
        ? await fetchOpenMeteoBatch(chunk, i, chunks.length)
        : await fetchOpenTopoDataBatch(chunk, i, chunks.length);

      if (result.kind === "ok") {
        heights.push(...result.elevations);
        await writeCache(partialPath, { done: heights });
        console.log(`    batch ${i + 1}/${chunks.length} ok (${chunk.length} pts, total ${heights.length})`);
      } else if (partialTerrain) {
        console.warn(
          `    batch ${i + 1}/${chunks.length} failed after retries; --partial-terrain => zero-filling ${chunk.length} pts`,
        );
        for (let k = 0; k < chunk.length; k++) heights.push(0);
        aborted = true;
        await writeCache(partialPath, { done: heights });
      } else {
        throw new Error(`terrain batch ${i + 1} failed: ${result.error}`);
      }
    }

    if (aborted) {
      console.warn(`  WARNING: terrain.json contains zero-filled points (rate-limited).`);
    } else {
      await writeCache(rawPath, { circuitId, gridSize, bbox, heights, provider });
      await writeCache(cachePath, heights);
      try {
        await writeFile(partialPath, "");
      } catch {
        /* ignore */
      }
    }
  }

  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }

  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const widthMeters =
    (bbox.maxLon - bbox.minLon) * 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const heightMeters = (bbox.maxLat - bbox.minLat) * 111_320;

  const file: TerrainFile = {
    schemaVersion: 1,
    circuitId,
    gridSize,
    widthMeters,
    heightMeters,
    minElevation: min,
    maxElevation: max,
    heights,
  };
  await writeJson(join(outDir, "terrain.json"), file);
  console.log(
    `  wrote terrain.json (${gridSize}×${gridSize}, ${heights.length} pts, range ${min.toFixed(1)}–${max.toFixed(1)} m)`,
  );
}

async function generateSurface(
  circuitId: string,
  bbox: BBox,
  outDir: string,
): Promise<void> {
  const terrain = await readJsonIfExists<TerrainFile>(join(outDir, "terrain.json"));
  if (!terrain || terrain.gridSize < 2 || !terrain.heights.length) {
    console.log("  skipped surface.json (no terrain grid)");
    return;
  }

  const water = await readJsonIfExists<WaterFile>(join(outDir, "water.json"));
  const buildings = await readJsonIfExists<BuildingsFile>(join(outDir, "buildings.json"));
  const roads = await readJsonIfExists<RoadsFile>(join(outDir, "roads.json"));
  const waterPolygons = water?.polygons ?? [];
  const buildingPolygons = buildings?.buildings.map((b) => b.footprint) ?? [];
  const roadLines = roads?.roads ?? [];
  const n = terrain.gridSize;
  const seaLevelMeters = 0;
  const floodThresholdMeters = 35;
  const roadBlockRadiusMeters = 28;
  const minInteriorWaterCells = 20;
  const waterMask = new Array<number>(n * n).fill(0);
  const lowMask = new Array<boolean>(n * n).fill(false);
  const landBlockMask = new Array<boolean>(n * n).fill(false);
  const polygonMasks = waterPolygons
    .filter((poly) => poly.points.length >= 3 && polygonArea(poly.points) >= 2_500)
    .map((poly) => poly.points);
  const roadBlockRadiusSq = roadBlockRadiusMeters * roadBlockRadiusMeters;

  function lonLatAt(row: number, col: number): [number, number] {
    const lat = bbox.minLat + ((bbox.maxLat - bbox.minLat) * row) / (n - 1);
    const lon = bbox.minLon + ((bbox.maxLon - bbox.minLon) * col) / (n - 1);
    return [lon, lat];
  }

  function isNearRoad(point: [number, number]): boolean {
    for (const road of roadLines) {
      for (let i = 0; i < road.points.length - 1; i++) {
        if (
          distanceToSegmentMetersSq(point, road.points[i], road.points[i + 1]) <=
          roadBlockRadiusSq
        ) {
          return true;
        }
      }
    }
    return false;
  }

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const idx = row * n + col;
      const h = terrain.heights[idx] ?? 0;
      const point = lonLatAt(row, col);
      const isOsmWater = polygonMasks.some((poly) => pointInLonLatPolygon(point, poly));
      const isBuilding = buildingPolygons.some((poly) => pointInLonLatPolygon(point, poly));
      const isRoad = isNearRoad(point);
      landBlockMask[idx] = !isOsmWater && (isBuilding || isRoad);
      lowMask[idx] = h <= floodThresholdMeters && !landBlockMask[idx];
      if (isOsmWater) {
        waterMask[idx] = 1;
        lowMask[idx] = true;
      }
    }
  }

  const queue: number[] = [];
  function enqueueIfLow(row: number, col: number) {
    if (row < 0 || row >= n || col < 0 || col >= n) return;
    const idx = row * n + col;
    if (landBlockMask[idx]) return;
    if (!lowMask[idx] || waterMask[idx]) return;
    waterMask[idx] = 1;
    queue.push(idx);
  }

  for (let i = 0; i < n; i++) {
    enqueueIfLow(0, i);
    enqueueIfLow(n - 1, i);
    enqueueIfLow(i, 0);
    enqueueIfLow(i, n - 1);
  }

  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const row = Math.floor(idx / n);
    const col = idx % n;
    enqueueIfLow(row - 1, col);
    enqueueIfLow(row + 1, col);
    enqueueIfLow(row, col - 1);
    enqueueIfLow(row, col + 1);
  }

  const visited = new Array<boolean>(n * n).fill(false);
  const component: number[] = [];
  function collectWaterComponent(start: number): { touchesEdge: boolean; cells: number[] } {
    component.length = 0;
    let touchesEdge = false;
    const stack = [start];
    visited[start] = true;
    while (stack.length) {
      const idx = stack.pop()!;
      component.push(idx);
      const row = Math.floor(idx / n);
      const col = idx % n;
      if (row === 0 || row === n - 1 || col === 0 || col === n - 1) {
        touchesEdge = true;
      }
      const neighbors = [
        [row - 1, col],
        [row + 1, col],
        [row, col - 1],
        [row, col + 1],
      ] as const;
      for (const [r, c] of neighbors) {
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const next = r * n + c;
        if (visited[next] || waterMask[next] !== 1) continue;
        visited[next] = true;
        stack.push(next);
      }
    }
    return { touchesEdge, cells: [...component] };
  }

  let removedInteriorWaterCells = 0;
  for (let idx = 0; idx < waterMask.length; idx++) {
    if (waterMask[idx] !== 1 || visited[idx]) continue;
    const part = collectWaterComponent(idx);
    if (!part.touchesEdge && part.cells.length < minInteriorWaterCells) {
      for (const cell of part.cells) waterMask[cell] = 0;
      removedInteriorWaterCells += part.cells.length;
    }
  }

  const file: SurfaceFile = {
    schemaVersion: 1,
    circuitId,
    gridSize: n,
    seaLevelMeters,
    floodThresholdMeters,
    waterMask,
  };
  const waterCount = waterMask.reduce((sum, v) => sum + v, 0);
  await writeJson(join(outDir, "surface.json"), file);
  console.log(
    `  wrote surface.json (${waterCount}/${waterMask.length} water cells, threshold <= ${floodThresholdMeters} m, removed ${removedInteriorWaterCells} tiny interior cells)`,
  );
}

interface TerrainBatchOk {
  kind: "ok";
  elevations: number[];
}
interface TerrainBatchErr {
  kind: "err";
  error: string;
}

async function fetchOpenMeteoBatch(
  chunk: { lat: number; lon: number }[],
  batchIndex: number,
  batchCount: number,
): Promise<TerrainBatchOk | TerrainBatchErr> {
  const latitudes = chunk.map((p) => p.lat.toFixed(6)).join(",");
  const longitudes = chunk.map((p) => p.lon.toFixed(6)).join(",");
  const url = `${OPEN_METEO_ELEVATION_URL}?latitude=${latitudes}&longitude=${longitudes}`;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < OPEN_METEO_MAX_RETRIES; attempt++) {
    try {
      if (batchIndex > 0 || attempt > 0) {
        await new Promise((r) =>
          setTimeout(
            r,
            attempt === 0
              ? OPEN_METEO_INTER_BATCH_MS
              : OPEN_METEO_BACKOFF_BASE_MS * 2 ** (attempt - 1),
          ),
        );
      }
      const res = await fetch(url, {
        headers: { "User-Agent": OVERPASS_USER_AGENT, Accept: "application/json" },
      });
      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`Open-Meteo batch ${batchIndex + 1}: HTTP ${res.status}`);
        console.warn(
          `    batch ${batchIndex + 1}/${batchCount}: HTTP ${res.status}, retry ${attempt + 1}/${OPEN_METEO_MAX_RETRIES}`,
        );
        continue;
      }
      if (!res.ok) {
        throw new Error(`Open-Meteo batch ${batchIndex + 1}: HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        elevation: number[];
        error?: boolean;
        reason?: string;
      };
      if (
        data.error ||
        !Array.isArray(data.elevation) ||
        data.elevation.length !== chunk.length
      ) {
        throw new Error(
          `Open-Meteo batch ${batchIndex + 1}: ${data.reason ?? "invalid response"}`,
        );
      }
      return { kind: "ok", elevations: data.elevation };
    } catch (err) {
      lastErr = err;
      console.warn(
        `    batch ${batchIndex + 1}/${batchCount} error: ${String(err).slice(0, 120)}`,
      );
    }
  }
  return { kind: "err", error: String(lastErr) };
}

async function fetchOpenTopoDataBatch(
  chunk: { lat: number; lon: number }[],
  batchIndex: number,
  batchCount: number,
): Promise<TerrainBatchOk | TerrainBatchErr> {
  const locations = chunk.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join("|");
  const url = `${OPEN_TOPO_DATA_URL}?locations=${encodeURIComponent(locations)}`;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < OPEN_TOPO_DATA_MAX_RETRIES; attempt++) {
    try {
      if (batchIndex > 0 || attempt > 0) {
        await new Promise((r) =>
          setTimeout(
            r,
            attempt === 0 ? OPEN_TOPO_DATA_INTER_BATCH_MS : OPEN_TOPO_DATA_INTER_BATCH_MS * 4 * attempt,
          ),
        );
      }
      const res = await fetch(url, {
        headers: { "User-Agent": OVERPASS_USER_AGENT, Accept: "application/json" },
      });
      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`OpenTopoData batch ${batchIndex + 1}: HTTP ${res.status}`);
        console.warn(
          `    batch ${batchIndex + 1}/${batchCount}: HTTP ${res.status}, retry ${attempt + 1}/${OPEN_TOPO_DATA_MAX_RETRIES}`,
        );
        continue;
      }
      if (!res.ok) {
        throw new Error(`OpenTopoData batch ${batchIndex + 1}: HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        status?: string;
        error?: string;
        results?: Array<{ elevation?: number | null }>;
      };
      if (
        data.status !== "OK" ||
        !Array.isArray(data.results) ||
        data.results.length !== chunk.length
      ) {
        throw new Error(
          `OpenTopoData batch ${batchIndex + 1}: ${data.error ?? data.status ?? "invalid response"}`,
        );
      }
      const elevations: number[] = [];
      for (const r of data.results) {
        if (!r.elevation || !Number.isFinite(r.elevation)) {
          // OpenTopoData returns null for ocean / unknown — treat as 0.
          elevations.push(0);
        } else {
          elevations.push(r.elevation);
        }
      }
      return { kind: "ok", elevations };
    } catch (err) {
      lastErr = err;
      console.warn(
        `    batch ${batchIndex + 1}/${batchCount} error: ${String(err).slice(0, 120)}`,
      );
    }
  }
  return { kind: "err", error: String(lastErr) };
}

// ─── Overpass post-processing helpers ────────────────────────────────────

interface OverpassIndex {
  nodes: Map<number, OverpassNode>;
  ways: OverpassWay[];
  relations: OverpassRelation[];
}

function indexOverpass(response: OverpassResponse): OverpassIndex {
  const nodes = new Map<number, OverpassNode>();
  const ways: OverpassWay[] = [];
  const relations: OverpassRelation[] = [];
  for (const el of response.elements) {
    if (el.type === "node") nodes.set(el.id, el);
    else if (el.type === "way") ways.push(el);
    else if (el.type === "relation") relations.push(el);
  }
  return { nodes, ways, relations };
}

function wayToCoords(
  way: OverpassWay,
  nodes: Map<number, OverpassNode>,
): [number, number][] {
  // Prefer pre-resolved `geometry` if the API returned it (out geom), else
  // resolve via the nodes map (out body + >; out skel qt).
  if (way.geometry && way.geometry.length) {
    return way.geometry.map((g) => [g.lon, g.lat] as [number, number]);
  }
  const out: [number, number][] = [];
  for (const id of way.nodes) {
    const node = nodes.get(id);
    if (!node) continue;
    out.push([node.lon, node.lat]);
  }
  return out;
}

function parseMeters(value?: string): number | null {
  if (!value) return null;
  const cleaned = value.replace(",", ".").replace(/[^\d.]/g, "");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveBuildingHeight(tags: Record<string, string>): number {
  const explicit = parseMeters(tags.height);
  if (explicit) return explicit;
  const levels = Number.parseFloat(tags["building:levels"] ?? "");
  if (Number.isFinite(levels)) return levels * 3;
  if (tags.building === "grandstand") return 10;
  if (tags.building === "garage") return 4;
  if (tags.building === "shed") return 3;
  return 9;
}

function classifyBuilding(tags: Record<string, string>): BuildingFeature["kind"] {
  if (tags.building === "grandstand") return "grandstand";
  if (tags.building === "garage") return "garage";
  if (tags.building === "shed") return "shed";
  return "building";
}

function polygonArea(coords: [number, number][]): number {
  // Spherical shoelace approximation — good enough for ranking by size.
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[(i + 1) % n];
    area += (lon2 - lon1) * (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180));
  }
  return Math.abs((area * 6_378_137 * 6_378_137) / 2);
}

function pointInLonLatPolygon(
  point: [number, number],
  polygon: [number, number][],
): boolean {
  let inside = false;
  const [x, y] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegmentMetersSq(
  point: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const centerLat = ((point[1] + a[1] + b[1]) / 3) * (Math.PI / 180);
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos(centerLat);
  const px = point[0] * metersPerDegLon;
  const py = point[1] * metersPerDegLat;
  const ax = a[0] * metersPerDegLon;
  const ay = a[1] * metersPerDegLat;
  const bx = b[0] * metersPerDegLon;
  const by = b[1] * metersPerDegLat;
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  const x = ax + vx * t;
  const y = ay + vy * t;
  const dx = px - x;
  const dy = py - y;
  return dx * dx + dy * dy;
}

// ─── IO helpers ───────────────────────────────────────────────────────────

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson<T>(path: string, value: T): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeEnvironmentIndex(publicEnvironmentsDir: string): Promise<void> {
  const entries = await readdir(publicEnvironmentsDir, { withFileTypes: true });
  const circuitIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const circuitId = entry.name;
    const hasManifest = await fileExists(
      join(publicEnvironmentsDir, circuitId, "manifest.json"),
    );
    const hasBuildings = await fileExists(
      join(publicEnvironmentsDir, circuitId, "buildings.json"),
    );
    if (hasManifest && hasBuildings) circuitIds.push(circuitId);
  }
  circuitIds.sort();
  const index: EnvironmentIndex = {
    schemaVersion: 1,
    circuitIds,
  };
  await writeJson(join(publicEnvironmentsDir, "index.json"), index);
  console.log(`\nWrote environments/index.json (${circuitIds.length} circuit${circuitIds.length === 1 ? "" : "s"})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
