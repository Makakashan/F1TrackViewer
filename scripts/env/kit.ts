/**
 * Kit houses: where a modelled building beats an extruded footprint (P4.5).
 *
 * Everything else the bake draws is derived from a measurement, and a footprint
 * extruded to its measured height is the honest answer for a city block. It is
 * not the honest answer for a villa: a 9 m box on a 14 m plot is a box, and the
 * hillside above Monaco is four hundred of them. A kit model has a roof, eaves
 * and windows, and at the price of one it is worth more than the box it stands
 * in for.
 *
 * The rule is that the model has to fit the survey rather than replace it. A
 * footprint qualifies only if it is small, simple, close to rectangular and low
 * — that is, if it is the shape a kit house actually is — and the model chosen
 * is the one whose own proportion matches the height that was measured. Where
 * nothing matches, the footprint is extruded as before. The survey decides;
 * the kit only supplies a silhouette.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Corridor } from "./belts";
import { modelSize, type ModelSize, type PropPlacement, readModel } from "./props";
import type { ScenePlane } from "./plane";
import { triangleCount } from "./mesh";

/** Big enough for a villa, too small for a block of flats. */
const MAX_FOOTPRINT_M2 = 400;
/** A kit house has four walls and maybe a wing. More corners is a building. */
const MIN_CORNERS = 4;
const MAX_CORNERS = 6;
/** Footprint area over the area of its own minimum rectangle. */
const MIN_RECTANGULARITY = 0.8;
/** Kenney's suburban kit is two storeys. Above this it would be a stretched toy. */
const MAX_HEIGHT_M = 12;
/** A model is only used where its own proportion is near the measured one. */
const RATIO_TOLERANCE = 0.25;
/** Neighbourhood radius, and the share of it that has to qualify too. */
const NEIGHBOUR_M = 40;
const NEIGHBOUR_SHARE = 0.6;
/** A lone qualifying footprint with nobody around it stays a box. */
const MIN_NEIGHBOURS = 2;
/** What models may take of a belt's triangle budget. */
const BUDGET_SHARE = 0.3;

/** The models available, measured once. */
export interface KitModel {
  /** Path under the repo root, which is what a placement names. */
  path: string;
  size: ModelSize;
  triangles: number;
}

/**
 * The model files of a pack, by name prefix.
 *
 * Returns nothing when the pack is not downloaded, which is the normal state of
 * a fresh checkout: `assets/models/` is fetched, not committed, and a bake
 * without it builds the same city out of extrusions.
 */
export async function loadKitPaths(
  repoRoot: string,
  dir: string,
  prefixes: string[],
): Promise<string[]> {
  try {
    const names = await readdir(join(repoRoot, dir));
    return names
      .filter((name) => name.endsWith(".glb") && prefixes.some((prefix) => name.startsWith(prefix)))
      .sort()
      .map((name) => `${dir}/${name}`);
  } catch {
    return [];
  }
}

export async function loadKitHouses(repoRoot: string, dir: string): Promise<KitModel[]> {
  const models: KitModel[] = [];
  let names: string[];
  try {
    names = await readdir(join(repoRoot, dir));
  } catch {
    // The packs are downloaded, not committed: a checkout without them bakes
    // the city the old way rather than failing.
    return models;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".glb") || !name.startsWith("building-")) continue;
    const path = `${dir}/${name}`;
    const mesh = await readModel(join(repoRoot, path));
    models.push({ path, size: modelSize(mesh), triangles: triangleCount(mesh) });
  }
  return models;
}

// ─── footprint shape ───────────────────────────────────────────────────────

export interface Footprint {
  id: string;
  ring: { x: number; z: number }[];
  /** Scene metres: the floor the walls were going to stand on. */
  groundY: number;
  heightM: number;
  centreX: number;
  centreZ: number;
}

interface Rectangle {
  lengthM: number;
  widthM: number;
  areaM2: number;
  /** Radians, the direction the long side runs in. */
  headingRad: number;
  centreX: number;
  centreZ: number;
}

function ringArea(ring: { x: number; z: number }[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

/**
 * The smallest rectangle that holds the ring, by rotating calipers.
 *
 * One side of the minimum rectangle lies along one of the ring's own edges, so
 * with six corners at most this is six trials rather than a search.
 */
function minimumRectangle(ring: { x: number; z: number }[]): Rectangle {
  let best: Rectangle | null = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const edge = Math.hypot(b.x - a.x, b.z - a.z);
    if (edge < 1e-6) continue;
    const ux = (b.x - a.x) / edge;
    const uz = (b.z - a.z) / edge;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const point of ring) {
      const u = point.x * ux + point.z * uz;
      const v = -point.x * uz + point.z * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const spanU = maxU - minU;
    const spanV = maxV - minV;
    const areaM2 = spanU * spanV;
    if (best && areaM2 >= best.areaM2) continue;
    const midU = (minU + maxU) / 2;
    const midV = (minV + maxV) / 2;
    const alongU = spanU >= spanV;
    best = {
      lengthM: Math.max(spanU, spanV),
      widthM: Math.min(spanU, spanV),
      areaM2,
      // The heading names the long side, whichever of the two it turned out to be.
      headingRad: alongU ? Math.atan2(ux, uz) : Math.atan2(-uz, ux),
      centreX: midU * ux - midV * uz,
      centreZ: midU * uz + midV * ux,
    };
  }
  return (
    best ?? {
      lengthM: 0,
      widthM: 0,
      areaM2: 0,
      headingRad: 0,
      centreX: ring[0]?.x ?? 0,
      centreZ: ring[0]?.z ?? 0,
    }
  );
}

/** Repeatable: the same plot gets the same house every bake. */
function hashed(x: number, z: number): number {
  const value = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

// ─── selection ─────────────────────────────────────────────────────────────

export interface KitResult {
  placements: PropPlacement[];
  /** Footprint ids the extrusion must now skip. */
  taken: Set<string>;
  stats: {
    models: number;
    eligible: number;
    aloneInTheStreet: number;
    noModelFits: number;
    overBudget: number;
    triangles: number;
  };
}

export function chooseKitHouses(
  footprints: Footprint[],
  models: KitModel[],
  corridor: Corridor,
  plane: ScenePlane,
  /** Which belt a distance falls in, or null where models are not drawn. */
  beltOf: (distanceM: number) => "core" | "city" | null,
  /** Triangles each belt will lend to models.  */
  budget: Record<"core" | "city", number>,
): KitResult {
  const result: KitResult = {
    placements: [],
    taken: new Set(),
    stats: {
      models: 0,
      eligible: 0,
      aloneInTheStreet: 0,
      noModelFits: 0,
      overBudget: 0,
      triangles: 0,
    },
  };
  if (!models.length) return result;

  // Shape first, neighbours second: whether a plot is a villa plot is a fact
  // about the plot, and whether it is in a district of them is a fact about the
  // street. One toy house in a row of grey blocks reads as a mistake.
  const shapes = footprints.map((footprint) => {
    const rectangle = minimumRectangle(footprint.ring);
    const area = ringArea(footprint.ring);
    const fits =
      footprint.ring.length >= MIN_CORNERS &&
      footprint.ring.length <= MAX_CORNERS &&
      area <= MAX_FOOTPRINT_M2 &&
      footprint.heightM <= MAX_HEIGHT_M &&
      rectangle.areaM2 > 0 &&
      area / rectangle.areaM2 >= MIN_RECTANGULARITY;
    return { footprint, rectangle, fits };
  });
  result.stats.eligible = shapes.filter((shape) => shape.fits).length;

  const inDistrict = shapes.map((shape, index) => {
    if (!shape.fits) return false;
    let neighbours = 0;
    let qualifying = 0;
    for (let other = 0; other < shapes.length; other++) {
      if (other === index) continue;
      const dx = shapes[other].footprint.centreX - shape.footprint.centreX;
      const dz = shapes[other].footprint.centreZ - shape.footprint.centreZ;
      if (dx * dx + dz * dz > NEIGHBOUR_M * NEIGHBOUR_M) continue;
      neighbours++;
      if (shapes[other].fits) qualifying++;
    }
    if (neighbours < MIN_NEIGHBOURS || qualifying / neighbours < NEIGHBOUR_SHARE) {
      return false;
    }
    return true;
  });
  result.stats.aloneInTheStreet = result.stats.eligible - inDistrict.filter(Boolean).length;

  // Nearest the circuit first: the budget is a belt's, and what the camera
  // passes gets the model before what sits behind it.
  const ordered = shapes
    .map((shape, index) => ({ shape, index }))
    .filter((entry) => inDistrict[entry.index])
    .map((entry) => ({
      ...entry,
      distanceM: corridor.distance(entry.shape.footprint.centreX, entry.shape.footprint.centreZ),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);

  const spent: Record<"core" | "city", number> = { core: 0, city: 0 };
  for (const { shape, distanceM } of ordered) {
    const { footprint, rectangle } = shape;
    // What proportion the measurement asks for, and the models that have it.
    const wanted = footprint.heightM / rectangle.lengthM;
    const candidates = models.filter((model) => {
      const ratio = model.size.heightM / model.size.lengthM;
      return Math.abs(ratio - wanted) <= wanted * RATIO_TOLERANCE;
    });
    if (!candidates.length) {
      result.stats.noModelFits++;
      continue;
    }

    const belt = beltOf(distanceM);
    // The far belt is silhouettes at 600 m; a modelled eave is invisible there
    // and would spend a third of its budget saying so.
    if (!belt) continue;
    const roll = hashed(footprint.centreX, footprint.centreZ);
    const model = candidates[Math.min(candidates.length - 1, Math.floor(roll * candidates.length))];
    if (spent[belt] + model.triangles > budget[belt]) {
      result.stats.overBudget++;
      continue;
    }
    spent[belt] += model.triangles;

    result.placements.push({
      model: model.path,
      lon: plane.lon(rectangle.centreX),
      lat: plane.lat(rectangle.centreZ),
      headingDeg: (rectangle.headingRad * 180) / Math.PI,
      fitLengthM: rectangle.lengthM,
      groundY: footprint.groundY,
    });
    result.taken.add(footprint.id);
    result.stats.models++;
    result.stats.triangles += model.triangles;
  }

  return result;
}

export const KIT_BUDGET_SHARE = BUDGET_SHARE;
