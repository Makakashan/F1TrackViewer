/**
 * The shoreline as a line, not as a staircase (docs/city-generation.md P4.0).
 *
 * The height field only knows land from water per raster node, so every water
 * edge it can draw runs along the grid — teeth 4 m across in the core belt and
 * 16 m out in the far one, which is what a breakwater looked like. OSM carries
 * the same edge as a polyline surveyed to about a metre, and a line has no
 * grain, so the terrain is cut against that instead.
 *
 * The line says where the edge is; something still has to say which side of it
 * is dry, and the raster's own boundary is the staircase being replaced.
 *
 * `natural=coastline` answers it by definition: OSM orients it with the land on
 * the left, and across Monaco's 25 coastline ways the raster agrees with that
 * on every single segment it has an opinion about. So the coastline is taken at
 * its word. A quay or a breakwater carries no such promise, so those are
 * oriented by asking the field along their length and taking the majority.
 */

import type { HeightField } from "./heightfield";
import type { ShoreWay } from "./overpass";
import type { ScenePlane } from "./plane";

/**
 * How far from the line the line is trusted. Beyond this the raster mask is
 * the answer, which is right: away from the coast the two agree, and the only
 * place the grain shows is within a cell or two of the water.
 */
const INFLUENCE_M = 26;
/**
 * Perpendicular offsets used to ask the field which side of an unoriented way
 * is dry. It widens because OSM's line and the raster's edge come from
 * different surveys and rarely land on the same metre.
 */
const PROBE_STEPS_M = [3, 5, 8, 12, 18, 26];
/** Fewer readings than this and the majority is not a majority. */
const MIN_ORIENTATION_VOTES = 2;
/** And they have to agree this strongly, or the line straddles the water. */
const MIN_ORIENTATION_AGREEMENT = 0.75;
/**
 * Smallest water area taken as a piece of sea. Below it a `natural=water` ring
 * is a swimming pool or a fountain — real water, but not the coast, and cutting
 * the terrain open around it would drop a courtyard to the sea floor.
 */
const MIN_BASIN_M2 = 2_000;
/**
 * How far to each side a segment is checked for the raster's own edge. Wide
 * enough to cover the usual few metres between two surveys, tight enough that a
 * line left over from before a district was reclaimed finds no water at all.
 */
const AGREEMENT_STEPS_M = [3, 6, 10, 15];
/**
 * How far beyond a segment's own span its endpoint's side-vote is trusted.
 * Farther than this the answer is NaN and the raster's smoothed edge takes
 * over: two segments whose nearest points are both endpoints — the last leg of
 * one way's line and the first of another's, with the segment between them
 * dropped — each vote their side across the whole influence radius, and the
 * votes meet along a curve that is no shoreline at all. The mesh cut along it
 * and drew a strip of land out into the harbour.
 */
const ENDPOINT_TRUST_M = 6;

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit normal pointing at the land side. */
  nx: number;
  nz: number;
}

export interface CoastlineStats {
  ways: number;
  oriented: number;
  unoriented: number;
  segments: number;
  /** Segments the raster could not confirm — see `agreesWithRaster`. */
  segmentsDropped: number;
}

export interface Coastline {
  /**
   * Metres to the nearest shoreline, positive on the land side and negative on
   * the water side. NaN where no line is close enough to have an opinion.
   */
  signedDistance(x: number, z: number): number;
  /**
   * Sharp turns of the surveyed line both of whose legs survived. The cut
   * routes its lip through these instead of staircasing around them: at 4 m a
   * 90° quay corner drawn through grid corners reads as a lone diamond.
   */
  corners: { x: number; z: number }[];
  stats: CoastlineStats;
}

/** A line that never has an opinion: used when there are no shore ways. */
export function emptyCoastline(): Coastline {
  return {
    signedDistance: () => Number.NaN,
    corners: [],
    stats: { ways: 0, oriented: 0, unoriented: 0, segments: 0, segmentsDropped: 0 },
  };
}

/**
 * Does the raster see an edge where this segment claims one is?
 *
 * It has to, or the two sources fight. Larvotto is the case that proves it: the
 * mapped line there is up to 160 m from where the LiDAR puts the water, and a
 * segment cutting on one side of that gap while the raster decides the other
 * side flips the scalar back and forth across zero — the shore comes out as a
 * band of loose triangles rather than as a line. A segment the raster cannot
 * confirm is dropped, and the smoothed raster distance takes that stretch.
 */
function agreesWithRaster(
  segment: Segment,
  field: HeightField,
  plane: ScenePlane,
): boolean {
  const midX = (segment.ax + segment.bx) / 2;
  const midZ = (segment.az + segment.bz) / 2;
  for (const probe of AGREEMENT_STEPS_M) {
    const onLand = field.heightAt(
      plane.lon(midX + segment.nx * probe),
      plane.lat(midZ + segment.nz * probe),
    );
    const onWater = field.heightAt(
      plane.lon(midX - segment.nx * probe),
      plane.lat(midZ - segment.nz * probe),
    );
    if (!Number.isNaN(onLand) && Number.isNaN(onWater)) return true;
    // The raster reading the two sides the *other* way round is not a reason to
    // drop the line. A coastline is oriented by definition — OSM puts the land
    // on its left — so the line already knows which side is which, and what the
    // raster is calling ground on the wet side of it is the boats moored along
    // a pontoon. Ten segments in Monaco read like this, two of them the outline
    // of Port Hercule's pier fingers, which came out as torn slabs offset from
    // where they are mapped for want of them. What the confirmation is really
    // for is a line the raster has nothing to say about on either side, which
    // is the Larvotto case: mapped up to 160 m from where the LiDAR puts the
    // water, with sea on both sides of it.
    if (Number.isNaN(onLand) && !Number.isNaN(onWater)) return true;
  }
  return false;
}

/** A turn this sharp keeps its corner in the cut rather than staircased. */
const CORNER_TURN_DEG = 60;

/** Segments of a way, each carrying a normal that points at the land. */
function pushSegments(
  segments: Segment[],
  corners: { x: number; z: number }[],
  points: readonly (readonly [number, number])[],
  sign: number,
  field: HeightField,
  plane: ScenePlane,
  stats: CoastlineStats,
): void {
  const kept: boolean[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 0.5) {
      kept.push(false);
      continue;
    }
    const nx = -(bz - az) / length;
    const nz = (bx - ax) / length;
    const segment = { ax, az, bx, bz, nx: nx * sign, nz: nz * sign };
    if (!agreesWithRaster(segment, field, plane)) {
      stats.segmentsDropped++;
      kept.push(false);
      continue;
    }
    kept.push(true);
    segments.push(segment);
  }
  // A sharp joint both of whose legs survived is a corner the cut must honour:
  // routed through grid corners, the lip takes the shortcut and the leftover
  // wedge reads as a tooth. A dropped leg breaks the chain, so only joints of
  // two kept legs count.
  const turnAt = (i: number): void => {
    if (!kept[i - 1] || !kept[i]) return;
    const [px, pz] = points[i - 1];
    const [qx, qz] = points[i];
    const [rx, rz] = points[i + 1];
    const ux = qx - px;
    const uz = qz - pz;
    const vx = rx - qx;
    const vz = rz - qz;
    const lu = Math.hypot(ux, uz);
    const lv = Math.hypot(vx, vz);
    if (lu < 1e-9 || lv < 1e-9) return;
    const turn = (Math.acos(Math.min(1, Math.max(-1, (ux * vx + uz * vz) / (lu * lv)))) * 180) / Math.PI;
    if (turn >= CORNER_TURN_DEG) corners.push({ x: qx, z: qz });
  };
  for (let i = 1; i < points.length - 1; i++) turnAt(i);
  // A closed ring turns at its own start too: a rectangular basin has a corner
  // there like anywhere else.
  if (points.length > 3) {
    const [fx, fz] = points[0];
    const [lx, lz] = points[points.length - 1];
    if (Math.hypot(fx - lx, fz - lz) <= 0.5 && kept[0] && kept[kept.length - 1]) {
      const [px, pz] = points[points.length - 2];
      const [rx, rz] = points[1];
      const ux = fx - px;
      const uz = fz - pz;
      const vx = rx - fx;
      const vz = rz - fz;
      const lu = Math.hypot(ux, uz);
      const lv = Math.hypot(vx, vz);
      if (lu >= 1e-9 && lv >= 1e-9) {
        const turn = (Math.acos(Math.min(1, Math.max(-1, (ux * vx + uz * vz) / (lu * lv)))) * 180) / Math.PI;
        if (turn >= CORNER_TURN_DEG) corners.push({ x: fx, z: fz });
      }
    }
  }
}

/**
 * A closed ring's area and the sign that turns its segment normals outward.
 * Which winding a mapper used is arbitrary, so it is read rather than assumed.
 */
function ringOrientation(
  points: readonly (readonly [number, number])[],
): { areaM2: number; outwardSign: number } | null {
  if (points.length < 4) return null;
  const [firstX, firstZ] = points[0];
  const [lastX, lastZ] = points[points.length - 1];
  if (Math.hypot(firstX - lastX, firstZ - lastZ) > 0.5) return null; // not closed

  let twice = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    twice += ax * bz - bx * az;
  }
  // The normal (-dz, dx) points into the ring for one winding and out of it for
  // the other; the signed area is what distinguishes them.
  return { areaM2: Math.abs(twice) / 2, outwardSign: twice > 0 ? 1 : -1 };
}

/** Does the raster agree there is water inside this ring? */
function wetInside(
  points: readonly (readonly [number, number])[],
  field: HeightField,
  plane: ScenePlane,
): boolean {
  let sumX = 0;
  let sumZ = 0;
  for (let i = 0; i < points.length - 1; i++) {
    sumX += points[i][0];
    sumZ += points[i][1];
  }
  const count = points.length - 1;
  if (count < 1) return false;
  // The centroid of a ring can fall outside a crescent-shaped bay, so a few
  // points around it are tried before giving up on the ring.
  const cx = sumX / count;
  const cz = sumZ / count;
  const { minLon, maxLon, minLat, maxLat } = field.bbox;
  for (const [dx, dz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]] as const) {
    const lon = plane.lon(cx + dx);
    const lat = plane.lat(cz + dz);
    // Past the field's edge reads as no ground too, and a pond on the rim opened a hole.
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    if (Number.isNaN(field.heightAt(lon, lat))) return true;
  }
  return false;
}

export function buildCoastline(
  ways: ShoreWay[],
  field: HeightField,
  plane: ScenePlane,
): Coastline {
  const segments: Segment[] = [];
  const corners: { x: number; z: number }[] = [];
  const stats: CoastlineStats = {
    ways: 0,
    oriented: 0,
    unoriented: 0,
    segments: 0,
    segmentsDropped: 0,
  };

  for (const way of ways) {
    stats.ways++;
    // A pier is drawn down the middle of its own deck: water on both sides, so
    // there is no land side to find and cutting against it would slice the deck
    // in half. Its outline is not in the data, so it keeps the raster's edge.
    if (way.kind === "pier" || way.kind === "groyne") {
      stats.unoriented++;
      continue;
    }

    const points = way.points.map(([lon, lat]) => [plane.x(lon), plane.z(lat)] as const);

    // A basin is an area, so its own winding says which side is wet: the land
    // is outside the ring. It has to be big enough to be sea, and the raster
    // has to agree there is water inside it, or a pool on a roof would open a
    // hole in the terrain.
    if (way.kind === "water") {
      const ring = ringOrientation(points);
      if (!ring || ring.areaM2 < MIN_BASIN_M2 || !wetInside(points, field, plane)) {
        stats.unoriented++;
        continue;
      }
      stats.oriented++;
      pushSegments(segments, corners, points, ring.outwardSign, field, plane, stats);
      continue;
    }

    // OSM puts the land on a coastline's left, which in scene axes — x east,
    // z south — is the side opposite the normal below. That needs no vote, and
    // the raster agrees with it on every segment of every coastline way in
    // Monaco it has an opinion about. Taking the tag at its word rescues the
    // long, mostly-inland ways whose handful of testable segments would never
    // reach a quorum on their own.
    let sign: number;
    if (way.kind === "coastline") {
      sign = -1;
    } else {
      let landSide = 0;
      let waterSide = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const [ax, az] = points[i];
        const [bx, bz] = points[i + 1];
        const length = Math.hypot(bx - ax, bz - az);
        if (length < 0.5) continue;
        const nx = -(bz - az) / length;
        const nz = (bx - ax) / length;
        const midX = (ax + bx) / 2;
        const midZ = (az + bz) / 2;
        for (const probe of PROBE_STEPS_M) {
          const ahead = field.heightAt(plane.lon(midX + nx * probe), plane.lat(midZ + nz * probe));
          const behind = field.heightAt(plane.lon(midX - nx * probe), plane.lat(midZ - nz * probe));
          const aheadWater = Number.isNaN(ahead);
          const behindWater = Number.isNaN(behind);
          if (aheadWater === behindWater) continue;
          if (aheadWater) waterSide++;
          else landSide++;
          break;
        }
      }
      const total = landSide + waterSide;
      const agreement = total > 0 ? Math.max(landSide, waterSide) / total : 0;
      if (total < MIN_ORIENTATION_VOTES || agreement < MIN_ORIENTATION_AGREEMENT) {
        stats.unoriented++;
        continue;
      }
      // One orientation for the whole way, from the majority: a single segment
      // sitting in a corner cannot flip the land to the other side.
      sign = landSide >= waterSide ? 1 : -1;
    }
    stats.oriented++;
    pushSegments(segments, corners, points, sign, field, plane, stats);
  }

  stats.segments = segments.length;
  if (segments.length === 0) return { ...emptyCoastline(), stats };

  // Uniform grid over the segments, at the influence radius, so a lookup only
  // ever tests the segments in the nine buckets around it.
  const buckets = new Map<string, Segment[]>();
  const key = (col: number, row: number) => `${col}:${row}`;
  for (const segment of segments) {
    const colFrom = Math.floor(Math.min(segment.ax, segment.bx) / INFLUENCE_M);
    const colTo = Math.floor(Math.max(segment.ax, segment.bx) / INFLUENCE_M);
    const rowFrom = Math.floor(Math.min(segment.az, segment.bz) / INFLUENCE_M);
    const rowTo = Math.floor(Math.max(segment.az, segment.bz) / INFLUENCE_M);
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let col = colFrom; col <= colTo; col++) {
        const bucket = buckets.get(key(col, row));
        if (bucket) bucket.push(segment);
        else buckets.set(key(col, row), [segment]);
      }
    }
  }

  function signedDistance(x: number, z: number): number {
    const col = Math.floor(x / INFLUENCE_M);
    const row = Math.floor(z / INFLUENCE_M);
    let bestDistance = Infinity;
    let bestSign = 0;
    let bestPastEnd = false;

    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        const bucket = buckets.get(key(c, r));
        if (!bucket) continue;
        for (const segment of bucket) {
          const ux = segment.bx - segment.ax;
          const uz = segment.bz - segment.az;
          const lengthSquared = ux * ux + uz * uz;
          const raw = ((x - segment.ax) * ux + (z - segment.az) * uz) / lengthSquared;
          const t = Math.max(0, Math.min(1, raw));
          const px = segment.ax + ux * t;
          const pz = segment.az + uz * t;
          const distance = Math.hypot(x - px, z - pz);
          if (distance >= bestDistance) continue;
          bestDistance = distance;
          // Which side, from the segment's land normal. Taken at the nearest
          // point, so an outside corner reads from the segment that owns it.
          bestSign = (x - px) * segment.nx + (z - pz) * segment.nz >= 0 ? 1 : -1;
          // Past the segment's own span the nearest point is its endpoint, and
          // the endpoint's vote is an extrapolation, not a line.
          bestPastEnd = raw < 0 || raw > 1;
        }
      }
    }

    if (bestDistance > INFLUENCE_M) return Number.NaN;
    if (bestPastEnd && bestDistance > ENDPOINT_TRUST_M) return Number.NaN;
    return bestDistance * bestSign;
  }

  return { signedDistance, corners, stats };
}
