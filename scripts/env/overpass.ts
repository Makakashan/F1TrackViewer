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
const RETRY_DELAY_MS = 5_000;

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CACHE_DIR = join(REPO_ROOT, "data", "cache", "overpass-structures");

export interface ShoreWay {
  id: string;
  points: [number, number][];
  kind: "coastline" | "quay" | "pier" | "breakwater" | "groyne";
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

interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
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

async function run(body: string): Promise<{ elements: OverpassWay[] } | null> {
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
        body,
      });
      if (!res.ok) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      return (await res.json()) as { elements: OverpassWay[] };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return null;
}

function shoreQuery(bbox: RasterBBox): string {
  const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
  return `[out:json][timeout:90];
(
  way["natural"="coastline"](${box});
  way["man_made"~"^(quay|pier|breakwater|groyne)$"](${box});
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
    const kind =
      tags.natural === "coastline"
        ? "coastline"
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
