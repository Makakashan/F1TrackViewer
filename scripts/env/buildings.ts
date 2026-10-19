/** Building footprints placed on the drawn ground and extruded. */

import { ShapeUtils, Vector2 } from "three";
import type { BuildingsFile } from "../../src/lib/env/environment-types";
import { beltAtDistance, type Belt, type Corridor } from "./belts";
import { addFlatQuad, addFlatTriangle, createMesh, type Mesh } from "./mesh";
import type { ScenePlane } from "./plane";
import type { BuildingWay } from "./overpass";
import type { Ground } from "./ground";
import type { KitResult } from "./kit";
import type { PierDeck } from "./piers";
import type { PortalHollow } from "./portals";

/** Ground the track corridor owns; a footprint inside it is pushed out. */
export const TRACK_CLEARANCE_M = 8;

/** Buildings below this are noise — bin stores, lift housings, map clutter. */
const MIN_BUILDING_HEIGHT_M = 2;

/** Fallback storey height where a building says how many it has but not how tall. */
const STOREY_M = 3.1;
/** Last resort: a building that says nothing about its height at all. */
const DEFAULT_HEIGHT_M = 9;

/**
 * OSM ways as the bake wants them. The tag height is a fallback for footprints the raster cannot
 * see.
 */
export function fromOverpass(ways: BuildingWay[]): BuildingsFile {
  return {
    schemaVersion: 1,
    circuitId: "",
    buildings: ways.map((way) => {
      const tagged = Number.parseFloat(way.tags.height ?? "");
      const levels = Number.parseFloat(way.tags["building:levels"] ?? "");
      const height = Number.isFinite(tagged)
        ? tagged
        : Number.isFinite(levels)
          ? levels * STOREY_M
          : DEFAULT_HEIGHT_M;
      return {
        id: way.id,
        kind: "building" as const,
        height,
        footprint: way.footprint,
      };
    }),
  };
}

export interface BuildingResult {
  meshes: Record<Belt, Mesh>;
  built: number;
  droppedOnTrack: number;
  droppedOverWater: number;
  /** Footprints reaching past the plinth's wall, which would stand over nothing. */
  droppedOffEdge: number;
  droppedTooLow: number;
  pushedOffTrack: number;
  /** Extra pieces a footprint was split into along its fall line. */
  terraced: number;
  /** Pieces on a cliff whose measured height was the cliff's, and took the tag. */
  cliffHeights: number;
}

/**
 * A footprint placed but not yet built. The kit pass picks which ones become
 * models first; `bakeBuildings` draws the rest.
 */
interface PreparedBuilding {
  id: string;
  ring: { x: number; z: number }[];
  /**
   * The footprint with extra vertices where the ground leaves the line between
   * corners, so a block over a gully does not float.
   */
  wallRing: { x: number; z: number }[];
  /** Where each wall vertex meets the ground, one per `wallRing` point. */
  footAt: number[];
  /** The floor: the middle of the ground the footprint covers. */
  base: number;
  heightM: number;
  centreX: number;
  centreZ: number;
  belt: Belt;
}

/** How far the ground under an edge may stray from the straight wall before it gains a vertex. */
const WALL_FOLLOW_TOLERANCE_M = 0.5;
/** No segment is worth splitting below this: nothing shows in a 1 m gap. */
const WALL_FOLLOW_MIN_M = 1;

/**
 * A ring resampled so its walls follow the ground. Only edges over a dip gain
 * vertices, so a block on flat ground still costs four.
 */
function followGround(
  ring: { x: number; z: number }[],
  groundAt: (x: number, z: number) => number,
  /** A vertex may only be added where this allows one. */
  mayAdd: (x: number, z: number) => boolean,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push(a);
    const heightA = groundAt(a.x, a.z);
    const heightB = groundAt(b.x, b.z);
    if (Number.isNaN(heightA) || Number.isNaN(heightB)) continue;
    splitEdge(out, a, heightA, b, heightB, groundAt, mayAdd, 0);
  }
  return out;
}

function splitEdge(
  out: { x: number; z: number }[],
  a: { x: number; z: number },
  heightA: number,
  b: { x: number; z: number },
  heightB: number,
  groundAt: (x: number, z: number) => number,
  mayAdd: (x: number, z: number) => boolean,
  depth: number,
): void {
  if (depth >= 5 || Math.hypot(b.x - a.x, b.z - a.z) < WALL_FOLLOW_MIN_M * 2) return;
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const heightMid = groundAt(mid.x, mid.z);
  if (Number.isNaN(heightMid)) return;
  if (Math.abs(heightMid - (heightA + heightB) / 2) <= WALL_FOLLOW_TOLERANCE_M) return;
  // A vertex on the centreline cannot be pushed off the track — there is no
  // side to push it to — so the corridor refuses one there rather than fixing
  // it afterwards.
  if (!mayAdd(mid.x, mid.z)) return;
  splitEdge(out, a, heightA, mid, heightMid, groundAt, mayAdd, depth + 1);
  out.push(mid);
  splitEdge(out, mid, heightMid, b, heightB, groundAt, mayAdd, depth + 1);
}

/**
 * Pieces spanning more than this get split along the fall line. At 4 m the hillside
 * became a heap of steps.
 */
const TERRACE_STEP_M = 8;
/** Terraces of one building whose roofs are closer than a storey share the higher roof. */
const ROOF_STEP_MIN_M = STOREY_M;
/** ...as long as it is this wide along the fall, or the halves are slivers. */
const TERRACE_MIN_M = 4;
/** Two rounds is four terraces, four rounds sixteen: a 46 m cliffside plot still steps at 4 m. */
const TERRACE_ROUNDS = 4;
/** Below this a half is a sliver, not a terrace. */
const TERRACE_MIN_M2 = 4;

function ringAreaM2(ring: { x: number; z: number }[]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    twice += a.x * b.z - b.x * a.z;
  }
  return Math.abs(twice) / 2;
}

/** The footprint clipped to one side of a line: both halves keep the cut edge. */
function clipHalf(
  ring: { x: number; z: number }[],
  at: (point: { x: number; z: number }) => number,
  keep: (signed: number) => boolean,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const sa = at(a);
    const sb = at(b);
    if (keep(sa)) out.push(a);
    if (keep(sa) !== keep(sb)) {
      const t = sa === sb ? 0 : sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

/**
 * One footprint as one floor gives a blind plinth downhill and a buried block uphill.
 * Split along the fall line, it steps down the slope like the real ones.
 */
export function splitTerraces(
  ring: { x: number; z: number }[],
  groundAt: (x: number, z: number) => number,
  /** A vertex may only be added where this allows one. */
  mayAdd: (x: number, z: number) => boolean,
): { x: number; z: number }[][] {
  let out = [ring];
  for (let round = 0; round < TERRACE_ROUNDS; round++) {
    let split = false;
    const next: { x: number; z: number }[][] = [];
    for (const shape of out) {
      const halves = splitOnce(shape, groundAt, mayAdd);
      split ||= halves.length > 1;
      next.push(...halves);
    }
    out = next;
    if (!split) break;
  }
  return out;
}

function splitOnce(
  shape: { x: number; z: number }[],
  groundAt: (x: number, z: number) => number,
  mayAdd: (x: number, z: number) => boolean,
): { x: number; z: number }[][] {
  const known = shape
    .map((point) => ({ point, h: groundAt(point.x, point.z) }))
    .filter((known) => !Number.isNaN(known.h));
  if (known.length < 3) return [shape];
  const ordered = known.slice().sort((a, b) => a.h - b.h);
  const half = Math.max(1, Math.floor(ordered.length / 2));
  const centroid = (list: typeof ordered): { x: number; z: number } => {
    let x = 0;
    let z = 0;
    for (const { point } of list) {
      x += point.x / list.length;
      z += point.z / list.length;
    }
    return { x, z };
  };
  const low = centroid(ordered.slice(0, half));
  const high = centroid(ordered.slice(ordered.length - half));
  const dx = high.x - low.x;
  const dz = high.z - low.z;
  const length = Math.hypot(dx, dz);
  if (length < 1) return [shape];
  const along = (point: { x: number; z: number }): number =>
    ((point.x - low.x) * dx + (point.z - low.z) * dz) / length;
  const spans = shape.map(along);
  const width = Math.max(...spans) - Math.min(...spans);
  if (width < TERRACE_MIN_M) return [shape];
  const heights = known.map((known) => known.h);
  if (Math.max(...heights) - Math.min(...heights) <= TERRACE_STEP_M) return [shape];
  const orderedSpans = [...spans].sort((a, b) => a - b);
  const cut = (orderedSpans[(orderedSpans.length - 1) >> 1] + orderedSpans[orderedSpans.length >> 1]) / 2;
  const downhill = clipHalf(shape, (point) => along(point) - cut, (signed) => signed <= 1e-9);
  const uphill = clipHalf(shape, (point) => along(point) - cut, (signed) => signed >= -1e-9);
  if (downhill.length < 3 || uphill.length < 3) return [shape];
  if (ringAreaM2(downhill) < TERRACE_MIN_M2 || ringAreaM2(uphill) < TERRACE_MIN_M2) return [shape];
  // The cut adds vertices the push never saw: a chord across a corridor corner
  // cuts inside it, and a half over water is a building the bake then drops.
  for (const half of [downhill, uphill]) {
    if (!half.every((point) => mayAdd(point.x, point.z))) return [shape];
    if (!half.some((point) => !Number.isNaN(groundAt(point.x, point.z)))) return [shape];
  }
  return [downhill, uphill];
}

export function prepareBuildings(
  buildings: BuildingsFile,
  groundAt: (x: number, z: number) => number,
  plane: ScenePlane,
  corridor: Corridor,
  hollow: PortalHollow,
  road: RoadIndex,
  measured: Map<string, { measured: number }>,
  result: BuildingResult,
  /** Pontoon decks: a harbour building's ground is its deck, water to the terrain. */
  decks: PierDeck[],
  /** The model's footprint on the ground; a building reaching past it is cut off by the wall. */
  rim: { minX: number; maxX: number; minZ: number; maxZ: number },
): PreparedBuilding[] {
  const prepared: PreparedBuilding[] = [];
  const deckAt = (x: number, z: number): number | null => {
    for (const deck of decks) {
      let inside = false;
      const ring = deck.ring;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].x;
        const zi = ring[i].z;
        const xj = ring[j].x;
        const zj = ring[j].z;
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return deck.deckY;
    }
    return null;
  };

  for (const building of buildings.buildings) {
    // The measurement wins where there is one; the tag is the fallback.
    const height = measured.get(building.id)?.measured ?? building.height;
    if (height < MIN_BUILDING_HEIGHT_M) {
      result.droppedTooLow++;
      continue;
    }

    const ring = building.footprint.map(([lon, lat]) => ({ x: plane.x(lon), z: plane.z(lat) }));
    if (ring.length < 3) continue;
    // OSM closes a way by repeating its first node; an extrusion does not want it.
    if (Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].z - ring[ring.length - 1].z) < 1e-6) {
      ring.pop();
    }
    if (ring.length < 3) continue;
    if (ring.some(({ x, z }) => x < rim.minX || x > rim.maxX || z < rim.minZ || z > rim.maxZ)) {
      result.droppedOffEdge++;
      continue;
    }

    const pushed = pushOffTrack(ring, corridor);
    if (!pushed) {
      result.droppedOnTrack++;
      continue;
    }
    const carved = carveOutOfCut(pushed.ring, hollow);
    const pieces: { x: number; z: number }[][] = [];
    let carvedOffRoad = false;
    for (const piece of carved.rings) {
      const split = carveOffRoad(piece, road);
      carvedOffRoad ||= split.carved;
      pieces.push(...split.rings);
    }
    if (!pieces.length) {
      result.droppedOnTrack++;
      continue;
    }
    if (pushed.moved || carved.carved || carvedOffRoad) result.pushedOffTrack++;

    // One entry per piece: a carved footprint is two or three buildings now,
    // and each stands on its own ground. A piece still spanning a slope is
    // terraced first, so each terrace stands on its own middle.
    let emitted = 0;
    for (const carvedShape of pieces) {
      const firstTerrace = prepared.length;
      const mayAdd = (x: number, z: number) => corridor.distance(x, z) >= TRACK_CLEARANCE_M;
      // On a cliff the surface model reads the brow's roofs over the foot's
      // ground: a nine-metre house by Le Rocher measured fifty-nine. There the
      // survey's tag is the better guess.
      const pieceHeight = height > CLIFF_HEIGHT_TRUST * building.height && onCliff(carvedShape, groundAt, mayAdd)
        ? building.height
        : height;
      if (pieceHeight !== height) result.cliffHeights++;
      const terraces = splitTerraces(carvedShape, groundAt, mayAdd);
      if (terraces.length > 1) result.terraced += terraces.length - 1;
      for (const shape of terraces) {
        const piece = emitted++;

      // Quays and reclaimed land put corners over water normally. Only a footprint with
      // no ground at all is skipped, unless it stands on a pontoon.
      const grounds: number[] = [];
      for (const point of shape) {
        const h = groundAt(point.x, point.z);
        if (!Number.isNaN(h)) grounds.push(h);
      }
      if (!grounds.length) {
        let cx = 0;
        let cz = 0;
        for (const point of shape) {
          cx += point.x / shape.length;
          cz += point.z / shape.length;
        }
        const deck = deckAt(cx, cz);
        if (deck === null) {
          result.droppedOverWater++;
          continue;
        }
        grounds.push(deck);
      }
      grounds.sort((a, b) => a - b);
      // Floor at the middle of the ground it covers, walls down to the lowest corner.
      const base = grounds[Math.floor(grounds.length / 2)];
      // Each wall vertex meets the drawn ground where it stands. If the denser ring cannot
      // be pushed clear of the track, keep the corner ring.
      const followed = followGround(shape, groundAt, (x, z) =>
        corridor.distance(x, z) >= TRACK_CLEARANCE_M);
      const wallRing = pushOffTrack(followed, corridor)?.ring ?? shape;
      const footAt = wallRing.map((point) => {
        const under = groundAt(point.x, point.z);
        return Math.min(Number.isNaN(under) ? base : under, base);
      });

      let centreX = 0;
      let centreZ = 0;
      for (const point of shape) {
        centreX += point.x;
        centreZ += point.z;
      }
      centreX /= shape.length;
      centreZ /= shape.length;

      prepared.push({
        // A piece keeps its building's id up to the hash, which is what the roof
        // tags and the kit are keyed on.
        id: piece === 0 ? building.id : `${building.id}#${piece}`,
        ring: shape,
        wallRing,
        footAt,
        base,
        heightM: pieceHeight,
        centreX,
        centreZ,
        belt: beltAtDistance(corridor.distance(centreX, centreZ)),
      });
      }
      levelRoofs(prepared.slice(firstTerrace));
    }
  }

  return prepared;
}

/** Ground this steep under a footprint is a cliff's face, not a street's slope. */
const CLIFF_DEG = 40;
/** On a cliff, a measured height past this many times the tag is the cliff's, not the building's. */
const CLIFF_HEIGHT_TRUST = 1.5;

/** Whether the ground anywhere along a footprint's walls is as steep as a cliff. */
function onCliff(
  shape: { x: number; z: number }[],
  groundAt: (x: number, z: number) => number,
  mayAdd: (x: number, z: number) => boolean,
): boolean {
  const steep = Math.tan((CLIFF_DEG * Math.PI) / 180);
  const step = 2;
  // Resampled first, or a drop between two corners goes unseen.
  return followGround(shape, groundAt, mayAdd).some(({ x, z }) => {
    const dx = groundAt(x + step, z) - groundAt(x - step, z);
    const dz = groundAt(x, z + step) - groundAt(x, z - step);
    return Math.hypot(dx, dz) / (2 * step) > steep;
  });
}

/**
 * Terraces within a storey of each other share the highest roof, so the block steps where its
 * floors do.
 */
function levelRoofs(terraces: PreparedBuilding[]): void {
  const byTop = terraces.slice().sort((a, b) => a.base + a.heightM - (b.base + b.heightM));
  let start = 0;
  while (start < byTop.length) {
    const lowest = byTop[start].base + byTop[start].heightM;
    let end = start + 1;
    while (end < byTop.length && byTop[end].base + byTop[end].heightM - lowest < ROOF_STEP_MIN_M) end++;
    const top = byTop[end - 1].base + byTop[end - 1].heightM;
    for (let i = start; i < end; i++) byTop[i].heightM = top - byTop[i].base;
    start = end;
  }
}

export function bakeBuildings(
  prepared: PreparedBuilding[],
  result: BuildingResult,
  /** Footprints a kit model has already taken; their roofs come with it. */
  taken: Set<string>,
): void {
  const meshes = result.meshes;
  const tops = prepared.map((building) => building.base + building.heightM);
  const walls = new WallIndex(prepared);
  for (const [index, building] of prepared.entries()) {
    if (taken.has(building.id)) continue;
    const { wallRing, footAt, base, heightM, belt } = building;
    // Every roof is flat: pitches from an oriented box put ridges on the wrong axis.
    // The rim makes it read as a roof, and the far belt skips it.
    const near = belt !== "far";
    const top = base + heightM;
    const id = building.id.split("#")[0];
    // No rim where a neighbour's wall stands on the same edge and rises past this
    // roof: the rim's face lay in that wall and the two flickered. Nor where
    // another terrace of this building carries the same roof on.
    const inside = wallRing.map((point, i) =>
      walls.sharing(index, point, wallRing[(i + 1) % wallRing.length]).some((other) =>
        !taken.has(prepared[other].id) &&
        (tops[other] > top + ROOF_SAME_M ||
          (Math.abs(tops[other] - top) <= ROOF_SAME_M && prepared[other].id.split("#")[0] === id))));
    // Keyed on the building, not the terrace, so one block keeps one roof.
    let seed = 0;
    for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) % 1_000_003;
    const roofTone = ROOF_TONE.low + (ROOF_TONE.high - ROOF_TONE.low) * hashAt(seed, 0);
    extrude(meshes[belt], wallRing, footAt, top, near ? PARAPET_M : 0, roofTone, inside);
    result.built++;
  }
}

/** Two roofs this close in height are one roof plane. */
const ROOF_SAME_M = 0.01;
/** How far apart two walls may lie and still be one wall. */
const WALL_SHARED_M = 0.05;
/** Bucket size of the wall index. */
const WALL_BUCKET_M = 16;

/** Every wall of every footprint, found by the edge another footprint shares with it. */
class WallIndex {
  private readonly buckets = new Map<string, { owner: number; a: { x: number; z: number }; b: { x: number; z: number } }[]>();

  constructor(prepared: PreparedBuilding[]) {
    for (const [owner, { wallRing }] of prepared.entries()) {
      for (let i = 0; i < wallRing.length; i++) {
        const a = wallRing[i];
        const b = wallRing[(i + 1) % wallRing.length];
        for (const key of this.keys(a, b)) {
          let list = this.buckets.get(key);
          if (!list) this.buckets.set(key, (list = []));
          list.push({ owner, a, b });
        }
      }
    }
  }

  /** Footprints other than `self` with a wall along most of the edge a–b. */
  sharing(self: number, a: { x: number; z: number }, b: { x: number; z: number }): number[] {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < WALL_SHARED_M) return [];
    const ux = (b.x - a.x) / length;
    const uz = (b.z - a.z) / length;
    const found = new Set<number>();
    for (const key of this.keys(a, b)) {
      for (const wall of this.buckets.get(key) ?? []) {
        if (wall.owner === self || found.has(wall.owner)) continue;
        // On the edge's line, both ends.
        const off = (p: { x: number; z: number }) => Math.abs((p.x - a.x) * uz - (p.z - a.z) * ux);
        if (off(wall.a) > WALL_SHARED_M || off(wall.b) > WALL_SHARED_M) continue;
        // Covering most of it.
        const along = (p: { x: number; z: number }) => (p.x - a.x) * ux + (p.z - a.z) * uz;
        const lo = Math.max(0, Math.min(along(wall.a), along(wall.b)));
        const hi = Math.min(length, Math.max(along(wall.a), along(wall.b)));
        if (hi - lo >= 0.5 * length) found.add(wall.owner);
      }
    }
    return [...found];
  }

  private keys(a: { x: number; z: number }, b: { x: number; z: number }): string[] {
    const keys: string[] = [];
    const c0 = Math.floor(Math.min(a.x, b.x) / WALL_BUCKET_M);
    const c1 = Math.floor(Math.max(a.x, b.x) / WALL_BUCKET_M);
    const r0 = Math.floor(Math.min(a.z, b.z) / WALL_BUCKET_M);
    const r1 = Math.floor(Math.max(a.z, b.z) / WALL_BUCKET_M);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) keys.push(`${c},${r}`);
    return keys;
  }
}

/** Per-building roof tint. One tone made the city a white mass from above. */
const ROOF_TONE = { low: 0.78, high: 0.92 };

/** The rim round a flat roof: what makes it read as a roof and not a lid. */
const PARAPET_M = 0.9;

/** Below this the plinth is a lid on the ground rather than a terrace. */
const KIT_PLINTH_MIN_M = 0.2;
/** Kit plinth walls dig this far into the ground, or the terrain between vertices shows a gap. */
const KIT_PLINTH_DIG_M = 0.3;

/**
 * The terrace a modelled house stands on: its fitted rectangle walled from the ground
 * up to the floor an extrusion would use.
 */
export function bakeKitPlinths(
  kit: KitResult,
  meshes: Record<Belt, Mesh>,
  groundAt: (x: number, z: number) => number,
  corridor: Corridor,
): number {
  let built = 0;
  for (const plinth of kit.plinths) {
    const footAt = plinth.ring.map((point) => {
      const under = groundAt(point.x, point.z);
      return Math.min(Number.isNaN(under) ? plinth.top : under, plinth.top);
    });
    if (plinth.top - Math.min(...footAt) < KIT_PLINTH_MIN_M) continue;
    let centreX = 0;
    let centreZ = 0;
    for (const point of plinth.ring) {
      centreX += point.x / plinth.ring.length;
      centreZ += point.z / plinth.ring.length;
    }
    const belt = beltAtDistance(corridor.distance(centreX, centreZ));
    extrude(meshes[belt], plinth.ring, footAt.map((y) => y - KIT_PLINTH_DIG_M), plinth.top, 0);
    built++;
  }
  return built;
}

export function emptyBuildingResult(): BuildingResult {
  return {
    meshes: { core: createMesh(), city: createMesh(), far: createMesh() } as Record<Belt, Mesh>,
    built: 0,
    droppedOnTrack: 0,
    droppedOverWater: 0,
    droppedOffEdge: 0,
    droppedTooLow: 0,
    pushedOffTrack: 0,
    terraced: 0,
    cliffHeights: 0,
  };
}

/**
 * The corridor owns its ground. Vertices inside move to its edge; a footprint mostly
 * inside is dropped.
 */
function pushOffTrack(
  ring: { x: number; z: number }[],
  corridor: Corridor,
): { ring: { x: number; z: number }[]; moved: boolean } | null {
  // "Mostly inside" is judged on the footprint as it was mapped. Judging it
  // after the densification below would drop a long block for the crossing it
  // is about to be notched around.
  const insideAsMapped = ring.filter(
    (point) => corridor.measure(point.x, point.z).distanceM < TRACK_CLEARANCE_M,
  ).length;
  if (insideAsMapped >= ring.length * 0.6) return null;

  // An edge can cross the corridor with both ends outside, so give it vertices every
  // metre while inside and push those out too.
  const dense = densifyAcrossCorridor(ring, corridor);
  let moved = false;
  // Last side of the road the wall was on. A vertex on the centreline takes its neighbour's side.
  let side: { x: number; z: number } | null = null;
  const out: { x: number; z: number }[] = [];
  for (const point of dense) {
    const { distanceM, footX, footZ } = corridor.measure(point.x, point.z);
    if (distanceM >= TRACK_CLEARANCE_M || !Number.isFinite(distanceM)) {
      out.push(point);
      continue;
    }
    moved = true;
    if (distanceM >= 1e-3) {
      const scale = TRACK_CLEARANCE_M / distanceM;
      side = { x: (point.x - footX) / distanceM, z: (point.z - footZ) / distanceM };
      out.push({ x: footX + (point.x - footX) * scale, z: footZ + (point.z - footZ) * scale });
      continue;
    }
    if (!side) continue; // nothing to go on yet; the ring closes without it
    out.push({ x: footX + side.x * TRACK_CLEARANCE_M, z: footZ + side.z * TRACK_CLEARANCE_M });
  }
  if (out.length < 3) return null;
  if (!moved) return { ring, moved: false };
  return { ring: out, moved: true };
}

/**
 * Cut the road band out of a footprint that sits astride it with no vertex inside
 * the corridor to push.
 */
function carveOffRoad(
  ring: { x: number; z: number }[],
  road: RoadIndex,
): { rings: { x: number; z: number }[][]; carved: boolean } {
  const inside = road.inside(ring);
  if (inside.length < 2) return { rings: [ring], carved: false };

  const first = inside[0];
  const last = inside[inside.length - 1];
  let ux = last.x - first.x;
  let uz = last.z - first.z;
  const length = Math.hypot(ux, uz);
  if (length < 1e-6) return { rings: [ring], carved: false };
  ux /= length;
  uz /= length;
  const midX = (first.x + last.x) / 2;
  const midZ = (first.z + last.z) / 2;
  const across = (p: { x: number; z: number }) => (p.x - midX) * -uz + (p.z - midZ) * ux;

  const pieces = [
    clipHalfPlane(ring, (p) => across(p) - TRACK_CLEARANCE_M),
    clipHalfPlane(ring, (p) => -TRACK_CLEARANCE_M - across(p)),
  ].filter((piece) => piece.length >= 3 && ringAreaXZ(piece) >= MIN_CARVED_AREA_M2);
  if (!pieces.length) return { rings: [], carved: true };
  return { rings: pieces, carved: true };
}

/** The centreline, in buckets, so "is the road inside this footprint" is cheap. */
export interface RoadIndex {
  inside(ring: { x: number; z: number }[]): { x: number; z: number }[];
}

const ROAD_BUCKET_M = 32;

export function buildRoadIndex(points: { x: number; z: number }[]): RoadIndex {
  const buckets = new Map<string, { x: number; z: number }[]>();
  const key = (x: number, z: number) =>
    `${Math.floor(x / ROAD_BUCKET_M)},${Math.floor(z / ROAD_BUCKET_M)}`;
  for (const point of points) {
    const at = key(point.x, point.z);
    const bucket = buckets.get(at);
    if (bucket) bucket.push(point);
    else buckets.set(at, [point]);
  }
  return {
    inside(ring) {
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (const point of ring) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.z < minZ) minZ = point.z;
        if (point.z > maxZ) maxZ = point.z;
      }
      const found: { x: number; z: number }[] = [];
      for (let bx = Math.floor(minX / ROAD_BUCKET_M); bx <= Math.floor(maxX / ROAD_BUCKET_M); bx++) {
        for (let bz = Math.floor(minZ / ROAD_BUCKET_M); bz <= Math.floor(maxZ / ROAD_BUCKET_M); bz++) {
          for (const point of buckets.get(`${bx},${bz}`) ?? []) {
            if (pointInRingXZ(ring, point.x, point.z)) found.push(point);
          }
        }
      }
      return found;
    },
  };
}

/**
 * Cut the tunnel cutting out of a footprint that contains it whole, as three
 * non-overlapping half-plane clips. The front stays open for the road.
 */
function carveOutOfCut(
  ring: { x: number; z: number }[],
  hollow: PortalHollow,
): { rings: { x: number; z: number }[][]; carved: boolean } {
  let rings = [ring];
  let carved = false;
  for (const cut of hollow.cuts) {
    const along = (p: { x: number; z: number }) => (p.x - cut.x) * cut.ux + (p.z - cut.z) * cut.uz;
    const across = (p: { x: number; z: number }) => (p.x - cut.x) * -cut.uz + (p.z - cut.z) * cut.ux;
    const next: { x: number; z: number }[][] = [];
    for (const current of rings) {
      const touches = current.some(
        (p) => Math.abs(across(p)) <= cut.halfM && along(p) >= cut.frontM && along(p) <= cut.backM,
      );
      // A footprint can swallow the cutting whole, so "does any vertex sit in
      // it" is not the test — the centre of the cutting being inside is.
      const swallows = pointInRingXZ(current, cut.x, cut.z);
      if (!touches && !swallows) {
        next.push(current);
        continue;
      }
      const pieces = [
        clipHalfPlane(current, (p) => across(p) - cut.halfM),
        clipHalfPlane(current, (p) => -cut.halfM - across(p)),
        clipHalfPlane(
          clipHalfPlane(
            clipHalfPlane(current, (p) => along(p) - cut.backM),
            (p) => cut.halfM - across(p),
          ),
          (p) => across(p) + cut.halfM,
        ),
      ].filter((piece) => piece.length >= 3 && ringAreaXZ(piece) >= MIN_CARVED_AREA_M2);
      carved = true;
      next.push(...pieces);
    }
    rings = next;
  }
  return { rings, carved };
}

/** Smallest piece of a carved footprint worth building: below this it is a sliver. */
const MIN_CARVED_AREA_M2 = 12;

/** Sutherland–Hodgman against one half-plane: `keep(point) >= 0` survives. */
function clipHalfPlane(
  ring: { x: number; z: number }[],
  keep: (point: { x: number; z: number }) => number,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const da = keep(a);
    const db = keep(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) === (db >= 0)) continue;
    const t = da / (da - db);
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

function pointInRingXZ(ring: { x: number; z: number }[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function ringAreaXZ(ring: { x: number; z: number }[]): number {
  let twice = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    twice += (ring[j].x + ring[i].x) * (ring[i].z - ring[j].z);
  }
  return Math.abs(twice) / 2;
}

/** Points every two metres along the stretch of an edge that lies in the corridor. */
function densifyAcrossCorridor(
  ring: { x: number; z: number }[],
  corridor: Corridor,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  let added = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push(a);
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 2) continue;
    const steps = Math.min(32, Math.max(2, Math.round(length / 2)));
    const inserted: { x: number; z: number }[] = [];
    for (let t = 1; t < steps; t++) {
      const x = a.x + ((b.x - a.x) * t) / steps;
      const z = a.z + ((b.z - a.z) * t) / steps;
      if (corridor.measure(x, z).distanceM >= TRACK_CLEARANCE_M) continue;
      inserted.push({ x, z });
    }
    if (!inserted.length) continue;
    // Keep the run's own ends too, so the notch has square shoulders rather
    // than a chamfer running the length of the wall.
    out.push(...inserted);
    added = true;
  }
  return added ? out : ring;
}

/** What the rim's inside face multiplies the wall's own colour by: the roof's edge reads as an edge. */
const RIM_TONE = 0.8;

/** Repeatable per place: the same footprint rolls the same numbers every bake. */
function hashAt(x: number, z: number): number {
  const value = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

export function extrude(
  mesh: Mesh,
  ring: { x: number; z: number }[],
  /**
   * Where each wall vertex meets the ground. One base plane buries uphill or leaves
   * stilts downhill.
   */
  baseAt: number[],
  top: number,
  parapetM = 0,
  roofTone = 1,
  /** Per ring edge (point i to i + 1): inside a roof another piece continues, so no rim. */
  inside?: boolean[],
): void {
  const contour = ring.map((point) => new Vector2(point.x, -point.z));
  const clockwise = ShapeUtils.area(contour) < 0;
  const order = ring.map((_, i) => i);
  const ordered = clockwise ? [...order].reverse().map((i) => ring[i]) : ring;
  const orderedBase = clockwise ? [...order].reverse().map((i) => baseAt[i]) : baseAt;
  const orderedContour = clockwise ? [...contour].reverse() : contour;
  // Reversed, edge i runs from point n-1-i to n-2-i: the edge (n-2-i, n-1-i) of the ring.
  const orderedInside = (i: number): boolean =>
    !!inside && (clockwise ? inside[(2 * ring.length - 2 - i) % ring.length] : inside[i]);

  const wallTop = top + parapetM;
  for (let i = 0; i < ordered.length; i++) {
    const j = (i + 1) % ordered.length;
    const a = ordered[i];
    const b = ordered[j];
    const rim = parapetM > 0 && !orderedInside(i);
    const wall = rim ? wallTop : top;
    mesh.tone = 1;
    addFlatQuad(mesh, a.x, orderedBase[i], a.z, b.x, orderedBase[j], b.z, b.x, wall, b.z, a.x, wall, a.z);
    if (rim) {
      // Inside face of the rim, seen from anywhere above the roof.
      mesh.tone = RIM_TONE;
      addFlatQuad(mesh, b.x, top, b.z, a.x, top, a.z, a.x, wallTop, a.z, b.x, wallTop, b.z);
    }
  }

  // `triangulateShape` already winds (x, -z) to face the sky, so keep it. One shade
  // per roof, or a dark corner streaks long triangles.
  mesh.tone = roofTone;
  const roofStart = mesh.positions.length / 3;
  for (const [i, j, k] of ShapeUtils.triangulateShape(orderedContour, [])) {
    addFlatTriangle(
      mesh,
      ordered[i].x, top, ordered[i].z,
      ordered[j].x, top, ordered[j].z,
      ordered[k].x, top, ordered[k].z,
    );
  }
  (mesh.flats ??= []).push(roofStart, mesh.positions.length / 3);
}
