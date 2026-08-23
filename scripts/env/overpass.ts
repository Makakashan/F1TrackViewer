/**
 * OSM ways that say what the ground does to a road: tunnel, bridge, layer.
 *
 * docs/city-generation.md §1.4. The old generator drops these tags, so nothing
 * downstream can know that the run from the Fairmont hairpin to Portier passes
 * *under* the hill rather than through it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RasterBBox } from "./raster";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];
const USER_AGENT = "F1TrackViewer/0.1 (https://github.com/Makakashan/F1TrackViewer)";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CACHE_DIR = join(REPO_ROOT, "data", "cache", "overpass-structures");

export interface ShoreWay {
  id: string;
  points: [number, number][];
  kind: "coastline" | "quay" | "pier" | "breakwater" | "groyne" | "water";
  name?: string;
}

export interface BuildingWay {
  id: string;
  footprint: [number, number][];
  /** Only what the roof and the height need; the rest of OSM is noise here. */
  tags: {
    building?: string;
    height?: string;
    "building:levels"?: string;
    "roof:shape"?: string;
    "roof:height"?: string;
    "roof:levels"?: string;
    name?: string;
  };
}

/**
 * Somewhere green, or something growing.
 *
 * Three shapes arrive under one query because they answer the same question in
 * three resolutions: a surveyed tree is a position, a tree row is a line to
 * step along, and a park is an area to scatter over.
 */
export interface GreenWay {
  id: string;
  kind: "tree" | "tree_row" | "wood" | "scrub" | "park" | "grass";
  /** One point for a tree, a polyline for a row, a closed ring for an area. */
  points: [number, number][];
}

export interface StructureWay {
  id: string;
  points: [number, number][];
  highway: string;
  /** `yes`, `building_passage`, `culvert`… anything but absent means covered. */
  tunnel?: string;
  bridge?: string;
  /** Negative below ground, positive above. */
  layer: number;
  name?: string;
}

interface OverpassResponse {
  elements: OverpassWay[];
  /** Overpass reports a refusal in the body, under HTTP 200. */
  remark?: string;
}

interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  /** Nodes carry their position directly rather than a geometry array. */
  lat?: number;
  lon?: number;
}

function query(bbox: RasterBBox): string {
  const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  // Only the ways that change what the ground does. The full road network is a
  // separate concern and is not baked yet.
  return `[out:json][timeout:90];
(
  way["highway"]["tunnel"](${box});
  way["highway"]["bridge"](${box});
  way["highway"]["covered"="yes"](${box});
);
out geom tags;`;
}

/**
 * One pass over the endpoints is not a retry policy.
 *
 * Overpass hands out query slots per address and refuses everything while they
 * are taken, so a bake that asks for thirty-one circuits in a row spends part of
 * its time locked out — and one pass over three endpoints, five seconds apart,
 * gives up fifteen seconds into a wait that is measured in minutes. The passes
 * back off, and the last one waits a minute between endpoints.
 */
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000];

async function run(body: string): Promise<OverpassResponse | null> {
  for (const wait of RETRY_BACKOFF_MS) {
    const answer = await runOnce(body, wait);
    if (answer) return answer;
  }
  return null;
}

async function runOnce(body: string, waitMs: number): Promise<OverpassResponse | null> {
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
        body,
      });
      if (!res.ok) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      const json = (await res.json()) as OverpassResponse;
      // A rate-limited or timed-out query comes back as HTTP 200 with an empty
      // result and a remark. Taking that as an answer caches an empty city.
      //
      // And sometimes without a remark, which is worse, because it looks like an
      // answer: measured, two circuits came out of P4.4's sweep with zero green
      // ways cached — the Red Bull Ring, which stands in a forest, and Albert
      // Park, which is a park. An empty result is therefore worth another
      // endpoint before it is believed.
      if (!json.elements?.length) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      return json;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return null;
}

function buildingQuery(bbox: RasterBBox): string {
  const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  // Ways only. A multipolygon building is a courtyard block whose outer ring is
  // what the city silhouette needs, and Overpass returns those rings as ways.
  return `[out:json][timeout:180];
way["building"](${box});
out geom tags;`;
}

/** Building footprints with the tags a roof and a height are decided from. */
export async function fetchBuildingWays(
  circuitId: string,
  bbox: RasterBBox,
  refresh = false,
): Promise<BuildingWay[]> {
  const cachePath = join(CACHE_DIR, `${circuitId}-buildings.json`);
  if (!refresh) {
    try {
      return JSON.parse(await readFile(cachePath, "utf8")) as BuildingWay[];
    } catch {
      // not cached yet
    }
  }

  const response = await run(buildingQuery(bbox));
  if (!response) throw new Error(`overpass: no endpoint answered for ${circuitId} buildings`);

  const ways: BuildingWay[] = [];
  for (const element of response.elements) {
    if (element.type !== "way" || !element.geometry || element.geometry.length < 4) continue;
    const tags = (element.tags ?? {}) as BuildingWay["tags"];
    ways.push({
      id: `way/${element.id}`,
      footprint: element.geometry.map((p) => [p.lon, p.lat] as [number, number]),
      tags,
    });
  }

  // Nothing is never written down: an empty answer is a failed query wearing a
  // successful one's clothes, and caching it makes an empty city that no later
  // run will ever correct.
  if (ways.length) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(ways));
  }
  return ways;
}

function shoreQuery(bbox: RasterBBox): string {
  const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  return `[out:json][timeout:90];
(
  way["natural"="coastline"](${box});
  way["man_made"~"^(quay|pier|breakwater|groyne)$"](${box});
  way["natural"="water"](${box});
  way["waterway"="dock"](${box});
);
out geom tags;`;
}

/** Where the built edge of the water is: coastline, quays, piers, breakwaters. */
export async function fetchShoreWays(
  circuitId: string,
  bbox: RasterBBox,
  refresh = false,
): Promise<ShoreWay[]> {
  const cachePath = join(CACHE_DIR, `${circuitId}-shore.json`);
  if (!refresh) {
    try {
      return JSON.parse(await readFile(cachePath, "utf8")) as ShoreWay[];
    } catch {
      // not cached yet
    }
  }

  const response = await run(shoreQuery(bbox));
  if (!response) throw new Error(`overpass: no endpoint answered for ${circuitId} shore`);

  const ways: ShoreWay[] = [];
  for (const element of response.elements) {
    if (element.type !== "way" || !element.geometry?.length) continue;
    const tags = element.tags ?? {};
    // A basin drawn as an area, not as a line: a beach or a dock where OSM
    // carries no coastline. Its ring is the water's edge all the same.
    const kind: ShoreWay["kind"] | undefined =
      tags.natural === "coastline"
        ? "coastline"
        : tags.natural === "water" || tags.waterway === "dock"
          ? "water"
          : (tags.man_made as ShoreWay["kind"] | undefined);
    if (!kind) continue;
    ways.push({
      id: `way/${element.id}`,
      points: element.geometry.map((p) => [p.lon, p.lat] as [number, number]),
      kind,
      name: tags.name,
    });
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, JSON.stringify(ways));
  return ways;
}

/** Ways in the bbox that are tunnelled, bridged or covered, with their tags. */
/**
 * Two queries, not one.
 *
 * Asked together — surveyed trees, tree rows, woods, landuse and parks — the
 * public endpoints answer **504**, while either half on its own comes back in
 * seconds. Splitting them is not a nicety; the combined form was returning an
 * empty city and caching it.
 *
 * The areas are asked for one tag at a time for the same reason. A regex over
 * `landuse` timed out where nine plain equality clauses come back at once.
 */
function greenQueries(bbox: RasterBBox): string[] {
  const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  return [
    `[out:json][timeout:180];
(
  node["natural"="tree"](${box});
  way["natural"="tree_row"](${box});
);
out geom tags;`,
    `[out:json][timeout:180];
(
  way["natural"="wood"](${box});
  way["natural"="scrub"](${box});
  way["landuse"="forest"](${box});
  way["landuse"="grass"](${box});
  way["landuse"="meadow"](${box});
  way["landuse"="village_green"](${box});
  way["landuse"="cemetery"](${box});
  way["leisure"="park"](${box});
  way["leisure"="garden"](${box});
);
out geom tags;`,
  ];
}

function greenKind(tags: Record<string, string>): GreenWay["kind"] | null {
  if (tags.natural === "tree") return "tree";
  if (tags.natural === "tree_row") return "tree_row";
  if (tags.natural === "wood" || tags.landuse === "forest") return "wood";
  if (tags.natural === "scrub") return "scrub";
  if (tags.leisure === "park" || tags.leisure === "garden") return "park";
  if (tags.landuse) return "grass";
  return null;
}

/** Trees, tree rows and the green areas to scatter more of them over. */
export async function fetchGreenWays(
  circuitId: string,
  bbox: RasterBBox,
  refresh = false,
): Promise<GreenWay[]> {
  const cachePath = join(CACHE_DIR, `${circuitId}-green.json`);
  if (!refresh) {
    try {
      return JSON.parse(await readFile(cachePath, "utf8")) as GreenWay[];
    } catch {
      // not cached yet
    }
  }

  // Greenery is the one layer a circuit can be baked without. Terrain and
  // buildings are the scene; trees are dressing, and refusing to bake Austria
  // because Overpass was busy would be the wrong way round. An unanswered query
  // is warned about and left uncached, so the next run asks again.
  const elements: OverpassWay[] = [];
  let unanswered = 0;
  for (const query of greenQueries(bbox)) {
    const response = await run(query);
    if (!response) {
      unanswered++;
      continue;
    }
    elements.push(...response.elements);
  }
  if (unanswered) {
    console.warn(`  overpass: ${unanswered} greenery quer(y|ies) unanswered for ${circuitId}`);
  }

  const ways: GreenWay[] = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const kind = greenKind(tags);
    if (!kind) continue;
    if (element.type === "node") {
      if (element.lon === undefined || element.lat === undefined) continue;
      ways.push({ id: `node/${element.id}`, kind, points: [[element.lon, element.lat]] });
      continue;
    }
    if (element.type !== "way" || !element.geometry?.length) continue;
    ways.push({
      id: `way/${element.id}`,
      kind,
      points: element.geometry.map((p) => [p.lon, p.lat] as [number, number]),
    });
  }

  // Nothing is never written down, and neither is a partial answer. Somewhere
  // with no park, no verge and no street tree does not exist, so an empty
  // result is a failed query wearing a successful one's clothes — cache it and
  // no later run ever corrects the treeless circuit it makes.
  if (ways.length && !unanswered) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(ways));
  }
  return ways;
}

export async function fetchStructureWays(
  circuitId: string,
  bbox: RasterBBox,
  refresh = false,
): Promise<StructureWay[]> {
  const cachePath = join(CACHE_DIR, `${circuitId}.json`);
  if (!refresh) {
    try {
      return JSON.parse(await readFile(cachePath, "utf8")) as StructureWay[];
    } catch {
      // not cached yet
    }
  }

  const response = await run(query(bbox));
  if (!response) throw new Error(`overpass: no endpoint answered for ${circuitId}`);

  const ways: StructureWay[] = [];
  for (const element of response.elements) {
    if (element.type !== "way" || !element.geometry?.length) continue;
    const tags = element.tags ?? {};
    ways.push({
      id: `way/${element.id}`,
      points: element.geometry.map((p) => [p.lon, p.lat] as [number, number]),
      highway: tags.highway ?? "",
      tunnel: tags.tunnel ?? (tags.covered === "yes" ? "covered" : undefined),
      bridge: tags.bridge,
      layer: Number.parseInt(tags.layer ?? "0", 10) || 0,
      name: tags.name,
    });
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, JSON.stringify(ways));
  return ways;
}
