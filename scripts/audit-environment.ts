/**
 * Audits a baked city against the height field it claims to sit on.
 *
 * docs/city-generation.md §4. "Floating building" and "track through a wall" are
 * bugs the eye finds by accident and a number finds every time, so every check
 * here reports what it measured and fails on a threshold rather than on a
 * judgement.
 *
 * The geometry checks read the shipped GLB, not the bake's own report: what is
 * on disk is what the browser draws.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BuildingsFile, WaterFile } from "../src/lib/env/environment-types";
import {
  buildBeltBlocks,
  buildCircuitGround,
  fromOverpass,
  SHORE_EDGE_MAX_M,
  WATER_CLEARANCE_M,
  type BeltBlocks,
} from "./env/bake";
import {
  buildGroundIndex,
  connectedComponents,
  readBakedCircuit,
  type BakedMesh,
  type GroundIndex,
} from "./env/baked-scene";
import { buildCoastline, type Coastline } from "./env/coastline";
import { buildShoreDistance, type ShoreDistance } from "./env/shore-distance";
import { fetchBuildingWays, fetchShoreWays } from "./env/overpass";
import { BELT_BUDGET, BELT_ORDER, buildCorridor, type Belt } from "./env/belts";
import type { HeightField } from "./env/heightfield";
import type { ScenePlane } from "./env/plane";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const ENVIRONMENTS = join(REPO_ROOT, "public", "environments");

// ─── budgets (D5, D14) ─────────────────────────────────────────────────────

/** The city's share. The car fleet and the rest of the scene own the other 45. */
const CITY_DRAW_CALL_BUDGET = 75;

/** Quantisation moves a vertex by up to half a step; beyond this something else did. */
const TERRAIN_TOLERANCE_M = 0.6;
/**
 * The track's own profile is what the ground was burned to, so it should be
 * exact — but the burn sets grid *nodes*, and a reading between them is a
 * bilinear of a surface that curves where the road does. The error therefore
 * scales with the cell: 0.05 m against IGN's 3.9 m is 1.3% of a cell, and
 * 0.235 m against SRTM's 30 m is 0.8%. A fraction of the cell is the honest
 * shape of the limit; the floor keeps the fine circuits held to what they met.
 */
function trackToleranceM(cellM: number): number {
  return Math.max(0.05, cellM * 0.012);
}
/** A footprint corner this far under the ground is a box sunk into a hillside. */
const BURIED_LIMIT_M = 1.5;
/** Above the ground at all is floating, allowing for the quantisation step. */
const FLOATING_LIMIT_M = 0.15;
/**
 * A wall digs into the hill it stands on — that is how a flat floor meets a
 * slope — and the bake lets it dig `MAX_UNDERCUT_M`. Past that the wall is not
 * standing on its plot, it is sunk in it.
 */
const UNDERCUT_LIMIT_M = 8;
/** Ground the corridor owns, matching the bake. */
const TRACK_CLEARANCE_M = 8;
/**
 * Position quantisation moves a baked vertex by up to a tenth of a metre, so a
 * wall standing exactly on the clearance line reads as just inside it. Anything
 * past this is a footprint the push did not move.
 */
const QUANTISATION_SLACK_M = 0.5;
/** Above the ground by this much, geometry over the road is an eave, not a wall. */
const EAVE_CLEARANCE_M = 3;

// ─── checks ────────────────────────────────────────────────────────────────

interface Check {
  name: string;
  measured: string;
  limit: string;
  ok: boolean;
  fatal: boolean;
}

function check(name: string, measured: string, limit: string, ok: boolean, fatal = true): Check {
  return { name, measured, limit, ok, fatal };
}

/** Does the shipped terrain still sit where the field says the ground is? */
/**
 * How close to the cut a vertex has to be before it is measured as coast rather
 * than as ground. The shoreline is cut against the surveyed line, not the
 * raster (P4.0), so along that line the two are meant to differ: the cut holds
 * the quay's height out to the line instead of ramping down to whatever the
 * raster says half a cell inland. One far-belt cell is the widest a cut vertex
 * can sit from the line it was placed on. Past it the terrain is the raster's,
 * and any disagreement is a bug.
 */
const SHORE_EXEMPT_M = 16;

function checkTerrain(
  meshes: { name: string; positions: Float32Array }[],
  field: HeightField,
  plane: ScenePlane,
  coast: Coastline,
  rasterShore: ShoreDistance,
  blocks: BeltBlocks,
): { worst: number; sampled: number; shore: number; worstShore: number; seam: number; worstSeam: number } {
  let worst = 0;
  let sampled = 0;
  let shore = 0;
  let worstShore = 0;
  let seam = 0;
  let worstSeam = 0;

  // The bake cuts against the surveyed line where there is one and against the
  // smoothed raster distance where there is not, so a vertex near the zero of
  // either is a coast vertex and is measured as one.
  const onCut = (x: number, z: number): boolean => {
    const surveyed = coast.signedDistance(x, z);
    const raster = rasterShore.at(plane.lon(x), plane.lat(z));
    if (!Number.isNaN(surveyed) && Math.abs(surveyed) <= SHORE_EXEMPT_M) return true;
    if (Math.abs(raster) <= SHORE_EXEMPT_M) return true;
    // Where the line and the raster disagree about which element this even is,
    // the cut follows the line and the field still reads the raster, so the two
    // are measuring different things and the difference is not a defect.
    return !Number.isNaN(surveyed) && surveyed > 0 !== raster > 0;
  };



  for (const mesh of meshes) {
    if (mesh.name !== "terrain") continue;
    const count = mesh.positions.length / 3;

    /**
     * The highest vertex standing at each footprint.
     *
     * Skirts share a mesh with the surface they hang from, and they are not a
     * surface: measuring one against the ground below it reports the skirt's
     * own depth as drift. They used to be filtered by dropping anything more
     * than 2.5 m off the field, which works only where the ground is flat —
     * on the 4:1 face below Le Rocher the ground under a skirt's foot is
     * metres below the ground under its top, so the foot came in at 2.47 m and
     * passed for surface. A skirt vertex is instead recognised for what it is:
     * something standing directly beneath another vertex of the same mesh.
     */
    const topAt = new Map<number, number>();
    const footprint = (x: number, z: number): number =>
      Math.round(x * 10) * 100_000 + Math.round(z * 10);
    for (let i = 0; i < count; i++) {
      const key = footprint(mesh.positions[i * 3], mesh.positions[i * 3 + 2]);
      const y = mesh.positions[i * 3 + 1];
      const seen = topAt.get(key);
      if (seen === undefined || y > seen) topAt.set(key, y);
    }

    // Every 7th vertex: enough to catch a systematic shift, cheap enough to run
    // on every bake.
    for (let i = 0; i < count; i += 7) {
      const x = mesh.positions[i * 3];
      const y = mesh.positions[i * 3 + 1];
      const z = mesh.positions[i * 3 + 2];
      // Standing under another vertex: a skirt, not the surface.
      if (y < (topAt.get(footprint(x, z)) ?? y) - 0.05) continue;
      const ground = field.heightAt(plane.lon(x), plane.lat(z));
      if (Number.isNaN(ground)) continue;
      // The surface is held clear of the sea plane, so that is the height it is
      // meant to have where the raster reads at or below the datum.
      const delta = Math.abs(y - Math.max(ground, WATER_CLEARANCE_M));
      // Sitting on the cap the waterline is held to, with ground above it, is
      // the signature of `SHORE_EDGE_MAX_M` and of nothing else: this is a cut
      // vertex at the foot of a rise, however far the line has drifted from it.
      const capped = y <= SHORE_EDGE_MAX_M + 0.1 && ground > y + 0.1;
      if (onCut(x, z) || capped) {
        shore++;
        if (delta > worstShore) worstShore = delta;
        continue;
      }
      // A node the fine belt gave up to the coarse one is on the coarse chord
      // on purpose: it is the price of the two surfaces meeting, and measuring
      // it against the raster measures the coarse belt's own reach, not drift.
      if (blocks.conformsAt(x, z)) {
        seam++;
        if (delta > worstSeam) worstSeam = delta;
        continue;
      }
      sampled++;
      if (delta > worst) worst = delta;
    }
  }
  return { worst, sampled, shore, worstShore, seam, worstSeam };
}

interface BuildingFit {
  buriedOverLimit: number;
  worstBuriedM: number;
  inCorridor: number;
  total: number;
}

/**
 * Measures the boxes against the ground independently of the bake: sample the
 * field under every footprint corner, and see how a flat-based prism actually
 * fits the slope it stands on.
 */
function checkBuildings(
  buildings: BuildingsFile,
  field: HeightField,
  plane: ScenePlane,
  corridor: ReturnType<typeof buildCorridor>,
): BuildingFit {
  const fit: BuildingFit = {
    buriedOverLimit: 0,
    worstBuriedM: 0,
    inCorridor: 0,
    total: 0,
  };

  for (const building of buildings.buildings) {
    const heights: number[] = [];
    let inCorridor = false;
    for (const [lon, lat] of building.footprint) {
      const h = field.heightAt(lon, lat);
      if (!Number.isNaN(h)) heights.push(h);
      const distance = corridor.distance(plane.x(lon), plane.z(lat));
      if (distance < TRACK_CLEARANCE_M) inCorridor = true;
    }
    if (!heights.length) continue;
    fit.total++;
    if (inCorridor) fit.inCorridor++;

    const buried = Math.max(...heights) - Math.min(...heights);
    if (buried > fit.worstBuriedM) fit.worstBuriedM = buried;
    if (buried > BURIED_LIMIT_M) fit.buriedOverLimit++;
  }

  return fit;
}

/**
 * How a piece of the shipped city meets the shipped ground.
 *
 * The old check for this read the height field under a footprint's corners and
 * compared that set's own minimum against its own maximum, which cannot be
 * true — it reported zero on every run while buildings visibly hung in the air.
 * The mistake was not the comparison but the evidence: the field is not the
 * surface the browser draws. This measures the mesh that ships against the
 * terrain triangle beneath it.
 */
interface Standing {
  pieces: number;
  overWater: number;
  floating: number;
  worstFloatM: number;
  buried: number;
  worstBuriedM: number;
}

function checkStanding(
  meshes: BakedMesh[],
  names: string[],
  ground: GroundIndex,
  into: Standing,
): void {
  for (const mesh of meshes) {
    if (!names.includes(mesh.name)) continue;
    const { labels, count } = connectedComponents(mesh);
    const lowest = new Float64Array(count).fill(Infinity);
    const onGround = new Uint8Array(count);
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const under = ground.at(mesh.positions[i * 3], mesh.positions[i * 3 + 2]);
      // No ground under it at all is water: a hull floats on the datum, and a
      // quay's own edge hangs over the basin on purpose.
      if (Number.isNaN(under)) continue;
      const label = labels[i];
      onGround[label] = 1;
      const gap = mesh.positions[i * 3 + 1] - under;
      if (gap < lowest[label]) lowest[label] = gap;
    }
    for (let label = 0; label < count; label++) {
      if (!onGround[label]) {
        into.overWater++;
        continue;
      }
      into.pieces++;
      const gap = lowest[label];
      if (gap > FLOATING_LIMIT_M) {
        into.floating++;
        if (gap > into.worstFloatM) into.worstFloatM = gap;
      }
      if (gap < -UNDERCUT_LIMIT_M) {
        into.buried++;
        if (-gap > into.worstBuriedM) into.worstBuriedM = -gap;
      }
    }
  }
}

function polygonAreaM2(points: [number, number][]): number {
  if (points.length < 3) return 0;
  const lat = points[0][1];
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    twice += (ax * mPerDegLon) * (by * 111_320) - (bx * mPerDegLon) * (ay * 111_320);
  }
  return Math.abs(twice) / 2;
}

/** How far the DEM's coastline and OSM's water polygons disagree. */
function checkCoastline(water: WaterFile, field: HeightField): { agree: number; total: number } {
  let agree = 0;
  let total = 0;
  for (const polygon of water.polygons) {
    // Monaco's water layer is mostly swimming pools, which sit on hillsides
    // hundreds of metres up and say nothing about the coast. Only basins worth
    // a hectare are a statement about where the sea is.
    if (polygonAreaM2(polygon.points) < 10_000) continue;
    for (const [lon, lat] of polygon.points) {
      const { minLon, minLat, maxLon, maxLat } = field.bbox;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
      total++;
      const h = field.heightAt(lon, lat);
      // A vertex of an OSM water polygon lies on the shoreline, so the field
      // agrees if it calls that point water, or land barely above the datum.
      if (Number.isNaN(h) || h < 2) agree++;
    }
  }
  return { agree, total };
}

// ─── run ───────────────────────────────────────────────────────────────────

async function audit(circuitId: string): Promise<Check[]> {
  // The same recipe the bake used, so a disagreement here is a real one.
  const { coords, plane, field, corridor, tunnels } = await buildCircuitGround(circuitId);
  const blocks = buildBeltBlocks(field, plane, corridor);

  const dir = join(ENVIRONMENTS, circuitId);
  const manifest = JSON.parse(await readFile(join(dir, "city-manifest.json"), "utf8")) as {
    track: { elevations: number[] };
  };
  // The same source the bake used, not the old pipeline's file.
  const buildings = fromOverpass(await fetchBuildingWays(circuitId, field.bbox));
  // The line the terrain was cut against, rebuilt the same way (P4.0).
  const rasterShore = buildShoreDistance(field);
  const cutLine = buildCoastline(await fetchShoreWays(circuitId, field.bbox), field, plane);
  const water = JSON.parse(await readFile(join(dir, "water.json"), "utf8")) as WaterFile;

  const checks: Check[] = [];
  let totalBytes = 0;
  let totalTriangles = 0;
  let drawCalls = 0;
  let worstTerrain = 0;
  let terrainSamples = 0;
  let shoreSamples = 0;
  let worstShore = 0;
  let seamSamples = 0;
  let worstSeam = 0;
  let waterOffDatum = 0;
  let buildingVerticesOnTrack = 0;
  let worstIntrusionM = 0;
  let propsAground = 0;
  let propVertices = 0;
  const standing: Standing = {
    pieces: 0,
    overWater: 0,
    floating: 0,
    worstFloatM: 0,
    buried: 0,
    worstBuriedM: 0,
  };

  // Every belt is read before any of it is judged: the ground a wall stands on
  // is drawn by whichever belt covers that spot, which is not always its own.
  const baked = await readBakedCircuit(ENVIRONMENTS, circuitId);
  const ground = buildGroundIndex(baked);

  for (const { belt, bytes, meshes } of baked) {
    const triangles = meshes.reduce((sum, mesh) => sum + mesh.triangles, 0);
    totalBytes += bytes;
    totalTriangles += triangles;
    drawCalls += meshes.length;

    const budget = BELT_BUDGET[belt];
    checks.push(
      check(
        `${belt}: bytes`,
        `${(bytes / 1_000_000).toFixed(2)} MB`,
        `${budget.bytes / 1_000_000} MB`,
        bytes <= budget.bytes,
      ),
    );
    checks.push(
      check(
        `${belt}: triangles`,
        triangles.toLocaleString(),
        budget.triangles.toLocaleString(),
        triangles <= budget.triangles,
      ),
    );

    for (const mesh of meshes) {
      // A kit house stands in for a building and owes the corridor the same
      // clearance: it is fitted to the footprint's own rectangle, and a
      // footprint pushed off the track has a rectangle that can still reach it.
      if (mesh.name !== "building" && mesh.name !== "model") continue;
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        const x = mesh.positions[i * 3];
        const y = mesh.positions[i * 3 + 1];
        const z = mesh.positions[i * 3 + 2];
        const distance = corridor.distance(x, z);
        if (distance >= TRACK_CLEARANCE_M - QUANTISATION_SLACK_M) continue;
        // An eave leaning over the road is a building; a wall standing in it is
        // a bug. What separates them is how high above the ground it is.
        const ground = field.heightAt(plane.lon(x), plane.lat(z));
        if (!Number.isNaN(ground) && y - ground > EAVE_CLEARANCE_M) continue;
        buildingVerticesOnTrack++;
        worstIntrusionM = Math.max(worstIntrusionM, TRACK_CLEARANCE_M - distance);
      }
    }

    // A hull below the datum has to be over water. The berths are picked from
    // the field (P4.2), so a boat on the quay means the two have drifted apart.
    for (const mesh of meshes) {
      if (mesh.name !== "prop" && mesh.name !== "propDark") continue;
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        propVertices++;
        if (mesh.positions[i * 3 + 1] >= 0) continue;
        const x = mesh.positions[i * 3];
        const z = mesh.positions[i * 3 + 2];
        if (!field.isWater(plane.lon(x), plane.lat(z))) propsAground++;
      }
    }

    // Buildings and kit models alike: does the thing that ships meet the ground
    // that ships. Measured per welded piece, so one answer per building rather
    // than one per face.
    checkStanding(meshes, ["building", "model"], ground, standing);

    const terrain = checkTerrain(meshes, field, plane, cutLine, rasterShore, blocks);
    if (terrain.worst > worstTerrain) worstTerrain = terrain.worst;
    terrainSamples += terrain.sampled;
    shoreSamples += terrain.shore;
    if (terrain.worstShore > worstShore) worstShore = terrain.worstShore;
    seamSamples += terrain.seam;
    if (terrain.worstSeam > worstSeam) worstSeam = terrain.worstSeam;

    for (const mesh of meshes) {
      if (mesh.name !== "water") continue;
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        if (Math.abs(mesh.positions[i * 3 + 1]) > 0.001) waterOffDatum++;
      }
    }
  }

  checks.push(
    check("total bytes", `${(totalBytes / 1_000_000).toFixed(2)} MB`, "15 MB", totalBytes <= 15_000_000),
  );
  checks.push(
    check("city draw calls", String(drawCalls), String(CITY_DRAW_CALL_BUDGET), drawCalls <= CITY_DRAW_CALL_BUDGET),
  );
  checks.push(
    check(
      "terrain follows the field",
      `worst ${worstTerrain.toFixed(2)} m over ${terrainSamples.toLocaleString()} vertices`
        + ` (${shoreSamples.toLocaleString()} at the cut coast, worst ${worstShore.toFixed(2)} m;`
        + ` ${seamSamples.toLocaleString()} at a belt seam, worst ${worstSeam.toFixed(2)} m)`,
      `${TERRAIN_TOLERANCE_M} m`,
      worstTerrain <= TERRAIN_TOLERANCE_M,
    ),
  );
  checks.push(check("water sits on the datum", `${waterOffDatum} vertices off`, "0", waterOffDatum === 0));

  let worstTrack = 0;
  const profile = manifest.track.elevations;
  const stripped = coords.slice();
  const first = stripped[0];
  const last = stripped[stripped.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) stripped.pop();
  let buriedVertices = 0;
  for (let i = 0; i < Math.min(profile.length, stripped.length); i++) {
    // Under a hill the ground is the hill. The profile is carried between the
    // portals there and has nothing to agree with.
    if (tunnels.buried(stripped[i][0], stripped[i][1])) {
      buriedVertices++;
      continue;
    }
    const ground = field.heightAt(stripped[i][0], stripped[i][1]);
    if (Number.isNaN(ground)) continue;
    worstTrack = Math.max(worstTrack, Math.abs(profile[i] - ground));
  }
  const trackTolerance = trackToleranceM(Math.max(field.cellSizeM.x, field.cellSizeM.y));
  checks.push(
    check(
      "track profile matches the field",
      `worst ${worstTrack.toFixed(3)} m, ${buriedVertices} vertices in tunnel`,
      `${trackTolerance.toFixed(2)} m at a ${field.cellSizeM.x.toFixed(1)} m cell`,
      worstTrack <= trackTolerance,
    ),
  );

  checks.push(
    check(
      "tunnel runs found",
      tunnels.runs.length
        ? `${tunnels.runs.length}, ${tunnels.buriedLengthM} m buried`
        : "none",
      "reported",
      true,
      false,
    ),
  );

  checks.push(
    check(
      "props below the waterline are afloat",
      `${propsAground} aground of ${propVertices.toLocaleString()} prop vertices`,
      "0",
      propsAground === 0,
    ),
  );

  checks.push(
    check(
      "buildings stand on the drawn ground",
      `${standing.floating} floating of ${standing.pieces.toLocaleString()}, worst ${standing.worstFloatM.toFixed(2)} m up`,
      `${FLOATING_LIMIT_M} m`,
      standing.floating === 0,
    ),
  );
  checks.push(
    check(
      "buildings sunk past the undercut",
      `${standing.buried} of ${standing.pieces.toLocaleString()}, worst ${standing.worstBuriedM.toFixed(2)} m down`,
      `${UNDERCUT_LIMIT_M} m`,
      standing.buried === 0,
    ),
  );

  const fit = checkBuildings(buildings, field, plane, corridor);
  // Measured on the shipped mesh: the bake pushes footprints out of the
  // corridor, so checking the source data would only re-read its input.
  checks.push(
    check(
      "baked walls in the track corridor",
      `${buildingVerticesOnTrack} vertices, worst ${worstIntrusionM.toFixed(2)} m in`,
      "0",
      buildingVerticesOnTrack === 0,
    ),
  );
  checks.push(
    check(
      "source footprints reaching the corridor",
      `${fit.inCorridor} of ${fit.total} pushed out`,
      "reported",
      true,
      false,
    ),
  );
  checks.push(
    check(
      "ground range under a footprint",
      `${fit.buriedOverLimit} of ${fit.total}, worst ${fit.worstBuriedM.toFixed(1)} m`,
      `over ${BURIED_LIMIT_M} m: reported`,
      true,
      false,
    ),
  );

  const coast = checkCoastline(water, field);
  if (coast.total === 0) {
    // OSM has no polygon for the sea — the Mediterranean is a coastline way,
    // not an area — and Monaco's water layer is otherwise villa pools. There is
    // nothing here to check the DEM's shoreline against.
    checks.push(check("coastline cross-check", "no OSM basin over 1 ha", "reported", true, false));
  } else {
    const agreement = (100 * coast.agree) / coast.total;
    checks.push(
      check(
        "coastline agrees with OSM water",
        `${agreement.toFixed(1)}% of ${coast.total} vertices`,
        "90%",
        agreement >= 90,
        false,
      ),
    );
  }

  return checks;
}

const USAGE = `Usage:
  bun run env:audit <circuitId>
  bun run env:audit --all

Checks a baked city against its height field and against the budgets in
docs/city-generation.md. Exits non-zero when a fatal check fails.`;

async function report(circuitId: string): Promise<number> {
  const checks = await audit(circuitId);
  console.log(`env:audit — ${circuitId}`);
  let failed = 0;
  for (const entry of checks) {
    const mark = entry.ok ? "ok  " : entry.fatal ? "FAIL" : "warn";
    if (!entry.ok && entry.fatal) failed++;
    console.log(`  ${mark} ${entry.name.padEnd(34)} ${entry.measured.padEnd(38)} limit ${entry.limit}`);
  }
  return failed;
}

/**
 * Every baked circuit, one line each (P4.4).
 *
 * A migration is not thirty-one separate questions. What matters is which
 * circuits fail and on what, so the sweep prints a line per circuit and the
 * failing checks under it, and comes back with the total.
 */
async function reportAll(): Promise<number> {
  const raw = await readFile(join(REPO_ROOT, "public", "circuits", "index.json"), "utf8");
  const parsed = JSON.parse(raw) as { id: string }[] | { circuits: { id: string }[] };
  const ids = (Array.isArray(parsed) ? parsed : parsed.circuits).map((c) => c.id);

  let failedCircuits = 0;
  let missing = 0;
  for (const id of ids) {
    let checks: Check[];
    try {
      checks = await audit(id);
    } catch (error) {
      missing++;
      console.log(`  ---- ${id.padEnd(10)} not baked (${error instanceof Error ? error.message : error})`);
      continue;
    }
    const bad = checks.filter((entry) => !entry.ok && entry.fatal);
    const warned = checks.filter((entry) => !entry.ok && !entry.fatal).length;
    if (bad.length) failedCircuits++;
    console.log(
      `  ${bad.length ? "FAIL" : "ok  "} ${id.padEnd(10)} ` +
        `${checks.length - bad.length - warned}/${checks.length} checks` +
        (warned ? `, ${warned} warn` : ""),
    );
    for (const entry of bad) console.log(`         ${entry.name}: ${entry.measured} (limit ${entry.limit})`);
  }
  console.log(`\n${ids.length - failedCircuits - missing} clean, ${failedCircuits} failing, ${missing} not baked`);
  return failedCircuits + missing;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--all")) {
    if (await reportAll()) process.exitCode = 1;
    return;
  }
  const circuitId = args.find((a) => !a.startsWith("--"));
  if (!circuitId) {
    console.log(USAGE);
    return;
  }
  const failed = await report(circuitId);
  if (failed) {
    console.log(`\n${failed} check${failed === 1 ? "" : "s"} failed`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
