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
  // Last, and only useful for a Swiss circuit: this one serves a Switzerland
  // extract, not the planet. Asked for Monaco it answers 200 with nothing —
  // measured, zero buildings in the Casino block where the global mirrors
  // report 33 ways and 8 relations. `run` treats an empty answer as a failed
  // one and moves on, and no fetch caches an empty result, so it costs a retry
  // rather than an empty city; it is here for the day the other two are down
  // and the circuit happens to be in Switzerland.
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
  kind: "tree" | "tree_row" | "wood" | "scrub" | "park" | "grass" | "pool" | "pitch";
  /** One point for a tree, a polyline for a row, a closed ring for an area. */
  points: [number, number][];
}

/**
 * A surveyed line the ground is allowed to break along.
 *
 * The height field is a raster and it smears a wall over two or three cells,
 * so a filter that averages across one turns a 6 m quay into a ramp. These are
 * the lines it may not average across. Quays, breakwaters and the coastline
 * arrive as `ShoreWay` already and are folded in by the caller.
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

/**
 * Set once a query has spent every pass without an answer.
 *
 * The backoff is sized for one busy endpoint, not for three down at once: a
 * layer asked as eleven separate queries pays four minutes of waiting each,
 * and a bake that would have taken five minutes takes fifty to arrive at the
 * same nothing. The first exhausted query is enough evidence that Overpass is
 * not answering right now, so the rest of the run asks once and moves on.
 */
let overpassRefusing = false;

/**
 * `OVERPASS_OFFLINE=1` skips the API entirely and bakes from the cache alone.
 *
 * When all three endpoints are down, every uncached layer still costs its full
 * retry schedule before arriving at nothing — minutes per bake, repeated on
 * every iteration. This says so once, explicitly, rather than pretending the
 * cache is complete: cached layers load as normal and uncached ones come back
 * empty, which is exactly what the empty-answer path already handles. It is a
 * switch a person throws, so nothing is ever recorded as absent by accident.
 */
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
  // Every pass came back with nothing. That is usually a refusal wearing a 200 —
  // one of the three endpoints answers busy queries with an empty body — but it
  // is also what a genuinely empty layer looks like, and an inland circuit with
  // no quay, pier or coastline has one. Returning the empty answer lets that
  // circuit bake; not caching it (every caller's job) means a refusal is asked
  // again next time. The two cannot be told apart at this level, so neither is
  // allowed to be fatal and neither is allowed to be permanent.
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
  // Ways and relations. A multipolygon building carries `building` on the
  // relation and usually not on its rings, so a ways-only query loses it
  // entirely — 34 of them over Monaco, and eight of those are the Casino block,
  // which is the part of the model somebody notices missing first.
  // `out geom`, not `out geom tags`: with the `tags` modifier Overpass returns
  // a relation as an id, a bounding box and its tags, and drops the members —
  // measured, eight relations came back with zero members each. Ways survive it
  // either way, which is why it went unnoticed until relations were asked for.
  return `[out:json][timeout:180];
(
  way["building"](${box});
  relation["building"](${box});
);
out geom;`;
}

/**
 * The outer ring of a multipolygon, stitched from its outer members.
 *
 * Overpass hands back each member's geometry separately and in no particular
 * order or direction, so the ring is walked: start with one part, then keep
 * taking whichever unused part begins or ends where the ring currently does.
 * Only the outer ring is kept — a courtyard is a hole, and the silhouette is
 * what the bake extrudes.
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
 * One query per tag, not one query for everything.
 *
 * This started as a single query and the public endpoints answered **504**.
 * Split in two it worked for Monaco and Silverstone and then failed again for
 * every larger bbox in P4.4's sweep — Baku, Melbourne, the Red Bull Ring — and
 * the cost was not the refusal but the backoff behind it: **170 seconds of
 * waiting per circuit** to arrive at no trees.
 *
 * It is the weight of the query, not the rate limit. `node["natural"="tree"]`
 * over a circuit's whole bbox is a large scan and a regex over `landuse` is a
 * larger one; asked one plain equality at a time they each come back in
 * seconds. Eleven cheap requests beat one that times out.
 */
function greenQueries(bbox: RasterBBox): string[] {
  const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  const clauses = [
    `node["natural"="tree"](${box});`,
    `way["natural"="tree_row"](${box});`,
    `way["natural"="wood"](${box});`,
    `way["natural"="scrub"](${box});`,
    `way["landuse"="forest"](${box});`,
    `way["landuse"="grass"](${box});`,
    `way["landuse"="meadow"](${box});`,
    `way["landuse"="village_green"](${box});`,
    `way["landuse"="cemetery"](${box});`,
    `way["leisure"="park"](${box});`,
    `way["leisure"="garden"](${box});`,
    // Not greenery, but the same shape of answer: a surveyed area that is not a
    // building and is not bare ground. Monaco's pool quay reads as empty
    // concrete without them — the halls beside it are the Grand Prix's own and
    // nobody maps those, but the Stade Nautique is permanent and is drawn.
    `way["leisure"="swimming_pool"](${box});`,
    `way["leisure"="pitch"](${box});`,
  ];
  return clauses.map((clause) => `[out:json][timeout:120];\n${clause}\nout geom tags;`);
}

function greenKind(tags: Record<string, string>): GreenWay["kind"] | null {
  if (tags.leisure === "swimming_pool") return "pool";
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
  const queries = greenQueries(bbox);
  let unanswered = 0;
  for (const [index, query] of queries.entries()) {
    const response = await run(query);
    if (!response) {
      // The rest are not asked. Every query goes to the same three endpoints,
      // so if one has exhausted its retries the others will too — and eleven
      // queries times three backoff passes is half an hour of a bake spent
      // waiting to be told the same thing.
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

  // Nothing is never written down, and neither is a partial answer. Somewhere
  // with no park, no verge and no street tree does not exist, so an empty
  // result is a failed query wearing a successful one's clothes — cache it and
  // no later run ever corrects the treeless circuit it makes.
  if (!ways.length) {
    console.warn(`  overpass: no greenery came back for ${circuitId} — not cached`);
  }
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

  // An empty answer is not written down: it is a refusal more often than it
  // is the truth, and cached it would never be asked again.
  if (ways.length) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(ways));
  }
  return ways;
}
