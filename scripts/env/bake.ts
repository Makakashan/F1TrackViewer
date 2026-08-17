/**
 * Bakes a circuit's city into GLB (docs/city-generation.md D6, D13, D14).
 *
 * Everything here reads the one height field, so the terrain, the buildings,
 * the water and the track ribbon cannot disagree about where the ground is.
 * The browser loads the result; it does not build it.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { ShapeUtils, Vector2 } from "three";

import { DIORAMA_COLORS } from "../../src/lib/env/diorama-palette";
import { ENVIRONMENT_ATTRIBUTION, type BuildingsFile } from "../../src/lib/env/environment-types";
import {
  BELT_CELL_M,
  BELT_ORDER,
  BELT_RADIUS_M,
  beltAtDistance,
  buildCorridor,
  type Belt,
  type Corridor,
} from "./belts";
import { buildHeightField, type HeightField } from "./heightfield";
import {
  addFlatQuad,
  addFlatTriangle,
  createMesh,
  GridMesh,
  isEmpty,
  triangleCount,
  type Mesh,
} from "./mesh";
import { scenePlaneFor, type ScenePlane } from "./plane";
import { applyAmbientOcclusion, buildOccluders } from "./ao";
import { buildRoof, PARAPET_M, planRoof, type RoofKind, type RoofTags } from "./roofs";
import { fetchBuildingWays, fetchShoreWays, fetchStructureWays, type BuildingWay } from "./overpass";
import { fetchElevationRaster, sampleRaster } from "./raster";
import { measureBuildingHeights, type HeightStats } from "./building-heights";
import { bakeShoreWalls, type ShoreResult } from "./shore";
import { buildCoastline, type Coastline, type CoastlineStats } from "./coastline";
import { buildShoreDistance } from "./shore-distance";
import {
  applyBuildingOverrides,
  applyTerrainOverrides,
  emptyOverrideStats,
  loadOverrides,
  overrideShoreWays,
  pointInPolygon,
  type CityOverrides,
  type OverrideStats,
} from "./overrides";
import { buildTunnelMask, type TunnelMask } from "./tunnels";
import { circuitBBox, loadCircuitCoords } from "./circuit";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const OUTPUT_ROOT = join(REPO_ROOT, "public", "environments");

/** Clear of the ground the track was burned into, just enough to beat depth precision. */
const TRACK_RAISE_M = 0.05;
/** Half the racing surface where no width profile exists. */
const DEFAULT_TRACK_HALF_WIDTH_M = 6;
/** Ground the track corridor owns; a footprint inside it is pushed out. */
const TRACK_CLEARANCE_M = 8;
/** How far a terrain edge drops where its neighbour is missing, to hide the seam. */
const SKIRT_M = 3;
/**
 * Where the coast's skirt ends. A fixed drop is wrong at the water: a cliff
 * standing 30 m up gets a 3 m hem and the rest is open air, so from the sea the
 * headland reads as a shelf hanging over nothing. Going to a fixed depth below
 * the datum instead costs the same two triangles and closes the wall.
 */
const SHORE_FOOT_M = -3;
/**
 * Highest the land is allowed to be at the water's edge itself.
 *
 * The cut vertex used to inherit the height of the dry node behind it, which is
 * right for a quay — a 5 m wall stays 5 m to its lip — and wrong for a cliff:
 * Le Rocher rises 40 m within one cell of the sea, so its edge inherited the
 * clifftop and the shoreline came out as a palisade of slabs, neighbouring
 * vertices 30 m apart. Capping the edge low puts the waterline at the water and
 * leaves the rise to the ground behind it, which is where the cliff belongs.
 * A quay is barely affected: 3 m of its own height it keeps.
 */
const SHORE_EDGE_MAX_M = 3;
/** Buildings below this are noise — bin stores, lift housings, map clutter. */
const MIN_BUILDING_HEIGHT_M = 2;
/** How far below its own floor a building's walls may reach for the ground. */
const MAX_UNDERCUT_M = 8;

type MeshKind = "terrain" | "building" | "water" | "tunnel" | "portal" | "shore" | "barrier";

const MESH_COLOR: Record<MeshKind, string> = {
  terrain: DIORAMA_COLORS.terrain,
  building: DIORAMA_COLORS.building,
  water: DIORAMA_COLORS.water,
  tunnel: "#14161A",
  portal: DIORAMA_COLORS.buildingSide,
  shore: DIORAMA_COLORS.buildingSide,
  barrier: "#C9CFD6",
};

// ─── terrain ───────────────────────────────────────────────────────────────

interface TerrainResult {
  meshes: Record<Belt, Mesh>;
  cellsByBelt: Record<Belt, number>;
}

/**
 * One grid per belt, each at its own cell size, each covering only the cells
 * whose centre falls in that belt. Where a cell has no neighbour — the coast,
 * or the step to a coarser belt — the edge drops a skirt, which is cheaper than
 * stitching two resolutions and hides the same seam.
 *
 * The water edge is the exception: it is cut against the surveyed shoreline
 * rather than the grid (P4.0), because a grid edge is a staircase and no cell
 * size makes it not one.
 */
function bakeTerrain(
  field: HeightField,
  plane: ScenePlane,
  corridor: Corridor,
  coast: Coastline,
): TerrainResult {
  // Where no surveyed line reaches — a third of a kilometre of Larvotto, among
  // others — the edge still has to come from somewhere smoother than a boolean
  // flag, or the cut falls back on the grid it exists to escape.
  const rasterShore = buildShoreDistance(field);
  const meshes = {} as Record<Belt, Mesh>;
  const cellsByBelt = { core: 0, city: 0, far: 0 } as Record<Belt, number>;

  const minX = plane.x(field.bbox.minLon);
  const maxX = plane.x(field.bbox.maxLon);
  const minZ = plane.z(field.bbox.maxLat); // north edge is the smaller Z
  const maxZ = plane.z(field.bbox.minLat);

  // Which belt owns a patch is decided once, on the coarsest grid, and the finer
  // grids divide into it exactly. Deciding per cell instead leaves a strip that
  // no belt claims — the 8 m cell is outside its belt by its own centre while
  // the 16 m cell covering it is inside by its own, and the gap shows as a
  // hairline of sea along the boundary.
  const blockM = BELT_CELL_M.far;
  const blockCols = Math.ceil((maxX - minX) / blockM);
  const blockRows = Math.ceil((maxZ - minZ) / blockM);
  const blockBelt = new Uint8Array(blockRows * blockCols);
  for (let row = 0; row < blockRows; row++) {
    for (let col = 0; col < blockCols; col++) {
      const belt = beltAtDistance(
        corridor.distance(minX + (col + 0.5) * blockM, minZ + (row + 0.5) * blockM),
      );
      blockBelt[row * blockCols + col] = BELT_ORDER.indexOf(belt);
    }
  }
  const beltOfCell = (row: number, col: number, cell: number): Belt => {
    const blockRow = Math.min(blockRows - 1, Math.floor((row * cell) / blockM));
    const blockCol = Math.min(blockCols - 1, Math.floor((col * cell) / blockM));
    return BELT_ORDER[blockBelt[blockRow * blockCols + blockCol]];
  };

  for (const belt of BELT_ORDER) {
    const cell = BELT_CELL_M[belt];
    const cols = Math.floor((maxX - minX) / cell);
    const rows = Math.floor((maxZ - minZ) / cell);
    const grid = new GridMesh();
    const heightCache = new Map<number, number>();

    const heightAt = (row: number, col: number): number => {
      const key = row * (cols + 2) + col;
      const cached = heightCache.get(key);
      if (cached !== undefined) return cached;
      const x = minX + col * cell;
      const z = minZ + row * cell;
      const value = field.heightAt(plane.lon(x), plane.lat(z));
      heightCache.set(key, value);
      return value;
    };

    const nodes = (rows + 2) * (cols + 2);

    /**
     * A height for a node the terrain is going to stand on. The raster and the
     * surveyed line disagree by a few metres in places, so a node the line puts
     * on land can be one the raster calls sea and has no height for. Rather
     * than drop it to the datum — which ramps the quay into the water like a
     * beach — it takes the nearest dry reading, widening until it finds one.
     */
    const solidHeightAt = (row: number, col: number): number => {
      const own = heightAt(row, col);
      if (!Number.isNaN(own)) return own;
      for (let radius = 1; radius <= 3; radius++) {
        let sum = 0;
        let count = 0;
        for (let dr = -radius; dr <= radius; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
            const value = heightAt(row + dr, col + dc);
            if (Number.isNaN(value)) continue;
            sum += value;
            count++;
          }
        }
        if (count > 0) return sum / count;
      }
      return 0;
    };

    const vertexAt = (row: number, col: number): number =>
      grid.vertex(
        row * (cols + 2) + col,
        minX + col * cell,
        solidHeightAt(row, col),
        minZ + row * cell,
      );

    // How much land there is at a node: metres from the surveyed shoreline
    // where there is one, and otherwise a flag standing in for "well inside"
    // the raster's own land or water. The terrain is the region where this is
    // positive, so the coast lands wherever it crosses zero rather than on the
    // nearest grid line.
    const scalarCache = new Map<number, number>();
    const scalarAt = (row: number, col: number): number => {
      const key = row * (cols + 2) + col;
      const cached = scalarCache.get(key);
      if (cached !== undefined) return cached;
      const x = minX + col * cell;
      const z = minZ + row * cell;
      const surveyed = coast.signedDistance(x, z);
      const value = Number.isNaN(surveyed)
        ? rasterShore.at(plane.lon(x), plane.lat(z))
        : surveyed;
      scalarCache.set(key, value);
      return value;
    };

    /**
     * The point on a cell edge where the land runs out, as a shared vertex: the
     * two cells either side of the edge compute it from the same two nodes, so
     * the cut cannot open a seam.
     */
    const crossingAt = (
      rowA: number, colA: number, sA: number,
      rowB: number, colB: number, sB: number,
    ): number => {
      const horizontal = rowA === rowB;
      const key =
        nodes * (horizontal ? 1 : 2) +
        Math.min(rowA, rowB) * (cols + 2) +
        Math.min(colA, colB);
      const t = Math.max(0, Math.min(1, sA / (sA - sB)));
      const xA = minX + colA * cell;
      const zA = minZ + rowA * cell;
      const x = xA + (minX + colB * cell - xA) * t;
      const z = zA + (minZ + rowB * cell - zA) * t;
      // Height comes from the dry end. The wet end has none, and reading the
      // datum there would ramp the quay down into the sea like a beach.
      const hA = heightAt(rowA, colA);
      const hB = heightAt(rowB, colB);
      let y: number;
      if (!Number.isNaN(hA) && !Number.isNaN(hB)) y = hA + (hB - hA) * t;
      else if (!Number.isNaN(hA)) y = hA;
      else if (!Number.isNaN(hB)) y = hB;
      else y = solidHeightAt(rowA, colA);
      return grid.vertex(key, x, Math.min(y, SHORE_EDGE_MAX_M), z);
    };

    // Land–water crossings, as vertex pairs, so the coast can drop a skirt once
    // the grid is finished and its positions are settled.
    const shoreEdges: [number, number][] = [];
    // Counter-clockwise seen from above, so the normal points at the sky.
    const walk = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (beltOfCell(row, col, cell) !== belt) continue;

        const scalars = walk.map(([dr, dc]) => scalarAt(row + dr, col + dc));
        if (scalars.every((value) => value <= 0)) continue;

        if (scalars.every((value) => value > 0)) {
          grid.triangle(vertexAt(row, col), vertexAt(row + 1, col), vertexAt(row + 1, col + 1));
          grid.triangle(vertexAt(row, col), vertexAt(row + 1, col + 1), vertexAt(row, col + 1));
          cellsByBelt[belt]++;
          continue;
        }

        // A cut cell: walk its rim, keeping the dry corners and adding a vertex
        // wherever the rim crosses the water's edge, then fan the result.
        const ring: number[] = [];
        const cut: boolean[] = [];
        for (let i = 0; i < 4; i++) {
          const [dr, dc] = walk[i];
          const [nr, nc] = walk[(i + 1) % 4];
          if (scalars[i] > 0) {
            ring.push(vertexAt(row + dr, col + dc));
            cut.push(false);
          }
          if (scalars[i] > 0 !== scalars[(i + 1) % 4] > 0) {
            ring.push(
              crossingAt(
                row + dr, col + dc, scalars[i],
                row + nr, col + nc, scalars[(i + 1) % 4],
              ),
            );
            cut.push(true);
          }
        }
        if (ring.length < 3) continue;

        for (let i = 1; i < ring.length - 1; i++) {
          grid.triangle(ring[0], ring[i], ring[i + 1]);
        }
        for (let i = 0; i < ring.length; i++) {
          const next = (i + 1) % ring.length;
          if (cut[i] && cut[next]) shoreEdges.push([ring[i], ring[next]]);
        }
        cellsByBelt[belt]++;
      }
    }

    const mesh = grid.finish();
    addTerrainSkirts(mesh, scalarAt, heightAt, beltOfCell, belt, minX, minZ, cell, rows, cols);
    addShoreSkirts(mesh, shoreEdges);
    meshes[belt] = mesh;
  }

  return { meshes, cellsByBelt };
}

/**
 * A vertical drop on every edge whose neighbour cell was not built — the belt
 * boundary and the edge of the bbox. The water's edge is not one of these: it
 * is cut inside the cell and gets its skirt from `addShoreSkirts`.
 */
function addTerrainSkirts(
  mesh: Mesh,
  scalarAt: (row: number, col: number) => number,
  heightAt: (row: number, col: number) => number,
  beltOfCell: (row: number, col: number, cell: number) => Belt,
  belt: Belt,
  minX: number,
  minZ: number,
  cell: number,
  rows: number,
  cols: number,
): void {
  // Built by the same test the emitter used, or a cell would drop a skirt
  // against a neighbour that is standing right there.
  const built = (row: number, col: number): boolean => {
    if (row < 0 || col < 0 || row >= rows || col >= cols) return false;
    if (beltOfCell(row, col, cell) !== belt) return false;
    return (
      scalarAt(row, col) > 0 ||
      scalarAt(row, col + 1) > 0 ||
      scalarAt(row + 1, col) > 0 ||
      scalarAt(row + 1, col + 1) > 0
    );
  };

  /** Only a rim of dry ground gets a grid-aligned skirt. */
  const dry = (rowA: number, colA: number, rowB: number, colB: number): boolean =>
    scalarAt(rowA, colA) > 0 &&
    scalarAt(rowB, colB) > 0 &&
    !Number.isNaN(heightAt(rowA, colA)) &&
    !Number.isNaN(heightAt(rowB, colB));

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!built(row, col)) continue;
      const x0 = minX + col * cell;
      const x1 = x0 + cell;
      const z0 = minZ + row * cell;
      const z1 = z0 + cell;
      const h00 = heightAt(row, col);
      const h10 = heightAt(row, col + 1);
      const h01 = heightAt(row + 1, col);
      const h11 = heightAt(row + 1, col + 1);

      if (!built(row - 1, col) && dry(row, col, row, col + 1)) {
        addFlatQuad(mesh, x0, h00, z0, x1, h10, z0, x1, h10 - SKIRT_M, z0, x0, h00 - SKIRT_M, z0);
      }
      if (!built(row + 1, col) && dry(row + 1, col, row + 1, col + 1)) {
        addFlatQuad(mesh, x1, h11, z1, x0, h01, z1, x0, h01 - SKIRT_M, z1, x1, h11 - SKIRT_M, z1);
      }
      if (!built(row, col - 1) && dry(row, col, row + 1, col)) {
        addFlatQuad(mesh, x0, h01, z1, x0, h00, z0, x0, h00 - SKIRT_M, z0, x0, h01 - SKIRT_M, z1);
      }
      if (!built(row, col + 1) && dry(row, col + 1, row + 1, col + 1)) {
        addFlatQuad(mesh, x1, h10, z0, x1, h11, z1, x1, h11 - SKIRT_M, z1, x1, h10 - SKIRT_M, z0);
      }
    }
  }
}

/**
 * The coast's own drop. The cut leaves the ground ending at the quay's height
 * in mid-air; this closes it down past the datum so the sea plane meets a wall
 * rather than a torn edge.
 *
 * Each edge runs the way the land's rim does — counter-clockwise seen from
 * above — so reversing it puts the face outward, at the water.
 */
function addShoreSkirts(mesh: Mesh, edges: [number, number][]): void {
  const { positions } = mesh;
  for (const [a, b] of edges) {
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const bx = positions[b * 3];
    const by = positions[b * 3 + 1];
    const bz = positions[b * 3 + 2];
    // Down to the sea floor, not down by a fixed hem: see SHORE_FOOT_M.
    const foot = Math.min(SHORE_FOOT_M, Math.min(ay, by) - 0.5);
    addFlatQuad(
      mesh,
      bx, by, bz,
      ax, ay, az,
      ax, foot, az,
      bx, foot, bz,
    );
  }
}

// ─── water ─────────────────────────────────────────────────────────────────

/**
 * One quad at the datum. D15 puts sea level at y = 0 everywhere, and the ground
 * only dips below it in a handful of cells, so a plane under the whole bbox
 * costs two triangles and needs no coastline of its own — the terrain's edge is
 * the coastline.
 */
function bakeWater(field: HeightField, plane: ScenePlane): Mesh {
  const mesh = createMesh();
  const x0 = plane.x(field.bbox.minLon);
  const x1 = plane.x(field.bbox.maxLon);
  const z0 = plane.z(field.bbox.maxLat);
  const z1 = plane.z(field.bbox.minLat);
  addFlatQuad(mesh, x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0);
  return mesh;
}

// ─── buildings ─────────────────────────────────────────────────────────────

/** Fallback storey height where a building says how many it has but not how tall. */
const STOREY_M = 3.1;
/** Last resort: a building that says nothing about its height at all. */
const DEFAULT_HEIGHT_M = 9;

/**
 * OSM ways as the bake wants them. The tag height is only a fallback — MNH
 * measures the real one (D8) — but it has to be there for the handful of
 * footprints the raster cannot see.
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

interface BuildingResult {
  meshes: Record<Belt, Mesh>;
  roofs: Record<RoofKind, number>;
  built: number;
  droppedOnTrack: number;
  droppedOverWater: number;
  droppedTooLow: number;
  pushedOffTrack: number;
}

/**
 * Flat-topped extrusions for now: roof archetypes and real ridge heights arrive
 * with P3.1 and P3.2. The base is the lowest ground under the footprint, so a
 * building on a slope digs into the hill rather than floating off it.
 */
function bakeBuildings(
  buildings: BuildingsFile,
  field: HeightField,
  plane: ScenePlane,
  corridor: Corridor,
  measured: Map<string, { measured: number }>,
  tags: Map<string, RoofTags>,
): BuildingResult {
  const meshes = { core: createMesh(), city: createMesh(), far: createMesh() } as Record<Belt, Mesh>;
  const result: BuildingResult = {
    meshes,
    roofs: { flat: 0, gabled: 0, hipped: 0, pyramidal: 0, skillion: 0 },
    built: 0,
    droppedOnTrack: 0,
    droppedOverWater: 0,
    droppedTooLow: 0,
    pushedOffTrack: 0,
  };

  for (const building of buildings.buildings) {
    // The measurement wins where there is one; the tag is the fallback (D8).
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

    const pushed = pushOffTrack(ring, corridor);
    if (!pushed) {
      result.droppedOnTrack++;
      continue;
    }
    if (pushed.moved) result.pushedOffTrack++;

    // Fontvieille stands on reclaimed land and Monaco's quays are built to the
    // water, so a footprint with a corner over a water cell is normal. Only a
    // footprint with no ground under it at all is not a building we can place.
    const grounds: number[] = [];
    for (const point of pushed.ring) {
      const h = field.heightAt(plane.lon(point.x), plane.lat(point.z));
      if (!Number.isNaN(h)) grounds.push(h);
    }
    if (!grounds.length) {
      result.droppedOverWater++;
      continue;
    }
    grounds.sort((a, b) => a - b);
    // The floor sits at the middle of the ground it covers and the walls run
    // down to the lowest corner. Standing everything on its lowest corner turns
    // a terraced block on a Monaco hillside into a cliff of wall, and standing
    // it on the middle alone would leave the downhill side in the air.
    const base = grounds[Math.floor(grounds.length / 2)];
    // Each wall vertex meets the ground where it stands, so a block on a slope
    // is neither buried on its uphill side nor left on stilts downhill. It may
    // only dig so far: past MAX_UNDERCUT_M the ground under a footprint on the
    // lip of a cliff is the drop beside it, not the plot it stands on.
    const footAt = pushed.ring.map((point) => {
      const ground = field.heightAt(plane.lon(point.x), plane.lat(point.z));
      const solid = Number.isNaN(ground) ? base : ground;
      return Math.max(base - MAX_UNDERCUT_M, Math.min(solid, base));
    });

    let centreX = 0;
    let centreZ = 0;
    for (const point of pushed.ring) {
      centreX += point.x;
      centreZ += point.z;
    }
    centreX /= pushed.ring.length;
    centreZ /= pushed.ring.length;
    const belt = beltAtDistance(corridor.distance(centreX, centreZ));

    const top = base + height;
    const plan = planRoof(pushed.ring, tags.get(building.id) ?? {}, height);
    result.roofs[plan.kind]++;

    if (plan.kind === "flat") {
      // The rim is what makes a flat roof read as a roof rather than a lid, so
      // the walls run past the roof plane and turn back down inside it. Only
      // where it can be seen: the far belt is silhouettes.
      const parapet = belt === "far" ? 0 : PARAPET_M;
      extrude(meshes[belt], pushed.ring, footAt, top - plan.heightM, parapet);
    } else {
      const eaveY = top - plan.heightM;
      extrude(meshes[belt], pushed.ring, footAt, eaveY, 0);
      buildRoof(meshes[belt], plan, eaveY);
    }
    result.built++;
  }

  return result;
}

/**
 * The corridor owns its ground. A footprint reaching into it has those vertices
 * moved to its edge; one that is mostly inside it is not a building we can keep,
 * because what is left would be a sliver against the barrier.
 */
function pushOffTrack(
  ring: { x: number; z: number }[],
  corridor: Corridor,
): { ring: { x: number; z: number }[]; moved: boolean } | null {
  let inside = 0;
  const out = ring.map((point) => {
    const { distanceM, footX, footZ } = corridor.measure(point.x, point.z);
    if (distanceM >= TRACK_CLEARANCE_M || !Number.isFinite(distanceM)) return point;
    inside++;
    if (distanceM < 1e-3) return point; // dead on the centreline: no way to know which side
    // Slide the vertex out along the ray from the centreline through it.
    const scale = TRACK_CLEARANCE_M / distanceM;
    return {
      x: footX + (point.x - footX) * scale,
      z: footZ + (point.z - footZ) * scale,
    };
  });
  if (inside === 0) return { ring, moved: false };
  if (inside >= ring.length * 0.6) return null;
  return { ring: out, moved: true };
}

function extrude(
  mesh: Mesh,
  ring: { x: number; z: number }[],
  /**
   * Where each wall vertex meets the ground, one per ring point. A single
   * base plane either buries the uphill side or leaves the downhill side on
   * stilts — on the lip of Le Rocher that was a row of slabs hanging over the
   * bay. Following the ground per vertex does neither.
   */
  baseAt: number[],
  top: number,
  parapetM = 0,
): void {
  const contour = ring.map((point) => new Vector2(point.x, -point.z));
  const clockwise = ShapeUtils.area(contour) < 0;
  const order = ring.map((_, i) => i);
  const ordered = clockwise ? [...order].reverse().map((i) => ring[i]) : ring;
  const orderedBase = clockwise ? [...order].reverse().map((i) => baseAt[i]) : baseAt;
  const orderedContour = clockwise ? [...contour].reverse() : contour;

  const wallTop = top + parapetM;
  for (let i = 0; i < ordered.length; i++) {
    const j = (i + 1) % ordered.length;
    const a = ordered[i];
    const b = ordered[j];
    addFlatQuad(mesh, a.x, orderedBase[i], a.z, b.x, orderedBase[j], b.z, b.x, wallTop, b.z, a.x, wallTop, a.z);
    if (parapetM > 0) {
      // Inside face of the rim, seen from anywhere above the roof.
      addFlatQuad(mesh, b.x, top, b.z, a.x, top, a.z, a.x, wallTop, a.z, b.x, wallTop, b.z);
    }
  }

  // `triangulateShape` works in the contour's own plane, which is (x, -z); read
  // back in scene axes that winding already faces the sky, so it is kept as it
  // comes. Reversing it here is what made every flat roof invisible from above.
  for (const [i, j, k] of ShapeUtils.triangulateShape(orderedContour, [])) {
    addFlatTriangle(
      mesh,
      ordered[i].x, top, ordered[i].z,
      ordered[j].x, top, ordered[j].z,
      ordered[k].x, top, ordered[k].z,
    );
  }
}

// ─── tunnel portals ────────────────────────────────────────────────────────

/** Half the opening. Wider than the road, the way a real portal is. */
const PORTAL_HALF_WIDTH_M = 7;
/** Springing height of the arch, and the crown above it. */
const PORTAL_WALL_M = 3;
const PORTAL_ARCH_M = 3.5;
/** Width of the headwall around the opening — what makes it read as a portal. */
const PORTAL_SURROUND_M = 2.5;
/** How far the sleeve stands out of the hillside, and how far it reaches in. */
const PORTAL_OUT_M = 1;
const PORTAL_IN_M = 8;
const PORTAL_ARCH_SEGMENTS = 8;

/**
 * A portal is a short arched sleeve standing out of the hillside at each mouth
 * (D4). The hill itself is untouched — a height field cannot hold a cavity — so
 * what sells the tunnel is the opening: the sleeve's faces point inward, which
 * leaves the near side invisible and the dark far side facing the camera.
 * Excavating the hill properly is P4.1.
 */
/** Half an arch section: up the wall, then over the crown. Shared with the bore
 *  so the mouth and what is behind it are the same shape. */
function portalSection(): { offset: number; height: number }[] {
  const profile: { offset: number; height: number }[] = [];
  profile.push({ offset: -PORTAL_HALF_WIDTH_M, height: 0 });
  profile.push({ offset: -PORTAL_HALF_WIDTH_M, height: PORTAL_WALL_M });
  for (let i = 0; i <= PORTAL_ARCH_SEGMENTS; i++) {
    const angle = Math.PI * (i / PORTAL_ARCH_SEGMENTS);
    profile.push({
      offset: -PORTAL_HALF_WIDTH_M * Math.cos(angle),
      height: PORTAL_WALL_M + PORTAL_ARCH_M * Math.sin(angle),
    });
  }
  profile.push({ offset: PORTAL_HALF_WIDTH_M, height: PORTAL_WALL_M });
  profile.push({ offset: PORTAL_HALF_WIDTH_M, height: 0 });
  return profile;
}

function bakePortals(
  tunnels: TunnelMask,
  field: HeightField,
  plane: ScenePlane,
): { sleeve: Mesh; surround: Mesh } {
  const mesh = createMesh();
  const surround = createMesh();
  const profile = portalSection();

  const { coords, elevations } = field.trackProfile;
  // Mouths sit where the cover starts, not where the tag does — see coveredRuns.
  for (const run of coveredRuns(field, tunnels, BORE_MIN_HEIGHT_M + BORE_COVER_M)) {
    const ends: { index: number; into: number }[] = [
      { index: run[0], into: 1 },
      { index: run[run.length - 1], into: -1 },
    ];
    for (const end of ends) {
      const neighbour = end.index + end.into;
      if (neighbour < 0 || neighbour >= coords.length) continue;
      const x = plane.x(coords[end.index][0]);
      const z = plane.z(coords[end.index][1]);
      let ux = plane.x(coords[neighbour][0]) - x;
      let uz = plane.z(coords[neighbour][1]) - z;
      const length = Math.hypot(ux, uz);
      if (length < 1e-6) continue;
      ux /= length;
      uz /= length;
      const mouth = { x, z, ux, uz };
      const roadY = elevations[end.index];
      if (Number.isNaN(roadY)) continue;

      // The arch ducks under its own hillside. A mouth stands where the cover
      // first reaches the bore's headroom, which is less than the arch plus its
      // headwall needs, so a full-height portal pushed its crown and surround
      // out through the slope — from above, two bright slivers lying in the
      // hill. Scaled to fit, the opening stays a hole in something.
      // The lowest ground the sleeve passes under, not just the ground at the
      // mouth: the sleeve runs 8 m into the slope and the hill is still rising
      // over that, so the mouth's own reading is the optimistic one.
      const crown = PORTAL_WALL_M + PORTAL_ARCH_M;
      let cover = Infinity;
      for (let along = -PORTAL_OUT_M; along <= PORTAL_IN_M; along += 2) {
        const probe = field.heightAt(
          plane.lon(x + ux * along),
          plane.lat(z + uz * along),
        );
        if (Number.isNaN(probe)) continue;
        cover = Math.min(cover, probe - roadY);
      }
      const available = cover === Infinity ? Infinity : cover - PORTAL_SURROUND_M;
      const scale = Math.max(
        BORE_MIN_HEIGHT_M / crown,
        Math.min(1, available / crown),
      );
      // Right-hand normal of the direction: the arch spans across the road.
      const nx = -mouth.uz;
      const nz = mouth.ux;

      const at = (index: number, along: number) => {
        const point = profile[index];
        return {
          x: mouth.x + nx * point.offset + mouth.ux * along,
          y: roadY + point.height * scale,
          z: mouth.z + nz * point.offset + mouth.uz * along,
        };
      };

      const outside = -PORTAL_OUT_M;
      const inside = PORTAL_IN_M;
      for (let i = 0; i < profile.length - 1; i++) {
        const a = at(i, outside);
        const b = at(i + 1, outside);
        const c = at(i + 1, inside);
        const d = at(i, inside);
        // Wound so the faces look in at the road: the near side of the sleeve
        // is culled and the camera sees the dark far side through the opening.
        addFlatQuad(mesh, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, b.x, b.y, b.z);
      }

      // A headwall around the opening. Without it the sleeve reads as a pipe
      // lying on the ground rather than a mouth in a hillside — the arch has to
      // be a hole in something.
      const archCentreHeight = PORTAL_WALL_M * scale;
      const outward = (index: number) => {
        const point = profile[index];
        const dx = point.offset;
        const dy = point.height * scale - archCentreHeight;
        const length = Math.hypot(dx, dy) || 1;
        return {
          offset: point.offset + (dx / length) * PORTAL_SURROUND_M,
          height: point.height + (dy / length) * PORTAL_SURROUND_M,
        };
      };
      // Pressed into the slope: the headwall is 19 m across and the hill falls
      // away sideways, so its outer corners stood clear of the ground however
      // low the arch was scaled. Clamping each point to the ground it sits over
      // buries them without shrinking the opening.
      const face = (offset: number, height: number) => {
        const fx = mouth.x + nx * offset + mouth.ux * outside;
        const fz = mouth.z + nz * offset + mouth.uz * outside;
        const over = field.heightAt(plane.lon(fx), plane.lat(fz));
        const y = roadY + height;
        return { x: fx, y: Number.isNaN(over) ? y : Math.min(y, over), z: fz };
      };
      for (let i = 0; i < profile.length - 1; i++) {
        const a = face(profile[i].offset, profile[i].height * scale);
        const b = face(profile[i + 1].offset, profile[i + 1].height * scale);
        const oa = outward(i);
        const ob = outward(i + 1);
        const c = face(ob.offset, ob.height);
        const d = face(oa.offset, oa.height);
        addFlatQuad(surround, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, b.x, b.y, b.z);
      }

      // No cap: the sleeve used to be closed 8 m in, so the mouth read as a
      // black patch painted on the hill. It now opens into the bore below.
    }
  }

  return { sleeve: mesh, surround };
}

/**
 * The buried stretch that actually has a hill over it.
 *
 * OSM marks the whole 455 m as a tunnel, and it is one — but under the Fairmont
 * and under the waterfront the thing overhead is a building, and a DTM measures
 * the ground beneath a building rather than its roof. So over the first 85 m and
 * the last 27 the field says there is no cover at all, and a bore built there
 * stood on the surface as a black strip: the mouth painted on a hillside, again.
 *
 * Geometry therefore follows the cover, not the tag: the bore is built where the
 * ground is genuinely above it, and its mouths sit where that cover begins. The
 * lap is still buried for the whole tagged length — that is what the profile and
 * the audit read — it simply has no vault where nothing is holding one up.
 */
function coveredRuns(
  field: HeightField,
  tunnels: TunnelMask,
  clearanceM: number,
): number[][] {
  const { coords, elevations } = field.trackProfile;
  const runs: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < coords.length; i++) {
    const ground = tunnels.buried(coords[i][0], coords[i][1])
      ? field.heightAt(coords[i][0], coords[i][1])
      : Number.NaN;
    if (!Number.isNaN(ground) && ground - elevations[i] >= clearanceM) {
      current.push(i);
      continue;
    }
    if (current.length > 1) runs.push(current);
    current = [];
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

/** Metres between rings of the bore. Coarser than the profile: it is seen down
 *  its own length, where a ring every few metres is indistinguishable. */
const BORE_STEP_M = 9;
/** The floor sits a hair below the ribbon so the two never fight for depth. */
const BORE_FLOOR_DROP_M = 0.08;
/** Ground kept over the crown wherever there is ground to keep. */
const BORE_COVER_M = 0.5;
/** However little there is, the bore stays tall enough to be a road tunnel. */
const BORE_MIN_HEIGHT_M = 3.2;

/**
 * The bore itself: floor, walls and vault along the buried stretch of the lap.
 *
 * Without it a portal is a black rectangle on a hillside — the mouth opens into
 * nothing, which is exactly what it looks like. The bore is only ever seen down
 * its own axis through a mouth, so it is a swept section rather than anything
 * excavated: cheap, and enough to read as a tunnel with daylight at the far end.
 * Cutting the hill open for real is still P4.1.
 */
function bakeTunnelBody(
  field: HeightField,
  plane: ScenePlane,
  tunnels: TunnelMask,
  section: { offset: number; height: number }[],
): Mesh {
  const mesh = createMesh();
  const { coords, elevations } = field.trackProfile;
  const runs = coveredRuns(field, tunnels, BORE_MIN_HEIGHT_M + BORE_COVER_M);

  for (const run of runs) {
    // Rings at BORE_STEP_M, plus the last sample, so the bore reaches its mouth.
    const rings: {
      x: number;
      y: number;
      z: number;
      ux: number;
      uz: number;
      scale: number;
    }[] = [];
    let sinceLast = Infinity;
    for (let k = 0; k < run.length; k++) {
      const i = run[k];
      const x = plane.x(coords[i][0]);
      const z = plane.z(coords[i][1]);
      if (rings.length) {
        const previous = rings[rings.length - 1];
        sinceLast = Math.hypot(x - previous.x, z - previous.z);
        if (sinceLast < BORE_STEP_M && k < run.length - 1) continue;
      }
      // Direction from the neighbouring samples, so the section stays square to
      // the road through a curve.
      const before = run[Math.max(0, k - 1)];
      const after = run[Math.min(run.length - 1, k + 1)];
      let ux = plane.x(coords[after][0]) - plane.x(coords[before][0]);
      let uz = plane.z(coords[after][1]) - plane.z(coords[before][1]);
      const length = Math.hypot(ux, uz);
      if (length < 1e-6) continue;
      ux /= length;
      uz /= length;
      // The section ducks under whatever cover there is. Monaco's tunnel runs
      // under the Fairmont for its first 85 m and under the waterfront for its
      // last 27, and a DTM reads the ground beneath a building, not its roof —
      // so a fixed 6.5 m crown stood proud of the terrain over a quarter of the
      // length. Since the bore is only ever seen along its axis, losing a metre
      // of headroom costs nothing and keeps it underground.
      const ground = field.heightAt(coords[i][0], coords[i][1]);
      const available = Number.isNaN(ground)
        ? Infinity
        : ground - elevations[i] - BORE_COVER_M;
      const crown = PORTAL_WALL_M + PORTAL_ARCH_M;
      const scale = Math.max(
        BORE_MIN_HEIGHT_M / crown,
        Math.min(1, available / crown),
      );
      rings.push({ x, y: elevations[i], z, ux, uz, scale });
    }
    if (rings.length < 2) continue;

    const at = (ring: (typeof rings)[number], point: { offset: number; height: number }) => ({
      x: ring.x - ring.uz * point.offset,
      y: ring.y + point.height * ring.scale,
      z: ring.z + ring.ux * point.offset,
    });

    for (let r = 0; r < rings.length - 1; r++) {
      const near = rings[r];
      const far = rings[r + 1];
      for (let i = 0; i < section.length - 1; i++) {
        const a = at(near, section[i]);
        const b = at(near, section[i + 1]);
        const c = at(far, section[i + 1]);
        const d = at(far, section[i]);
        // Seen from inside, so the faces look in at the road.
        addFlatQuad(mesh, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, b.x, b.y, b.z);
      }
      // Floor, dropped a little so it never fights the ribbon for depth.
      const left = section[0];
      const right = section[section.length - 1];
      const nearLeft = at(near, { offset: left.offset, height: -BORE_FLOOR_DROP_M });
      const nearRight = at(near, { offset: right.offset, height: -BORE_FLOOR_DROP_M });
      const farLeft = at(far, { offset: left.offset, height: -BORE_FLOOR_DROP_M });
      const farRight = at(far, { offset: right.offset, height: -BORE_FLOOR_DROP_M });
      addFlatQuad(
        mesh,
        nearLeft.x, nearLeft.y, nearLeft.z,
        nearRight.x, nearRight.y, nearRight.z,
        farRight.x, farRight.y, farRight.z,
        farLeft.x, farLeft.y, farLeft.z,
      );
    }
  }

  return mesh;
}

/** The road's own height at a point, which under a hill only the profile knows. */
function trackHeightNear(field: HeightField, plane: ScenePlane, x: number, z: number): number {
  const { coords, elevations } = field.trackProfile;
  let best = Number.NaN;
  let bestDistance = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const distance = (plane.x(coords[i][0]) - x) ** 2 + (plane.z(coords[i][1]) - z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = elevations[i];
    }
  }
  return best;
}

// ─── barriers ──────────────────────────────────────────────────────────────

/** Clear of the racing surface, where a barrier actually stands. */
const BARRIER_OFFSET_M = 1.2;
const BARRIER_HEIGHT_M = 1.05;
const BARRIER_THICKNESS_M = 0.3;

/**
 * The steel that lines a street circuit (D16). Absence of it reads as a bug —
 * a road through a city with nothing between it and the buildings — so it ships
 * in the core belt, as one mesh rather than one object per panel.
 *
 * Nothing is built through the tunnel: the barrier there is inside the hill.
 */
function bakeBarriers(
  field: HeightField,
  plane: ScenePlane,
  tunnels: TunnelMask,
  halfWidthM: number,
): Mesh {
  const mesh = createMesh();
  const { coords, elevations } = field.trackProfile;
  const offset = halfWidthM + BARRIER_OFFSET_M;

  for (let i = 0; i < coords.length; i++) {
    const next = (i + 1) % coords.length;
    if (tunnels.buried(coords[i][0], coords[i][1])) continue;
    if (tunnels.buried(coords[next][0], coords[next][1])) continue;

    const ax = plane.x(coords[i][0]);
    const az = plane.z(coords[i][1]);
    const bx = plane.x(coords[next][0]);
    const bz = plane.z(coords[next][1]);
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 0.5 || length > 40) continue; // the closing jump back to the line's start
    const nx = (-(bz - az) / length) * offset;
    const nz = ((bx - ax) / length) * offset;
    const ay = elevations[i];
    const by = elevations[next];

    // A thin box, not two coincident faces: coincident quads fight over depth
    // and the one facing away from the sun wins half the time, which reads as a
    // black line down the circuit.
    const half = BARRIER_THICKNESS_M / 2;
    const tx = (-(bz - az) / length) * half;
    const tz = ((bx - ax) / length) * half;
    for (const side of [1, -1]) {
      const cx0 = ax + nx * side;
      const cz0 = az + nz * side;
      const cx1 = bx + nx * side;
      const cz1 = bz + nz * side;
      const top0 = ay + BARRIER_HEIGHT_M;
      const top1 = by + BARRIER_HEIGHT_M;

      // Outer face, inner face, and the cap between them.
      addFlatQuad(
        mesh,
        cx0 + tx, ay, cz0 + tz,
        cx1 + tx, by, cz1 + tz,
        cx1 + tx, top1, cz1 + tz,
        cx0 + tx, top0, cz0 + tz,
      );
      addFlatQuad(
        mesh,
        cx1 - tx, by, cz1 - tz,
        cx0 - tx, ay, cz0 - tz,
        cx0 - tx, top0, cz0 - tz,
        cx1 - tx, top1, cz1 - tz,
      );
      addFlatQuad(
        mesh,
        cx0 - tx, top0, cz0 - tz,
        cx0 + tx, top0, cz0 + tz,
        cx1 + tx, top1, cz1 + tz,
        cx1 - tx, top1, cz1 - tz,
      );
    }
  }

  return mesh;
}

// ─── track ─────────────────────────────────────────────────────────────────

/**
 * The track's height along its own centreline, in the field's datum.
 *
 * The ribbon itself is not baked yet. The runtime still owns the whole track
 * visual — ribbon, kerbs, apron, markings — and splitting it would put two
 * ribbons in the same place fighting over depth. What the runtime cannot know
 * is where the ground ended up, so it gets that here and builds its curve on
 * it; D13 moves the geometry across once the joint has proven itself.
 *
 * One value per centreline vertex, with the closing duplicate dropped, which is
 * what `buildTrackCurveWithY` indexes against.
 */
/**
 * Which stretches of the stripped centreline run under the ground, as index
 * spans into the manifest's own elevation array.
 *
 * The runtime draws the ribbon along the whole lap, and under a hill that puts
 * a red band inside the terrain. Near the car the depth buffer hides it; from
 * a long way off its precision runs out and the ribbon shows through the hill
 * in patches. Rather than fight the depth test, the runtime is told where the
 * road is not to be drawn — under a hill there is a bore to see instead.
 */
function buriedSpans(
  coords: [number, number][],
  plane: ScenePlane,
  field: HeightField,
  tunnels: TunnelMask,
): [number, number][] {
  const points = coords.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) points.pop();
  if (points.length < 2) return [];

  // Fractions of lap length, not of vertex count. The runtime samples its curve
  // evenly by distance while the centreline's own vertices are spaced by
  // whoever drew it — on Monaco the hairpins carry vertices every few metres and
  // the straights every twenty, so an index fraction points somewhere else
  // entirely and the ribbon vanishes well past the tunnel.
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    const step = Math.hypot(
      plane.x(points[i][0]) - plane.x(points[i - 1][0]),
      plane.z(points[i][1]) - plane.z(points[i - 1][1]),
    );
    distances.push(distances[i - 1] + step);
  }
  const closing = Math.hypot(
    plane.x(points[0][0]) - plane.x(points[points.length - 1][0]),
    plane.z(points[0][1]) - plane.z(points[points.length - 1][1]),
  );
  const total = distances[distances.length - 1] + closing;
  if (total <= 0) return [];

  // Hidden where there is ground over the road, however little.
  //
  // Not the tag: OSM marks the whole 455 m, but under the Fairmont and the
  // waterfront the thing overhead is a building, the field reads ground at road
  // level, and hiding there took the ribbon away while the car is still out in
  // the open — missing road before the tunnel.
  //
  // Nor the bore's own test, which needs 3.7 m of cover to fit a vault: between
  // those two there is a stretch with a metre or two of ground over the road,
  // where the ribbon is genuinely buried and showed through the hillside as red
  // dashes. Anything the ground covers is hidden; whether a vault fits there is
  // a different question.
  const clearance = 0.3;
  const spans: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < points.length; i++) {
    const ground = tunnels.buried(points[i][0], points[i][1])
      ? field.heightAt(points[i][0], points[i][1])
      : Number.NaN;
    const road = trackHeightNear(field, plane, plane.x(points[i][0]), plane.z(points[i][1]));
    const buried = !Number.isNaN(ground) && !Number.isNaN(road) && ground - road >= clearance;
    if (buried && start < 0) start = i;
    if (!buried && start >= 0) {
      spans.push([distances[start] / total, distances[i - 1] / total]);
      start = -1;
    }
  }
  if (start >= 0) {
    spans.push([distances[start] / total, distances[points.length - 1] / total]);
  }
  return spans;
}

function trackElevations(field: HeightField, coords: [number, number][], plane: ScenePlane): number[] {
  const points = coords.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) points.pop();

  // Read the field's own track profile, not the ground: in a tunnel the ground
  // is the hill overhead, and the profile is the only thing that knows where
  // the road runs between the portals.
  const profile = field.trackProfile;
  return points.map(([lon, lat]) => {
    const x = plane.x(lon);
    const z = plane.z(lat);
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < profile.coords.length; i++) {
      const distance =
        (plane.x(profile.coords[i][0]) - x) ** 2 + (plane.z(profile.coords[i][1]) - z) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = profile.elevations[i];
      }
    }
    return Number.parseFloat(best.toFixed(2));
  });
}

// ─── GLB ───────────────────────────────────────────────────────────────────

/** glTF base colour is linear; the palette is written the way CSS reads it. */
function srgbToLinear(hex: string): [number, number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(16), channel(8), channel(0), 1];
}

async function writeGlb(path: string, parts: { kind: MeshKind; mesh: Mesh }[]): Promise<number> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();

  for (const { kind, mesh } of parts) {
    if (isEmpty(mesh)) continue;
    const material = document
      .createMaterial(kind)
      .setBaseColorFactor(srgbToLinear(MESH_COLOR[kind]))
      .setRoughnessFactor(kind === "water" ? 0.25 : 0.95)
      .setMetallicFactor(0)
      .setDoubleSided(false);

    const primitive = document
      .createPrimitive()
      .setMaterial(material)
      .setAttribute(
        "POSITION",
        document.createAccessor().setType("VEC3").setArray(new Float32Array(mesh.positions)).setBuffer(buffer),
      )
      .setAttribute(
        "NORMAL",
        document.createAccessor().setType("VEC3").setArray(new Float32Array(mesh.normals)).setBuffer(buffer),
      )
      .setAttribute(
        "COLOR_0",
        mesh.colors
          ? document
              .createAccessor()
              .setType("VEC3")
              .setArray(new Float32Array(mesh.colors))
              .setBuffer(buffer)
          : null,
      )
      .setIndices(
        document.createAccessor().setType("SCALAR").setArray(new Uint32Array(mesh.indices)).setBuffer(buffer),
      );

    scene.addChild(document.createNode(kind).setMesh(document.createMesh(kind).addPrimitive(primitive)));
  }

  await MeshoptEncoder.ready;
  await document.transform(meshopt({ encoder: MeshoptEncoder }));
  const glb = await new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder })
    .writeBinary(document);
  await writeFile(path, glb);
  return glb.byteLength;
}

// ─── run ───────────────────────────────────────────────────────────────────

export interface BakeReport {
  circuitId: string;
  belts: Record<Belt, { bytes: number; triangles: number; drawCalls: number }>;
  buildings: BuildingResult;
  cellsByBelt: Record<Belt, number>;
  trackVertices: number;
  portalTriangles: number;
  barrierTriangles: number;
  shore: ShoreResult;
  coast: CoastlineStats;
  heights: HeightStats;
  tunnels: TunnelMask;
  overrides: OverrideStats;
}

/**
 * Everything the bake and the audit both need, built once from one recipe.
 * Two callers building the field with different inputs is the bug this whole
 * document exists to stop, so neither of them builds it alone.
 */
export interface CircuitGround {
  circuitId: string;
  overrides: CityOverrides | null;
  overrideStats: OverrideStats;
  coords: [number, number][];
  bbox: ReturnType<typeof circuitBBox>;
  plane: ScenePlane;
  field: HeightField;
  corridor: ReturnType<typeof buildCorridor>;
  tunnels: TunnelMask;
}

export async function buildCircuitGround(
  circuitId: string,
  refresh = false,
): Promise<CircuitGround> {
  const coords = await loadCircuitCoords(circuitId);
  const bbox = circuitBBox(coords);
  const plane = scenePlaneFor(coords);
  const dtm = await fetchElevationRaster({ kind: "dtm", bbox, refresh });
  const structures = await fetchStructureWays(circuitId, bbox, refresh);
  const overrides = await loadOverrides(circuitId);
  const overrideStats = emptyOverrideStats();

  const found = buildTunnelMask(coords, structures, plane, {
    ignoreWays: overrides?.tunnels?.ignoreWays,
    groundAt: (lon, lat) => sampleRaster(dtm, lon, lat),
  });
  overrideStats.ignoredTunnelWays = overrides?.tunnels?.ignoreWays?.length ?? 0;

  const tunnelMasks = (overrides?.masks ?? []).filter((mask) => mask.kind === "tunnel");
  overrideStats.tunnelMasks = tunnelMasks.length;
  const tunnels: TunnelMask = tunnelMasks.length
    ? {
        ...found,
        buried: (lon, lat) =>
          found.buried(lon, lat) ||
          tunnelMasks.some((mask) => pointInPolygon(lon, lat, mask.polygon)),
      }
    : found;

  const field = buildHeightField({
    dtm,
    track: {
      coords,
      halfWidthM: DEFAULT_TRACK_HALF_WIDTH_M,
      buried: tunnels.buried,
    },
  });
  // Applied after the burn-in: a hand-set height is the last word, over both
  // the raster and the road.
  applyTerrainOverrides(field, overrides, plane, overrideStats);

  return {
    circuitId,
    overrides,
    overrideStats,
    coords,
    bbox,
    plane,
    field,
    corridor: buildCorridor(coords, plane),
    tunnels,
  };
}

export async function bakeCircuit(circuitId: string, refresh = false): Promise<BakeReport> {
  const { coords, bbox, plane, field, corridor, tunnels, overrides, overrideStats } =
    await buildCircuitGround(circuitId, refresh);
  const shoreWays = overrideShoreWays(
    await fetchShoreWays(circuitId, bbox, refresh),
    overrides,
    overrideStats,
  );
  const coast = buildCoastline(shoreWays, field, plane);
  const shore = bakeShoreWalls(shoreWays, field, plane, coast);

  const elevations = trackElevations(field, coords, plane);
  const portals = bakePortals(tunnels, field, plane);
  const bore = bakeTunnelBody(field, plane, tunnels, portalSection());
  const barriers = bakeBarriers(field, plane, tunnels, DEFAULT_TRACK_HALF_WIDTH_M);
  const terrain = bakeTerrain(field, plane, corridor, coast);
  const water = bakeWater(field, plane);

  const buildingWays = await fetchBuildingWays(circuitId, bbox, refresh);
  const buildingsFile = applyBuildingOverrides(
    fromOverpass(buildingWays),
    overrides,
    overrideStats,
  );
  const heightStats = { value: { measured: 0, fellBack: 0, medianDeltaM: 0, tallest: 0 } };
  const mnh = await fetchElevationRaster({ kind: "mnh", bbox, refresh });
  const measured = measureBuildingHeights(buildingsFile.buildings, mnh, heightStats);
  const roofTags = new Map<string, RoofTags>(
    buildingWays.map((way) => [way.id, way.tags as RoofTags]),
  );
  const buildings = bakeBuildings(buildingsFile, field, plane, corridor, measured, roofTags);

  // Occlusion last: everything that casts it has to exist first.
  const standing = [
    buildings.meshes.core,
    buildings.meshes.city,
    buildings.meshes.far,
    portals.surround,
  ];
  // Barriers occlude nothing worth the trouble and, being thin and at ground
  // level in a street canyon, they come back from the AO pass nearly black.
  const occluders = buildOccluders(field, plane, standing);
  for (const mesh of [
    terrain.meshes.core,
    terrain.meshes.city,
    terrain.meshes.far,
    ...standing,
    shore.walls,
  ]) {
    applyAmbientOcclusion(mesh, occluders);
  }

  const outDir = join(OUTPUT_ROOT, circuitId);
  await mkdir(outDir, { recursive: true });

  const layout: Record<Belt, { kind: MeshKind; mesh: Mesh }[]> = {
    core: [
      { kind: "terrain", mesh: terrain.meshes.core },
      { kind: "building", mesh: buildings.meshes.core },
      { kind: "tunnel", mesh: portals.sleeve },
      { kind: "tunnel", mesh: bore },
      // Its own mesh, not merged into the buildings: a headwall stands over the
      // road on purpose, and the corridor check would read it as a wall in the
      // way.
      { kind: "portal", mesh: portals.surround },
      { kind: "barrier", mesh: barriers },
    ],
    city: [
      { kind: "terrain", mesh: terrain.meshes.city },
      { kind: "building", mesh: buildings.meshes.city },
      // The waterfront is one thing wherever it runs, so it ships whole rather
      // than split across belts by distance.
      { kind: "shore", mesh: shore.walls },
    ],
    far: [
      { kind: "terrain", mesh: terrain.meshes.far },
      { kind: "building", mesh: buildings.meshes.far },
      { kind: "water", mesh: water },
    ],
  };

  const belts = {} as BakeReport["belts"];
  for (const belt of BELT_ORDER) {
    const parts = layout[belt].filter((part) => !isEmpty(part.mesh));
    const bytes = await writeGlb(join(outDir, `${belt}.glb`), parts);
    belts[belt] = {
      bytes,
      triangles: parts.reduce((sum, part) => sum + triangleCount(part.mesh), 0),
      drawCalls: parts.length,
    };
  }

  const report: BakeReport = {
    circuitId,
    belts,
    buildings,
    cellsByBelt: terrain.cellsByBelt,
    trackVertices: elevations.length,
    portalTriangles: triangleCount(portals.sleeve) + triangleCount(portals.surround),
    barrierTriangles: triangleCount(barriers),
    shore,
    coast: coast.stats,
    heights: heightStats.value,
    tunnels,
    overrides: overrideStats,
  };
  await writeManifest(outDir, circuitId, field, plane, report, elevations, buriedSpans(coords, plane, field, tunnels));
  return report;
}

async function writeManifest(
  outDir: string,
  circuitId: string,
  field: HeightField,
  plane: ScenePlane,
  report: BakeReport,
  trackElevationProfile: number[],
  buried: [number, number][],
): Promise<void> {
  const manifest = {
    schemaVersion: 2,
    circuitId,
    style: "city",
    datum: "msl",
    origin: { lon: plane.centerLon, lat: plane.centerLat },
    bbox: field.bbox,
    belts: Object.fromEntries(
      BELT_ORDER.map((belt) => [
        belt,
        {
          file: `${belt}.glb`,
          bytes: report.belts[belt].bytes,
          triangles: report.belts[belt].triangles,
          drawCalls: report.belts[belt].drawCalls,
          radiusM: belt === "far" ? null : BELT_RADIUS_M[belt],
          cellM: BELT_CELL_M[belt],
        },
      ]),
    ),
    counts: {
      buildings: report.buildings.built,
      triangles: BELT_ORDER.reduce((sum, belt) => sum + report.belts[belt].triangles, 0),
      drawCalls: BELT_ORDER.reduce((sum, belt) => sum + report.belts[belt].drawCalls, 0),
    },
    track: {
      /** One height per centreline vertex, closing duplicate dropped. */
      elevations: trackElevationProfile,
      halfWidthM: DEFAULT_TRACK_HALF_WIDTH_M,
      /** Fractions of lap length where the road runs under the ground. */
      buried,
    },
    sources: {
      elevation: "ign-geoplateforme",
      buildings: "openstreetmap",
      centreline: "bacinger/f1-circuits",
    },
    attribution: ENVIRONMENT_ATTRIBUTION,
    generatedAt: new Date().toISOString().slice(0, 10),
  };
  await writeFile(join(outDir, "city-manifest.json"), JSON.stringify(manifest, null, 2));
}

const USAGE = `Usage:
  bun scripts/env/bake.ts <circuitId> [--refresh]

Builds far.glb, city.glb and core.glb into public/environments/<circuitId>/.`;

async function main() {
  const argv = process.argv.slice(2);
  const circuitId = argv.find((a) => !a.startsWith("--"));
  if (!circuitId || argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const report = await bakeCircuit(circuitId, argv.includes("--refresh"));
  const b = report.buildings;
  console.log(`bake — ${report.circuitId}`);
  for (const belt of BELT_ORDER) {
    const entry = report.belts[belt];
    console.log(
      `  ${belt.padEnd(5)} ${(entry.bytes / 1_000_000).toFixed(2).padStart(6)} MB  ` +
        `${String(entry.triangles).padStart(7)} tris  ${entry.drawCalls} draw calls  ` +
        `(${report.cellsByBelt[belt]} terrain cells)`,
    );
  }
  const total = BELT_ORDER.reduce((sum, belt) => sum + report.belts[belt].bytes, 0);
  console.log(`  total ${(total / 1_000_000).toFixed(2)} MB`);
  console.log(
    `  buildings ${b.built} built, ${b.pushedOffTrack} pushed off the track, ` +
      `dropped: ${b.droppedOnTrack} on track, ${b.droppedOverWater} over water, ` +
      `${b.droppedTooLow} too low`,
  );
  console.log(`  track profile ${report.trackVertices} vertices`);
  const h = report.heights;
  console.log(
    `  heights ${h.measured} measured from MNH, ${h.fellBack} on OSM tags, ` +
      `median move ${h.medianDeltaM.toFixed(1)} m, tallest ${h.tallest.toFixed(1)} m`,
  );
  const roofs = report.buildings.roofs;
  console.log(
    `  roofs ${roofs.flat} flat, ${roofs.gabled} gabled, ${roofs.hipped} hipped, ` +
      `${roofs.pyramidal} pyramidal, ${roofs.skillion} skillion`,
  );
  console.log(`  portals ${report.portalTriangles} tris`);
  console.log(`  barriers ${report.barrierTriangles} tris`);
  console.log(
    `  coast ${report.coast.oriented} of ${report.coast.ways} ways cut the terrain ` +
      `(${report.coast.segments} segments), ${report.coast.unoriented} without a land side, ` +
      `${report.coast.segmentsDropped} segments the raster does not confirm`,
  );
  console.log(
    `  shore ${report.shore.built} wall segments, ` +
      `${report.shore.skippedDisagreement} skipped where OSM and the raster disagree, ` +
      `${report.shore.skippedKind} piers skipped, ` +
      `${report.shore.skippedCliff} against cliffs, ` +
      `${report.shore.skippedOffCut} off the cut edge`,
  );
  if (report.tunnels.runs.length) {
    console.log(`  tunnels ${report.tunnels.runs.length} run(s), ${report.tunnels.buriedLengthM} m buried`);
    for (const run of report.tunnels.runs) {
      console.log(`    ${run.name ?? run.wayId} — ${run.lengthM} m`);
    }
  } else {
    console.log("  tunnels none on the racing line");
  }
  const o = report.overrides;
  const applied =
    o.buildingsRemoved + o.buildingsRetimed + o.buildingsAdded + o.buildingsMasked +
    o.terrainPoints + o.waterMasks + o.tunnelMasks + o.ignoredTunnelWays + o.shoreSplines;
  console.log(
    applied
      ? `  overrides ${applied} applied — ${o.buildingsRemoved} removed, ${o.buildingsRetimed} re-heighted, ` +
          `${o.buildingsAdded} added, ${o.buildingsMasked} masked, ${o.terrainPoints} terrain points, ` +
          `${o.waterMasks} water masks, ${o.tunnelMasks} tunnel masks, ${o.ignoredTunnelWays} tunnel ways ignored, ` +
          `${o.shoreSplines} shore splines`
      : "  overrides none",
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
