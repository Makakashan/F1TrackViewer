/**
 * Port Hercule's pontoons and the breakwaters, as decks rather than as terrain.
 *
 * A pontoon in the harbour is 4–5 m wide. The core belt's cell is 4 m, so the
 * shape is narrower than two samples and no marching-squares reconstruction of
 * it can be right: cutting the terrain against the pier rings produced rounded
 * blobs the size of the influence radius, not jetties. The raster agrees it
 * cannot hold them — after the opening, only 12% of the area inside the mapped
 * rings is still land.
 *
 * So the deck is not sampled at all. The ring OSM surveyed is the outline, and
 * it is extruded directly, the way a building footprint is. A grid does not get
 * a say in a shape it cannot represent.
 */

import type { HeightField } from "./heightfield";
import type { ShoreWay } from "./overpass";
import type { ScenePlane } from "./plane";

/**
 * Smallest ring taken as a deck. Below it the ring is a mooring bollard or the
 * nose of a slipway — real, but nothing a viewer would miss.
 */
const MIN_PIER_M2 = 40;
/**
 * Above this share of raster land inside it, the ring may be a mole rather than
 * a pontoon — but only if it is also wide enough for the grid to draw, which is
 * the condition that actually matters. Port Hercule's north mole is 66% land
 * and 9 m across, and the terrain's version of it was a torn comb: how much
 * land the raster kept says nothing about whether it can hold the shape.
 */
const MAX_RASTER_LAND = 0.6;
/**
 * And this is what decides it: a ring narrower than three cells of the finest
 * belt is below what marching squares can express, however solid it is.
 */
const MIN_SOLID_WIDTH_M = 12;
/** Freeboard for a deck the raster has nothing to say about — a floating pontoon. */
const DEFAULT_DECK_M = 0.8;
/** The band a deck is allowed in: clear of the sea, below the quay behind it. */
const MIN_DECK_M = 0.6;
const MAX_DECK_M = 3;
/** Sampling step inside a ring, in metres. Finer than the narrowest deck. */
const SAMPLE_STEP_M = 1.5;
/**
 * How far around a deck the raster's own version of it is cleared away.
 *
 * The LiDAR sees the pontoons and the boats moored along them, and its version
 * sits a few metres off the mapped ring — so the deck and a torn strip of
 * terrain were drawn side by side down the whole of Port Hercule.
 */
const DECK_CLEAR_M = 8;
/**
 * And only where the deck is the nearer of the two.
 *
 * A fixed distance to the shore does not work: the mapped coastline sits
 * several metres off the raster's own quay edge in places, so any threshold
 * generous enough to protect the quay leaves the debris and any threshold tight
 * enough to clear the debris bites notches out of the harbour wall. Which line
 * is closer does not care how far either of them is.
 */
const QUAY_SEARCH_M = 24;

export interface PierDeck {
  ring: { x: number; z: number }[];
  deckY: number;
}

export interface PierResult {
  decks: PierDeck[];
  /**
   * Is this the raster's own copy of a deck, standing next to the real one?
   *
   * True near a deck and away from every surveyed shore line. The terrain reads
   * it as water so the deck is the only thing drawn there.
   */
  clearsTerrain(x: number, z: number): boolean;
  /** Rings that were not decked, by the reason they were not. */
  skippedOpen: number;
  skippedSmall: number;
  skippedSolid: number;
}

function ringArea(ring: { x: number; z: number }[]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    twice += a.x * b.z - b.x * a.z;
  }
  return Math.abs(twice) / 2;
}

/**
 * Roughly how wide the ring is: its area over its longer side. A jetty 100 m
 * long and 5 m across comes out at 5, which is the number that matters.
 */
function meanWidth(ring: { x: number; z: number }[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of ring) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  const longer = Math.max(maxX - minX, maxZ - minZ);
  return longer > 0 ? ringArea(ring) / longer : 0;
}

function pointInRing(ring: { x: number; z: number }[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * How high the deck sits, and how solid the ground under it is.
 *
 * The deck has to clear whatever the raster did keep, or the remnant pokes
 * through it — so this is a high percentile of the readings inside the ring
 * rather than their middle.
 */
function deckHeight(
  ring: { x: number; z: number }[],
  field: HeightField,
  plane: ScenePlane,
): { deckY: number; landShare: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of ring) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }

  const heights: number[] = [];
  let samples = 0;
  for (let x = minX; x <= maxX; x += SAMPLE_STEP_M) {
    for (let z = minZ; z <= maxZ; z += SAMPLE_STEP_M) {
      if (!pointInRing(ring, x, z)) continue;
      samples++;
      const height = field.heightAt(plane.lon(x), plane.lat(z));
      if (!Number.isNaN(height)) heights.push(height);
    }
  }

  const landShare = samples > 0 ? heights.length / samples : 0;
  if (heights.length === 0) return { deckY: DEFAULT_DECK_M, landShare };
  heights.sort((a, b) => a - b);
  const p90 = heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.9))];
  return { deckY: Math.max(MIN_DECK_M, Math.min(p90, MAX_DECK_M)), landShare };
}

export function buildPiers(
  ways: ShoreWay[],
  field: HeightField,
  plane: ScenePlane,
): PierResult {
  const result: PierResult = {
    decks: [],
    clearsTerrain: () => false,
    skippedOpen: 0,
    skippedSmall: 0,
    skippedSolid: 0,
  };

  for (const way of ways) {
    // A breakwater is the same problem wearing a different tag: Fontvieille's
    // are 6 and 9 m across, mapped as closed rings, and the grid makes the same
    // comb of them that it made of the pontoons.
    if (way.kind !== "pier" && way.kind !== "breakwater") continue;
    const points = way.points.map(([lon, lat]) => ({ x: plane.x(lon), z: plane.z(lat) }));
    if (points.length < 4) {
      result.skippedOpen++;
      continue;
    }
    const first = points[0];
    const last = points[points.length - 1];
    // A pier mapped as a line is a centreline down its own deck: no outline to
    // extrude, and it keeps whatever the terrain makes of it.
    if (Math.hypot(first.x - last.x, first.z - last.z) > 0.5) {
      result.skippedOpen++;
      continue;
    }
    // The closing point repeats the first; an extruded ring must not.
    const ring = points.slice(0, -1);
    if (ringArea(ring) < MIN_PIER_M2) {
      result.skippedSmall++;
      continue;
    }
    const { deckY, landShare } = deckHeight(ring, field, plane);
    if (landShare > MAX_RASTER_LAND && meanWidth(ring) >= MIN_SOLID_WIDTH_M) {
      result.skippedSolid++;
      continue;
    }
    result.decks.push({ ring, deckY });
  }

  // Everything that is not a pier is a surveyed shore: the coast, the quays,
  // the basin outlines. A deck's halo stops where one of those begins.
  const shore: { ax: number; az: number; bx: number; bz: number }[] = [];
  for (const way of ways) {
    if (way.kind === "pier" || way.kind === "breakwater") continue;
    const points = way.points.map(([lon, lat]) => ({ x: plane.x(lon), z: plane.z(lat) }));
    for (let i = 0; i < points.length - 1; i++) {
      shore.push({ ax: points[i].x, az: points[i].z, bx: points[i + 1].x, bz: points[i + 1].z });
    }
  }

  /**
   * Nearest segment distance, from a uniform hash so a lookup only tests its
   * own neighbourhood. `clearsTerrain` is asked for every node of every belt's
   * grid — a few hundred thousand times — and a linear scan over the shore
   * would take longer than the rest of the bake put together. Distances beyond
   * one cell are reported as Infinity, which is all the comparison needs.
   */
  const index = (
    segments: { ax: number; az: number; bx: number; bz: number }[],
    cell: number,
  ) => {
    const buckets = new Map<string, typeof segments>();
    const key = (col: number, row: number) => `${col}:${row}`;
    for (const segment of segments) {
      const colFrom = Math.floor(Math.min(segment.ax, segment.bx) / cell);
      const colTo = Math.floor(Math.max(segment.ax, segment.bx) / cell);
      const rowFrom = Math.floor(Math.min(segment.az, segment.bz) / cell);
      const rowTo = Math.floor(Math.max(segment.az, segment.bz) / cell);
      for (let row = rowFrom; row <= rowTo; row++) {
        for (let col = colFrom; col <= colTo; col++) {
          const bucket = buckets.get(key(col, row));
          if (bucket) bucket.push(segment);
          else buckets.set(key(col, row), [segment]);
        }
      }
    }
    return (x: number, z: number): number => {
      const col = Math.floor(x / cell);
      const row = Math.floor(z / cell);
      let best = Infinity;
      for (let r = row - 1; r <= row + 1; r++) {
        for (let c = col - 1; c <= col + 1; c++) {
          const bucket = buckets.get(key(c, r));
          if (!bucket) continue;
          for (const segment of bucket) {
            const ux = segment.bx - segment.ax;
            const uz = segment.bz - segment.az;
            const lengthSquared = ux * ux + uz * uz;
            let t = lengthSquared
              ? ((x - segment.ax) * ux + (z - segment.az) * uz) / lengthSquared
              : 0;
            t = Math.max(0, Math.min(1, t));
            const distance = Math.hypot(x - segment.ax - ux * t, z - segment.az - uz * t);
            if (distance < best) best = distance;
          }
        }
      }
      return best;
    };
  };

  const deckSegments = result.decks.flatMap((deck) =>
    deck.ring.map((point, i) => {
      const next = deck.ring[(i + 1) % deck.ring.length];
      return { ax: point.x, az: point.z, bx: next.x, bz: next.z };
    }),
  );
  const toDeck = index(deckSegments, QUAY_SEARCH_M);
  const toShore = index(shore, QUAY_SEARCH_M);

  result.clearsTerrain = (x: number, z: number): boolean => {
    const deck = toDeck(x, z);
    return deck <= DECK_CLEAR_M && deck < toShore(x, z);
  };

  return result;
}
