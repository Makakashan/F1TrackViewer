/**
 * Kit buildings: where a modelled building beats an extruded footprint (P4.5).
 *
 * Everything else the bake draws is derived from a measurement, and a footprint
 * extruded to its measured height is an honest answer. It is a dull one: a 9 m
 * box on a 14 m plot is a box, and Monaco is four thousand of them. A model has
 * a roof, eaves, windows and balconies, and where one fits the plot it is worth
 * more than the box it stands in for.
 *
 * The rule is that the model fits the survey rather than replaces it. A
 * footprint qualifies if it is simple and close to rectangular and long enough
 * to be a building, and the model chosen is one whose own proportion matches
 * the height that was measured — a house on a house plot, a tower on a tower's.
 * Where nothing matches, or the road reaches into the plot, or the triangles
 * have run out, the footprint is extruded as before. The survey decides; the
 * kit only supplies a silhouette.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { DIORAMA_COLORS } from "../../src/lib/env/diorama-palette";
import type { Corridor } from "./belts";
import { modelSize, type ModelSize, type PropPlacement, readModel, toLinear } from "./props";
import type { Mesh } from "./mesh";
import type { ScenePlane } from "./plane";
import { triangleCount } from "./mesh";

/**
 * Too short for a building.
 *
 * The only bound left on the plot. There used to be a ceiling too — 400 m² and
 * 12 m — because the library was one suburban pack and a block of flats wearing
 * a bungalow is worse than a box; with the commercial pack loaded the library
 * runs from a two-storey house to a skyscraper, so what decides the fit is the
 * proportion match below rather than a size the kit no longer has trouble with.
 * The floor stays: nothing kept sheds and garages out, and 31 of the 75 plots
 * that took a model were under this — the shortest 3.6 m, which is a house
 * shrunk to the size of a car.
 */
const MIN_FOOTPRINT_LENGTH_M = 8;
/** A kit house has four walls and maybe a wing. More corners is a building. */
const MIN_CORNERS = 4;
const MAX_CORNERS = 6;
/** Footprint area over the area of its own minimum rectangle. */
const MIN_RECTANGULARITY = 0.8;
/** The corridor's own ground, matching the bake's. */
const TRACK_CLEARANCE_M = 8;
/** Above this a model is the detailed tier: eaves, awnings, balconies. */
const LOW_DETAIL_MAX_TRIS = 500;
/**
 * How far a model may be bent to fit the plot it stands on.
 *
 * The measure is anisotropy — the largest of the three fitted scales over the
 * smallest — so growing a model as a whole is free and reshaping it is what is
 * bounded. Placed by its own proportion instead, a model came out 10 % off the
 * surveyed height at the median and covered between half and three times the
 * plot's width; stretched, it is exactly the footprint that was surveyed and
 * exactly the height that was measured, at the price of a window that is not
 * square.
 *
 * Tighter by the track than behind it, because what the price buys is a door
 * you can see: at 1.7 a doorway is half again as wide as it was drawn, and on
 * the front row that is the first thing the eye finds. In the core belt the
 * cap is 1.2, where the distortion is at the edge of noticing; in the city belt
 * 1.5, where a door is a few pixels. Coverage is what pays for it — measured
 * on Monaco at a single cap: 1.7 gives 266 modelled buildings, 1.4 gives 231,
 * 1.3 gives 173, 1.2 gives 131.
 */
const MAX_STRETCH: Record<"core" | "city", number> = { core: 1.2, city: 1.5 };
/** What models may take of the city belt's triangle budget. */
const BUDGET_SHARE = 0.5;

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

/** A pack's folder and which of its files are whole buildings. */
export interface KitSource {
  dir: string;
  prefixes: string[];
}

/**
 * Every modelled building in the packs.
 *
 * The prefixes are per pack because the packs do not agree with each other. In
 * the city kits `building-` is a house or a block and `low-detail-building-`
 * the same idea at a tenth of the triangles — a tower with windows and nothing
 * else, which is what a block two streets back is worth. In Modular Buildings
 * `building-` is a wall, a corner or a door, and only `building-sample-` is a
 * building somebody already assembled.
 */
export async function loadKitHouses(repoRoot: string, sources: KitSource[]): Promise<KitModel[]> {
  const models: KitModel[] = [];
  for (const { dir, prefixes } of sources) {
    let names: string[];
    try {
      names = await readdir(join(repoRoot, dir));
    } catch {
      // The packs are downloaded, not committed: a checkout without them bakes
      // the city the old way rather than failing.
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".glb")) continue;
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const path = `${dir}/${name}`;
      const mesh = await readModel(join(repoRoot, path));
      models.push({ path, size: modelSize(mesh), triangles: triangleCount(mesh) });
    }
  }
  return models;
}

// ─── paint ─────────────────────────────────────────────────────────────────

/**
 * The two ends of the kit's own range, in this diorama's paint: a wall in
 * daylight and the darkest thing on a house.
 */
const KIT_WALL = DIORAMA_COLORS.building;
const KIT_DARK = "#8A9099";
/**
 * The cool tilt the rest of the scene's greys carry, so a repainted house sits
 * in the same light as the block beside it.
 */
const KIT_TINT: [number, number, number] = [0.97, 0.99, 1.04];
/**
 * Where a model's own average lands in the range, and how hard the rest of it
 * leans that way.
 *
 * High, because the occlusion pass multiplies over this: a tower of balconies
 * carries a lot of baked shadow, and at an average halfway up the range it came
 * out a grey block among white ones. Measured against the flat-white control —
 * the same bake with every model vertex on the wall tone — this is where the
 * two stop being told apart at the wide shot.
 */
const KIT_MEAN_AT = 0.65;
const KIT_LIFT = 0.8;

function linearOf(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * toLinear((value >> 16) & 255)
    + 0.7152 * toLinear((value >> 8) & 255)
    + 0.0722 * toLinear(value & 255)
  );
}

/**
 * Brings a kit house into the diorama's palette.
 *
 * Kenney's houses are painted for their own scene — green roofs, brown doors,
 * one of them charcoal all over — and in a city of white extrusions they read
 * as coloured patches rather than as houses. What carries the shape is not the
 * hue but the order of the tones: roof darker than wall, window darker than
 * both. So the hue goes and the order stays: each vertex keeps its own place
 * between the darkest tone on a house and the colour every other building here
 * is painted.
 */
export function repaintKitHouse(mesh: Mesh): void {
  const albedo = mesh.albedo;
  if (!albedo) return;
  const dark = linearOf(KIT_DARK);
  const wall = linearOf(KIT_WALL);

  // Each model against its own average rather than against an absolute scale.
  // The commercial pack has blocks that are dark all over — one is nine parts
  // glazing — and on the absolute scale they came out as black towers in a
  // white city, which is the patch this exists to remove, one tone down.
  const luminance = new Float64Array(albedo.length / 3);
  let mean = 0;
  for (let i = 0; i < luminance.length; i++) {
    const l = 0.2126 * albedo[i * 3] + 0.7152 * albedo[i * 3 + 1] + 0.0722 * albedo[i * 3 + 2];
    luminance[i] = l;
    mean += l / luminance.length;
  }

  for (let i = 0; i < luminance.length; i++) {
    // The model's average lands halfway up the range whatever it was painted,
    // and everything else keeps its distance from it: a window still reads as
    // darker than the wall it is in, and no model is dark as a whole.
    const place = mean > 1e-4 ? Math.min(1, (KIT_MEAN_AT * luminance[i]) / mean) : KIT_MEAN_AT;
    const level = dark + (wall - dark) * place ** KIT_LIFT;
    albedo[i * 3] = level * KIT_TINT[0];
    albedo[i * 3 + 1] = level * KIT_TINT[1];
    albedo[i * 3 + 2] = level * KIT_TINT[2];
  }
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

/**
 * The four corners of a fitted rectangle.
 *
 * The model covers this, not the surveyed ring — the rectangle is the smallest
 * one that holds the ring, so it reaches past it — and what a house stands on
 * has to be at least as wide as the house.
 */
function rectangleRing(rectangle: Rectangle): { x: number; z: number }[] {
  const ux = Math.sin(rectangle.headingRad);
  const uz = Math.cos(rectangle.headingRad);
  const halfL = rectangle.lengthM / 2;
  const halfW = rectangle.widthM / 2;
  return [
    [+1, +1],
    [+1, -1],
    [-1, -1],
    [-1, +1],
  ].map(([alongLength, alongWidth]) => ({
    x: rectangle.centreX + ux * halfL * alongLength - uz * halfW * alongWidth,
    z: rectangle.centreZ + uz * halfL * alongLength + ux * halfW * alongWidth,
  }));
}

/**
 * How much this model has to be reshaped to fill this plot: the largest of the
 * three fitted scales over the smallest.
 */
function stretchOf(model: KitModel, shape: { rectangle: Rectangle; footprint: Footprint }): number {
  const along = shape.rectangle.lengthM / model.size.lengthM;
  const across = shape.rectangle.widthM / model.size.widthM;
  const up = shape.footprint.heightM / model.size.heightM;
  const most = Math.max(along, across, up);
  const least = Math.min(along, across, up);
  return least > 0 ? most / least : Infinity;
}

/** Repeatable: the same plot gets the same house every bake. */
function hashed(x: number, z: number): number {
  const value = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

// ─── selection ─────────────────────────────────────────────────────────────

/** The terrace a modelled house stands on, in scene metres. */
export interface KitPlinth {
  /** The fitted rectangle, which is what the model covers. */
  ring: { x: number; z: number }[];
  /** The floor the model stands on: the middle of the ground under the plot. */
  top: number;
}

export interface KitResult {
  placements: PropPlacement[];
  /** Footprint ids the extrusion must now skip. */
  taken: Set<string>;
  /** One per placement, walled down to the ground by the bake. */
  plinths: KitPlinth[];
  stats: {
    models: number;
    eligible: number;
    noModelFits: number;
    /** Plots the racing surface reaches into, which keep their extrusion. */
    onTheTrack: number;
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
  /**
   * Triangles the models may spend between them.
   *
   * One number, not one per belt: every model ships in the city belt's mesh
   * whichever belt's distance it stands at, so a per-belt allowance was two
   * budgets spending one belt's triangles and the city belt went over.
   */
  budget: number,
): KitResult {
  const result: KitResult = {
    placements: [],
    taken: new Set(),
    plinths: [],
    stats: {
      models: 0,
      eligible: 0,
      noModelFits: 0,
      onTheTrack: 0,
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
      rectangle.lengthM >= MIN_FOOTPRINT_LENGTH_M &&
      rectangle.areaM2 > 0 &&
      area / rectangle.areaM2 >= MIN_RECTANGULARITY;
    return { footprint, rectangle, fits };
  });
  result.stats.eligible = shapes.filter((shape) => shape.fits).length;

  // The district rule is gone with the ceilings that made it necessary. It
  // existed because one toy house in a row of grey blocks reads as a mistake;
  // now the blocks are modelled too, and what a plot gets is decided by the
  // plot rather than by its neighbours.

  // Nearest the circuit first: the budget is a belt's, and what the camera
  // passes gets the model before what sits behind it.
  const ordered = shapes
    .map((shape, index) => ({ shape, index }))
    .filter((entry) => entry.shape.fits)
    .map((entry) => ({
      ...entry,
      distanceM: corridor.distance(entry.shape.footprint.centreX, entry.shape.footprint.centreZ),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);

  let spent = 0;
  for (const { shape, distanceM } of ordered) {
    const { footprint, rectangle } = shape;
    const belt = beltOf(distanceM);
    // The far belt is silhouettes at 600 m; a modelled eave is invisible there
    // and would spend a third of its budget saying so.
    if (!belt) continue;

    // The plot the model has to fill: its own rectangle and its own height.
    // A model is stretched to all three, so what decides whether one can be
    // used is not its proportion but how far from its proportion this is.
    const candidates = models.filter((model) => stretchOf(model, shape) <= MAX_STRETCH[belt]);
    if (!candidates.length) {
      result.stats.noModelFits++;
      continue;
    }

    // The corridor owns its ground. An extrusion is pushed off the road vertex
    // by vertex; a model cannot be, so a plot the road reaches into keeps the
    // extrusion that can bend around it.
    const ring = rectangleRing(rectangle);
    if (ring.some((point) => corridor.distance(point.x, point.z) < TRACK_CLEARANCE_M)) {
      result.stats.onTheTrack++;
      continue;
    }
    // In the city belt the cheap tier goes first where it exists: at a hundred
    // metres and more a modelled cornice is a few pixels, and the same budget
    // buys ten times as many buildings that are modelled at all.
    const cheap = candidates.filter((model) => model.triangles <= LOW_DETAIL_MAX_TRIS);
    const pool = belt === "city" && cheap.length ? cheap : candidates;
    // Least stretched first, so the choice among a dozen that fit is the one
    // that had to be bent least; the hash only breaks the tie, which keeps a
    // street from taking one silhouette twice for the same reason.
    const ranked = [...pool].sort((a, b) => stretchOf(a, shape) - stretchOf(b, shape));
    const roll = hashed(footprint.centreX, footprint.centreZ);
    const shortlist = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 3)));
    const model = shortlist[Math.min(shortlist.length - 1, Math.floor(roll * shortlist.length))];
    if (spent + model.triangles > budget) {
      result.stats.overBudget++;
      continue;
    }
    spent += model.triangles;

    result.placements.push({
      model: model.path,
      lon: plane.lon(rectangle.centreX),
      lat: plane.lat(rectangle.centreZ),
      headingDeg: (rectangle.headingRad * 180) / Math.PI,
      fitLengthM: rectangle.lengthM,
      fitWidthM: rectangle.widthM,
      fitHeightM: footprint.heightM,
      groundY: footprint.groundY,
    });
    result.plinths.push({ ring, top: footprint.groundY });
    result.taken.add(footprint.id);
    result.stats.models++;
    result.stats.triangles += model.triangles;
  }

  return result;
}

export const KIT_BUDGET_SHARE = BUDGET_SHARE;
