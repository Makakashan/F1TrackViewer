/**
 * OSM ways that say what the ground does to a road: tunnel, bridge, layer. Without
 * them nothing downstream knows the tunnel run goes under the hill.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RasterBBox } from "./raster";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  // Last, and Swiss only: this mirror serves a Switzerland extract and answers empty
  // for anywhere else. An empty answer counts as a failure and moves on.
  "https://overpass.osm.ch/api/interpreter",
];
const USER_AGENT = "F1TrackViewer/0.1 (https://github.com/Makakashan/F1TrackViewer)";
/** How long one endpoint may hold a query; a silent mirror once held a bake forever. */
const REQUEST_TIMEOUT_MS = 210_000;

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

/** Somewhere green: a tree is a point, a tree row a line, a park an area. */
export interface GreenWay {
  id: string;
  kind: "tree" | "tree_row" | "wood" | "scrub" | "park" | "grass" | "pool" | "pitch" | "fountain";
  /** One point for a tree, a polyline for a row, a closed ring for an area. */
  points: [number, number][];
}

/**
 * A surveyed line the ground may break along. The raster smears walls, so the filter
 * must not average across these.
 */
export interface BreaklineWay {
  id: string;
  kind: "cliff" | "retaining_wall";
  points: [number, number][];
  /** OSM draws a cliff with the drop on the right of the way's direction. */
  name?: string;
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

/** A road, path or square. The DTM reads streets right, so they anchor the town's ground level. */
export interface StreetWay {
  id: string;
  points: [number, number][];
  highway: string;
  /** A carriageway's width in metres where OSM says, else its class's default. */
  lanes: number;
  /** A way in a tunnel or on a bridge is not the ground under it. */
  offGround: boolean;
  /** True for a square or a pedestrian area: a patch, not a line. */
  area: boolean;
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
  /** A relation's parts, each with its own geometry under `out geom`. */
  members?: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
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

/** Every street, path and square, which is the ground the town is built to. */
function streetQuery(bbox: RasterBBox): string {
  const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  return `[out:json][timeout:180];
(
  way["highway"](${box});
  way["area:highway"](${box});
);
out geom tags;`;
}

/** Ways that carry traffic or feet; the rest of `highway` is furniture. */
const STREET_KINDS = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
  "residential", "living_street", "service", "pedestrian", "footway", "path",
  "track", "steps", "cycleway",
]);

/** Metres across, by class, where OSM does not say. */
const STREET_WIDTH_M: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 12, secondary: 10, tertiary: 9,
  unclassified: 7, residential: 7, living_street: 6, service: 5,
  pedestrian: 6, footway: 3, path: 2, track: 3, steps: 2, cycleway: 2.5,
};

export async function fetchStreetWays(
  circuitId: string,
  bbox: RasterBBox,
  refresh = false,
): Promise<StreetWay[]> {
  const cachePath = join(CACHE_DIR, `${circuitId}-streets.json`);
  if (!refresh) {
    try {
      return JSON.parse(await readFile(cachePath, "utf8")) as StreetWay[];
    } catch {
      // not cached yet
    }
  }

  const response = await run(streetQuery(bbox));
  if (!response) throw new Error(`overpass: no endpoint answered for ${circuitId} streets`);

  const ways: StreetWay[] = [];
  for (const element of response.elements) {
    if (element.type !== "way" || !element.geometry?.length) continue;
    const tags = element.tags ?? {};
    const highway = tags.highway ?? tags["area:highway"] ?? "";
    const base = highway.replace(/_link$/, "");
    if (!STREET_KINDS.has(highway) && !STREET_KINDS.has(base)) continue;
    const width = Number.parseFloat(tags.width ?? "");
    const lanes = Number.parseFloat(tags.lanes ?? "");
    ways.push({
      id: `way/${element.id}`,
      points: element.geometry.map((p) => [p.lon, p.lat] as [number, number]),
      highway,
      lanes: Number.isFinite(width) && width > 0
        ? width
        : Number.isFinite(lanes) && lanes > 0
          ? lanes * 3.2
          : (STREET_WIDTH_M[base] ?? STREET_WIDTH_M[highway] ?? 6),
      offGround:
        tags.tunnel !== undefined
        || tags.bridge !== undefined
        || tags.covered === "yes"
        || (Number.parseInt(tags.layer ?? "0", 10) || 0) !== 0,
      area: tags.area === "yes" || tags["area:highway"] !== undefined,
    });
  }

  if (ways.length) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(ways));
  }
  return ways;
}

/**
 * Overpass refuses while its per-address slots are taken, so the passes back off,
 * the last one by a minute.
 */
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000];

/**
 * Set once a query exhausts every pass. After that the run asks each layer once,
 * instead of waiting minutes per layer for nothing.
 */
let overpassRefusing = false;

/** `OVERPASS_OFFLINE=1` bakes from cache only; uncached layers come back empty. */
const OFFLINE = process.env.OVERPASS_OFFLINE === "1";

async function run(body: string): Promise<OverpassResponse | null> {
  if (OFFLINE) return { elements: [] };
  let empty: OverpassResponse | null = null;
  const passes = overpassRefusing ? [0] : RETRY_BACKOFF_MS;
  for (const wait of passes) {
    const answer = await runOnce(body, wait);
    if (answer) return answer;
    empty ??= lastEmpty;
  }
  // Every pass came back empty: a refusal or a genuinely empty layer. Return it so
  // inland circuits bake, but never cache it.
  overpassRefusing = true;
  return empty;
}

/** The last well-formed HTTP 200 that carried no elements, for `run` to fall
 *  back on once its retries are spent. */
let lastEmpty: OverpassResponse | null = null;

async function runOnce(body: string, waitMs: number): Promise<OverpassResponse | null> {
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      const json = (await res.json()) as OverpassResponse;
      // Rate limits come back as HTTP 200 with an empty result, sometimes without a remark,
      // so an empty answer is worth another endpoint before it is believed.
      if (!json.elements?.length) {
        lastEmpty = json;
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
  // Ways and relations: multipolygon buildings (the Casino block) carry the tag on the
  // relation. `out geom`, since the `tags` modifier drops relation members.
  return `[out:json][timeout:180];
(
  way["building"](${box});
  relation["building"](${box});
);
out geom;`;
}

/**
 * The outer ring of a multipolygon, stitched end to end from members in any order.
 * Courtyards are dropped; the bake extrudes the silhouette.
 */
function outerRing(element: OverpassWay): [number, number][] | null {
  const parts = (element.members ?? [])
    .filter((member) => member.type === "way" && member.role !== "inner" && member.geometry?.length)
    .map((member) => member.geometry!.map((p) => [p.lon, p.lat] as [number, number]));
  if (!parts.length) return null;

  const close = (a: [number, number], b: [number, number]) =>
    Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const ring = parts.shift()!.slice();
  let joined = true;
  while (parts.length && joined) {
    joined = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const head = ring[0];
      const tail = ring[ring.length - 1];
      if (close(tail, part[0])) ring.push(...part.slice(1));
      else if (close(tail, part[part.length - 1])) ring.push(...part.slice(0, -1).reverse());
      else if (close(head, part[part.length - 1])) ring.unshift(...part.slice(0, -1));
      else if (close(head, part[0])) ring.unshift(...part.slice(1).reverse());
      else continue;
      parts.splice(i, 1);
      joined = true;
      break;
    }
  }
  return ring.length >= 4 ? ring : null;
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
    const tags = (element.tags ?? {}) as BuildingWay["tags"];
    if (element.type === "way" && element.geometry && element.geometry.length >= 4) {
      ways.push({
        id: `way/${element.id}`,
        footprint: element.geometry.map((p) => [p.lon, p.lat] as [number, number]),
        tags,
      });
      continue;
    }
    if (element.type !== "relation") continue;
    const ring = outerRing(element);
    if (!ring) continue;
    ways.push({ id: `relation/${element.id}`, footprint: ring, tags });
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

  // An empty answer is not written down: it is a refusal more often than it
  // is the truth, and cached it would never be asked again.
  if (ways.length) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(ways));
  }
  return ways;
}

function breaklineQueries(bbox: RasterBBox): string[] {
  const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  // One tag per query, for the reason `greenQueries` gives: asked together
  // these two answer 504, asked apart they answer in seconds.
  return [`way["natural"="cliff"](${box});`, `way["barrier"="retaining_wall"](${box});`].map(
    (clause) => `[out:json][timeout:90];\n${clause}\nout geom tags;`,
  );
}

/** Cliffs and retaining walls: the ground's own edges, as OSM surveyed them. */
export async function fetchBreaklineWays(
  circuitId: string,
  bbox: RasterBBox,
  refresh = false,
): Promise<BreaklineWay[]> {
  const cachePath = join(CACHE_DIR, `${circuitId}-breaklines.json`);
  if (!refresh) {
    try {
      return JSON.parse(await readFile(cachePath, "utf8")) as BreaklineWay[];
    } catch {
      // not cached yet
    }
  }

  // Like greenery, a layer a circuit can be baked without: no barrier line
  // means the filter averages as it did before, which is where we came from.
  const elements: OverpassWay[] = [];
  let unanswered = 0;
  const queries = breaklineQueries(bbox);
  for (const [index, query] of queries.entries()) {
    const response = await run(query);
    if (!response) {
      unanswered = queries.length - index;
      break;
    }
    elements.push(...response.elements);
  }
  if (unanswered) {
    console.warn(`  overpass: ${unanswered} breakline quer(y|ies) unanswered for ${circuitId}`);
  }

  const ways: BreaklineWay[] = [];
  for (const element of elements) {
    if (element.type !== "way" || !element.geometry?.length) continue;
    const tags = element.tags ?? {};
    const kind: BreaklineWay["kind"] | null =
      tags.natural === "cliff" ? "cliff" : tags.barrier === "retaining_wall" ? "retaining_wall" : null;
    if (!kind) continue;
    ways.push({
      id: `way/${element.id}`,
      kind,
      points: element.geometry.map((p) => [p.lon, p.lat] as [number, number]),
      ...(tags.name ? { name: tags.name } : {}),
    });
  }

  if (ways.length) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(ways));
  }
  return ways;
}

/** Ways in the bbox that are tunnelled, bridged or covered, with their tags. */
/**
 * One query per tag: the combined query timed out on big circuits, and plain
 * equality queries come back in seconds.
 */
/** What the cached greenery was asked for, so a longer list invalidates it. */
interface GreenCache {
  asked: string;
  ways: GreenWay[];
}

/** The tag clauses greenery is fetched by, as the cache's own fingerprint. */
function greenTags(): string[] {
  return [
    "natural=tree",
    "natural=tree_row",
    "natural=wood",
    "natural=scrub",
    "landuse=forest",
    "landuse=grass",
    "landuse=meadow",
    "landuse=village_green",
    "landuse=cemetery",
    "leisure=park",
    "leisure=garden",
    "leisure=swimming_pool",
    "leisure=pitch",
    "amenity=fountain",
  ];
}

function greenQueries(bbox: RasterBBox): string[] {
  const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  // One tag per query. Pools, pitches and plazas are not green but are the same
  // shape of answer: surveyed area that is neither building nor bare ground.
  return greenTags().map((tag) => {
    const [key, value] = tag.split("=");
    const type = tag === "natural=tree" ? "node" : "way";
    return `[out:json][timeout:120];\n${type}["${key}"="${value}"](${box});\nout geom tags;`;
  });
}

function greenKind(tags: Record<string, string>): GreenWay["kind"] | null {
  if (tags.leisure === "swimming_pool") return "pool";
  if (tags.amenity === "fountain") return "fountain";
  if (tags.leisure === "pitch") return "pitch";
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
  // The cache remembers which tags produced it, so adding a tag invalidates it.
  const asked = greenTags().join(",");
  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as GreenCache;
      if (cached.asked === asked) return cached.ways;
    } catch {
      // not cached yet, or written before the cache carried its question
    }
  }

  // Greenery is optional: an unanswered query warns, stays uncached and is asked again next run.
  const elements: OverpassWay[] = [];
  const queries = greenQueries(bbox);
  let unanswered = 0;
  for (const [index, query] of queries.entries()) {
    const response = await run(query);
    if (!response) {
      // Skip the rest: they hit the same endpoints and would wait out the same failure.
      unanswered = queries.length - index;
      break;
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

  // Never cache an empty or partial answer: nowhere has no greenery at all.
  if (!ways.length) {
    console.warn(`  overpass: no greenery came back for ${circuitId} — not cached`);
  }
  if (ways.length && !unanswered) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify({ asked, ways } satisfies GreenCache));
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

  // An empty answer is not written down: it is a refusal more often than it
  // is the truth, and cached it would never be asked again.
  if (ways.length) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(ways));
  }
  return ways;
}
