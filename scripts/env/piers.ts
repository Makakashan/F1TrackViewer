/**
 * Port Hercule's pontoons, as decks rather than as terrain.
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
 * Above this share of raster land inside it, the ring is not a pontoon but a
 * mole: wide enough that the terrain already draws it properly, and decking it
 * over would flatten ground that is correct.
 */
const MAX_RASTER_LAND = 0.6;
/** Freeboard for a deck the raster has nothing to say about — a floating pontoon. */
const DEFAULT_DECK_M = 0.8;
/** The band a deck is allowed in: clear of the sea, below the quay behind it. */
const MIN_DECK_M = 0.6;
const MAX_DECK_M = 3;
/** Sampling step inside a ring, in metres. Finer than the narrowest deck. */
const SAMPLE_STEP_M = 1.5;

export interface PierDeck {
  ring: { x: number; z: number }[];
  deckY: number;
}

export interface PierResult {
  decks: PierDeck[];
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
  const result: PierResult = { decks: [], skippedOpen: 0, skippedSmall: 0, skippedSolid: 0 };

  for (const way of ways) {
    if (way.kind !== "pier") continue;
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
    if (landShare > MAX_RASTER_LAND) {
      result.skippedSolid++;
      continue;
    }
    result.decks.push({ ring, deckY });
  }

  return result;
}
