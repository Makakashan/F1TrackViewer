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

import { BAKED_MESH_COLORS, DIORAMA_COLORS, type BakedMeshKind } from "../../src/lib/env/diorama-palette";
import { ENVIRONMENT_ATTRIBUTION, type BuildingsFile } from "../../src/lib/env/environment-types";
import {
  BELT_BUDGET,
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
import { applyAlbedo, applyAmbientOcclusion, buildOccluders, shadeBySlope } from "./ao";
import { buildRoof, PARAPET_M, planRoof, type RoofKind, type RoofTags } from "./roofs";
import {
  fetchBuildingWays,
  fetchGreenWays,
  fetchBreaklineWays,
  fetchShoreWays,
  fetchStructureWays,
  type BreaklineWay,
  type BuildingWay,
  type GreenWay,
  type ShoreWay,
  type StructureWay,
} from "./overpass";
import { buildGreenery, plantTrees, type GreeneryResult } from "./greenery";
import { buildSurfaceIndex } from "./baked-scene";
import { buildBreaklines } from "./breaklines";
import { buildGround, type Ground } from "./ground";
import {
  chooseKitHouses,
  repaintKitHouse,
  KIT_BUDGET_SHARE,
  loadKitHouses,
  loadKitPaths,
  type KitModel,
  type KitResult,
} from "./kit";
import {
  fetchElevationRaster,
  providerFor,
  sampleRaster,
  type Raster,
  type RasterBBox,
} from "./raster";
import { measureBuildingHeights, type HeightStats } from "./building-heights";
import { buildPiers, type PierResult } from "./piers";
import { berthYachts, buildProps, type PropResult } from "./props";
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
/**
 * How far a tree stands from the racing line.
 *
 * Wider than the corridor: a kit tree is a canopy on a trunk, and its branches
 * reach past the point it is planted at. Monaco's street trees are mapped at
 * the kerb, so without this the lap ran through the planting — `env:audit`
 * counted 417 vertices of it inside the corridor.
 */
const TREE_CLEARANCE_M = 11;
/** How far a terrain edge drops where its neighbour is missing, to hide the seam. */
const SKIRT_M = 3;
/**
 * The bottom of the block the landscape is cut from.
 *
 * A skirt is the wrong answer at the edge of the bbox: three metres of hem under
 * a hill that stands 452 m up reads as a sheet of paper, not as ground. The rim
 * goes to one flat floor instead, deep enough to look like rock and shallow
 * enough that the model does not become a column — the terrain's own relief is
 * 455 m, so a 60 m block is under a seventh of it.
 */
const PLINTH_FLOOR_M = -60;
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
export const SHORE_EDGE_MAX_M = 3;
/**
 * How far the land is held above the sea plane.
 *
 * The water is one quad at the datum (`bakeWater`), so any ground the DTM reads
 * at y = 0 is co-planar with it and the depth buffer decides per pixel which of
 * the two is in front. That decision moves with the camera, so the waterline
 * changed shape as the view pulled back: 7,625 m2 of Larvotto's beach and the
 * Monte-Carlo Bay foreshore sit within 15 cm of the datum. Holding the surface
 * a fixed step above the plane costs nothing at any other height and leaves the
 * coast where the cut put it, which is the only thing that should decide it.
 */
export const WATER_CLEARANCE_M = 0.25;
/**
 * How far the surveyed line may say "water" before the raster stops overruling
 * it, and how far inland the raster has to be to do the overruling.
 *
 * The signed distance is to the *nearest* segment, so at a concave corner — a
 * pier meeting its quay — that segment's wet side sweeps back over ground
 * behind it and punches a hole. At the root of Port Hercule's T pier the line
 * reads -1.8 m with +2.4 and +1.0 either side of it, while the raster has it
 * 9.6 m inland. A hole a metre or two deep in ground the raster is confident
 * about is a corner artefact, not a coastline.
 */
const SURVEYED_HOLE_M = 2.5;
const RASTER_CONFIDENT_M = 8;
/** How wet a node cleared for a deck reads. Any negative would do; this keeps the cut's interpolation sane. */
const DECK_CLEARED_SCALAR_M = 2;
/** Buildings below this are noise — bin stores, lift housings, map clutter. */
const MIN_BUILDING_HEIGHT_M = 2;

/** The band a terrain surface vertex is allowed to live in: clear of the sea plane, below the cliff cap. */
function clampToSurface(y: number): number {
  return Math.max(WATER_CLEARANCE_M, Math.min(y, SHORE_EDGE_MAX_M));
}

/**
 * The hue a merged model's colour is pulled toward: the palette's building
 * colour, divided by its own luminance so only its hue survives.
 */
const MODEL_TONE: [number, number, number] = (() => {
  const hex = DIORAMA_COLORS.building.replace("#", "");
  const rgb = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [rgb[0] / luminance, rgb[1] / luminance, rgb[2] / luminance];
})();

type MeshKind = BakedMeshKind;

/** The light set is what the bake writes; the dark one is the runtime's. */
const MESH_COLOR = BAKED_MESH_COLORS.light;

// ─── terrain ───────────────────────────────────────────────────────────────

interface TerrainResult {
  meshes: Record<Belt, Mesh>;
  /** The block's sides and its floor, cut from the far belt's own rim. */
  plinth: Mesh;
  cellsByBelt: Record<Belt, number>;
  /** Cells of water that never reached the sea and were filled as holes. */
  holesFilled: number;
  /** How much the fine belts gave up to meet the coarse ones — see `surfaceHeightAt`. */
  conform: { nodes: number; worstM: number; meanM: number; over1M: number; over2M: number };
}

/** The finest lattice any belt samples, so every belt sees the same fill. */
const POND_CELL_M = BELT_CELL_M.core;
/**
 * Largest patch of water enclosed by land that is taken for a hole rather than
 * a basin. Port Hercule's is about 60 m2; the smallest thing here that is
 * really water is the marina, and that reaches the sea.
 */
const MIN_POND_M2 = 400;
/** How much land a filled hole reports. Enough that no cell edge crosses zero inside it. */
const POND_FILLED_SCALAR_M = 2;

/**
 * Water that never reaches the open sea, and is small.
 *
 * The signed distance is to the *nearest* segment, so where a pier meets its
 * quay that segment's wet side sweeps back over the ground behind it and opens
 * a hole. Overruling it by asking the raster works only in a band tight enough
 * to miss the deepest part of the hole, and a looser band hands the shoreline
 * back to the grid — the quay came back as a sawtooth twice that way.
 *
 * Enclosure settles it without a threshold on depth at all. A patch of water
 * ringed by land is either a basin or an artefact, and the real basins all
 * reach the sea, so a small one that does not is an artefact. The shoreline
 * itself is connected to the sea by construction and cannot be touched by this.
 */
function findEnclosedWater(
  scalarAt: (x: number, z: number) => number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): { cells: number; has(x: number, z: number): boolean } {
  const cols = Math.floor((maxX - minX) / POND_CELL_M) + 1;
  const rows = Math.floor((maxZ - minZ) / POND_CELL_M) + 1;
  const wet = new Uint8Array(rows * cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (scalarAt(minX + col * POND_CELL_M, minZ + row * POND_CELL_M) <= 0) {
        wet[row * cols + col] = 1;
      }
    }
  }

  const filled = new Uint8Array(rows * cols);
  const seen = new Uint8Array(rows * cols);
  const maxCells = Math.round(MIN_POND_M2 / (POND_CELL_M * POND_CELL_M));
  const component: number[] = [];
  const queue: number[] = [];
  let cells = 0;

  for (let start = 0; start < wet.length; start++) {
    if (seen[start] || !wet[start]) continue;
    component.length = 0;
    queue.length = 0;
    queue.push(start);
    seen[start] = 1;
    let reachesTheSea = false;

    while (queue.length) {
      const index = queue.pop() as number;
      component.push(index);
      const row = Math.floor(index / cols);
      const col = index - row * cols;
      if (row === 0 || col === 0 || row === rows - 1 || col === cols - 1) reachesTheSea = true;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const next = nr * cols + nc;
        if (seen[next] || !wet[next]) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }

    if (reachesTheSea || component.length > maxCells) continue;
    for (const index of component) filled[index] = 1;
    cells += component.length;
  }

  return {
    cells,
    has(x: number, z: number): boolean {
      const col = Math.round((x - minX) / POND_CELL_M);
      const row = Math.round((z - minZ) / POND_CELL_M);
      if (row < 0 || col < 0 || row >= rows || col >= cols) return false;
      return filled[row * cols + col] === 1;
    },
  };
}

export interface BeltBlocks {
  blockM: number;
  blockRows: number;
  blockCols: number;
  blockBelt: Uint8Array;
  beltOfCell(row: number, col: number, cell: number): Belt;
  /**
   * Is this position a node the fine belt gave up to the coarse one?
   *
   * True on a block boundary the two sides disagree about, and only between the
   * coarse lattice's own nodes — those it shares outright. The audit asks the
   * same question the bake did, from the same map, rather than keeping a second
   * copy of the rule.
   */
  conformsAt(x: number, z: number): boolean;
}

/**
 * Which belt owns which patch of ground.
 *
 * Decided once, on the coarsest grid, so the finer grids divide into it exactly.
 * Deciding per cell instead leaves a strip that no belt claims — the 8 m cell is
 * outside its belt by its own centre while the 16 m cell covering it is inside
 * by its own, and the gap shows as a hairline of sea along the boundary.
 *
 * Blocks the water's edge runs through are grown by one block in every
 * direction and the whole band is drawn at the finest cell. Both halves matter.
 * The cut is only as fine as the grid it is sampled on, so a 16 m cell leaves
 * the coast in 16 m steps however smooth the line behind it. And the growing is
 * what closes the coast: two belts cut the same waterline from their own nodes,
 * so their cut polylines meet the shared block edge at different points and
 * leave a sliver of open water between them, which the grid skirt does not
 * close because it only fires on a dry rim. Larvotto's breakwaters came out as
 * torn crescents for exactly this reason. Grown by a block, the boundary lies
 * either wholly at sea, where neither side draws anything, or wholly on dry
 * ground, where the skirt hides it as it hides every other boundary.
 */
export function buildBeltBlocks(
  field: HeightField,
  plane: ScenePlane,
  corridor: Corridor,
): BeltBlocks {
  const minX = plane.x(field.bbox.minLon);
  const maxX = plane.x(field.bbox.maxLon);
  const minZ = plane.z(field.bbox.maxLat);
  const maxZ = plane.z(field.bbox.minLat);

  const blockM = BELT_CELL_M.far;
  const blockCols = Math.ceil((maxX - minX) / blockM);
  const blockRows = Math.ceil((maxZ - minZ) / blockM);

  const straddles = new Uint8Array(blockRows * blockCols);
  for (let row = 0; row < blockRows; row++) {
    for (let col = 0; col < blockCols; col++) {
      const x = minX + (col + 0.5) * blockM;
      const z = minZ + (row + 0.5) * blockM;
      if (straddlesWater(field, plane, x, z, blockM)) straddles[row * blockCols + col] = 1;
    }
  }
  const coastal = new Uint8Array(blockRows * blockCols);
  for (let row = 0; row < blockRows; row++) {
    for (let col = 0; col < blockCols; col++) {
      if (!straddles[row * blockCols + col]) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || c < 0 || r >= blockRows || c >= blockCols) continue;
          coastal[r * blockCols + c] = 1;
        }
      }
    }
  }

  const blockBelt = new Uint8Array(blockRows * blockCols);
  for (let row = 0; row < blockRows; row++) {
    for (let col = 0; col < blockCols; col++) {
      const x = minX + (col + 0.5) * blockM;
      const z = minZ + (row + 0.5) * blockM;
      let belt = beltAtDistance(corridor.distance(x, z));
      if (coastal[row * blockCols + col]) belt = "core";
      blockBelt[row * blockCols + col] = BELT_ORDER.indexOf(belt);
    }
  }

  const beltOfCell = (row: number, col: number, cell: number): Belt => {
    const blockRow = Math.min(blockRows - 1, Math.floor((row * cell) / blockM));
    const blockCol = Math.min(blockCols - 1, Math.floor((col * cell) / blockM));
    return BELT_ORDER[blockBelt[blockRow * blockCols + blockCol]];
  };

  const cellOfBlock = (blockRow: number, blockCol: number): number => {
    if (blockRow < 0 || blockCol < 0 || blockRow >= blockRows || blockCol >= blockCols) return 0;
    return BELT_CELL_M[BELT_ORDER[blockBelt[blockRow * blockCols + blockCol]]];
  };

  const conformsAt = (x: number, z: number): boolean => {
    const offsetX = x - minX;
    const offsetZ = z - minZ;
    // Quantisation moves a shipped vertex by a couple of centimetres, so a
    // boundary is recognised by nearness to the lattice, not by equality.
    const onLine = (offset: number): boolean =>
      Math.abs(offset / blockM - Math.round(offset / blockM)) * blockM < 0.15;
    const onVertical = onLine(offsetX);
    const onHorizontal = onLine(offsetZ);
    if (!onVertical && !onHorizontal) return false; // interior

    let finest = Infinity;
    let coarsest = 0;
    for (const dx of [-0.5, 0.5]) {
      for (const dz of [-0.5, 0.5]) {
        const cell = cellOfBlock(
          Math.floor((offsetZ + dz) / blockM),
          Math.floor((offsetX + dx) / blockM),
        );
        if (cell === 0) continue;
        if (cell > coarsest) coarsest = cell;
        if (cell < finest) finest = cell;
      }
    }
    // Every node along the boundary takes the coarse belt's chord, the nodes of
    // the coarse lattice included: those sit at t = 0 or t = 1 and so take one
    // of its endpoints outright, which is still the coarse belt's height and
    // not this belt's own.
    return coarsest > finest;
  };

  return { blockM, blockRows, blockCols, blockBelt, beltOfCell, conformsAt };
}

/** Does this block have both land and water in it? */
function straddlesWater(
  field: HeightField,
  plane: ScenePlane,
  centreX: number,
  centreZ: number,
  sizeM: number,
): boolean {
  let land = false;
  let water = false;
  const half = sizeM / 2;
  for (const dx of [-half, 0, half]) {
    for (const dz of [-half, 0, half]) {
      const value = field.heightAt(plane.lon(centreX + dx), plane.lat(centreZ + dz));
      if (Number.isNaN(value)) water = true;
      else land = true;
      if (land && water) return true;
    }
  }
  return false;
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
/**
 * How far two terrain faces may disagree before the corner they share stops
 * being one surface. Below it the hillside shades smoothly; above it — a cliff
 * top, a quay, a terrace riser — the edge stays an edge.
 *
 * Fifteen degrees, looked at rather than reasoned about: 25° left Le Rocher
 * reading as drapery, 15° gives it faces, and 10° is not visibly different from
 * 15° while costing another 0.07 MB on the core belt. The hillside is still
 * smooth at 15° — that was the other half of the check.
 */
const TERRAIN_CREASE_DEG = 15;

function bakeTerrain(
  field: HeightField,
  ground: Ground,
  plane: ScenePlane,
  corridor: Corridor,
  coast: Coastline,
  piers: PierResult,
  hollow: PortalHollow,
): TerrainResult {
  // Where no surveyed line reaches — a third of a kilometre of Larvotto, among
  // others — the edge still has to come from somewhere smoother than a boolean
  // flag, or the cut falls back on the grid it exists to escape.
  const rasterShore = buildShoreDistance(field);

  /**
   * How much land there is at a point: metres from the surveyed shoreline where
   * there is one, and otherwise the smoothed raster distance. The terrain is
   * where this is positive, so the coast lands wherever it crosses zero rather
   * than on the nearest grid line.
   */
  const rawScalarAt = (x: number, z: number): number => {
    // The raster's own copy of a deck is not land: the LiDAR saw the pontoon and
    // the boats tied to it, a few metres off where the ring is mapped, so the
    // deck and a torn strip of terrain were drawn side by side. The deck is the
    // better answer and it is the only one kept.
    if (piers.clearsTerrain(x, z)) return -DECK_CLEARED_SCALAR_M;
    const surveyed = coast.signedDistance(x, z);
    const raster = rasterShore.at(plane.lon(x), plane.lat(z));
    const value = Number.isNaN(surveyed) ? raster : surveyed;
    if (value < 0 && value > -SURVEYED_HOLE_M && raster > RASTER_CONFIDENT_M) {
      return raster;
    }
    return value;
  };
  let conformed = 0;
  let worstConform = 0;
  let conformSum = 0;
  let conformOver1 = 0;
  let conformOver2 = 0;
  let holesFilled = 0;
  const meshes = {} as Record<Belt, Mesh>;
  const plinth = createMesh();
  const cellsByBelt = { core: 0, city: 0, far: 0 } as Record<Belt, number>;

  const minX = plane.x(field.bbox.minLon);
  const maxX = plane.x(field.bbox.maxLon);
  const minZ = plane.z(field.bbox.maxLat); // north edge is the smaller Z
  const maxZ = plane.z(field.bbox.minLat);

  const ponds = findEnclosedWater(rawScalarAt, minX, maxX, minZ, maxZ);
  holesFilled = ponds.cells;

  const blocks = buildBeltBlocks(field, plane, corridor);
  const { blockM, blockRows, blockCols, blockBelt, beltOfCell } = blocks;

  /**
   * A height for a node the terrain is going to stand on, on any belt's grid.
   *
   * The raster and the surveyed line disagree by a few metres in places, so a
   * node the line puts on land can be one the raster calls sea and has no
   * height for. Rather than drop it to the datum — which ramps the quay into
   * the water like a beach — it takes the nearest dry reading, widening until
   * it finds one.
   *
   * It takes the belt rather than closing over one because a seam node has to
   * ask what the *coarser* belt thinks the ground is: each belt averages the
   * field over its own cell (`ground.ts`), so the same place has a different
   * height on each, and a chord drawn from the wrong belt's numbers is a chord
   * the other side never drew.
   */
  const solidHeightOn = (belt: Belt, row: number, col: number): number => {
    const own = ground.nodeAt(belt, row, col);
    if (!Number.isNaN(own)) return own;
    for (let radius = 1; radius <= 3; radius++) {
      let sum = 0;
      let count = 0;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
          const value = ground.nodeAt(belt, row + dr, col + dc);
          if (Number.isNaN(value)) continue;
          sum += value;
          count++;
        }
      }
      if (count > 0) return sum / count;
    }
    return 0;
  };

  const surfaceHeightOn = (belt: Belt, row: number, col: number): number =>
    Math.max(solidHeightOn(belt, row, col), WATER_CLEARANCE_M);

  /** The coarsest cell of the blocks meeting at a node's own position. */
  const coarsestAt = (offsetX: number, offsetZ: number): number => {
    let coarsest = 0;
    for (const dx of [-0.5, 0.5]) {
      for (const dz of [-0.5, 0.5]) {
        const blockCol = Math.floor((offsetX + dx) / blockM);
        const blockRow = Math.floor((offsetZ + dz) / blockM);
        if (blockRow < 0 || blockCol < 0 || blockRow >= blockRows || blockCol >= blockCols) {
          continue;
        }
        const other = BELT_CELL_M[BELT_ORDER[blockBelt[blockRow * blockCols + blockCol]]];
        if (other > coarsest) coarsest = other;
      }
    }
    return coarsest;
  };

  /**
   * The height a belt actually draws at one of its own nodes.
   *
   * Away from a boundary that is the belt's own reading of the surface. On a
   * boundary with a coarser belt it is the coarse belt's — its node outright at
   * a block corner, the chord between two of its nodes anywhere else along the
   * line. Read the coarse belt's *drawn* height rather than its raw one, so a
   * node where three belts meet resolves through the coarsest of them: a chord
   * to a point the other side never draws is how the two part company.
   *
   * A belt boundary is a T-junction: the coarse side draws one straight chord
   * across 8 or 16 m while the fine side follows the ground every 4 m. On
   * Monaco the two disagree by metres, and the skirt that stops it being a hole
   * leaves it a ledge instead — a step through the middle of flat ground. So on
   * a shared boundary the fine side gives up its own readings and takes the
   * coarse one's. Every cell size divides every coarser one, so the coarse node
   * a chord runs between is always a node of the fine grid too.
   */
  const drawnHeightOn = (belt: Belt, row: number, col: number): number => {
    const cell = BELT_CELL_M[belt];
    const offsetX = col * cell;
    const offsetZ = row * cell;
    const coarsest = coarsestAt(offsetX, offsetZ);
    const own = surfaceHeightOn(belt, row, col);
    if (coarsest <= cell) return own;
    const onVertical = offsetX % blockM === 0;
    const onHorizontal = offsetZ % blockM === 0;
    if (!onVertical && !onHorizontal) return own;
    const coarseBelt = BELT_ORDER.find((other) => BELT_CELL_M[other] === coarsest);
    if (!coarseBelt) return own;

    if (onVertical && onHorizontal) {
      return drawnHeightOn(coarseBelt, offsetZ / coarsest, offsetX / coarsest);
    }

    const step = coarsest / cell;
    const index = onVertical ? row : col;
    const low = Math.floor(index / step) * step;
    const high = low + step;
    const t = (index - low) / step;
    const across = (onVertical ? offsetX : offsetZ) / coarsest;
    const lowIndex = (low * cell) / coarsest;
    const highIndex = (high * cell) / coarsest;
    const a = onVertical
      ? drawnHeightOn(coarseBelt, lowIndex, across)
      : drawnHeightOn(coarseBelt, across, lowIndex);
    const b = onVertical
      ? drawnHeightOn(coarseBelt, highIndex, across)
      : drawnHeightOn(coarseBelt, across, highIndex);
    return a + (b - a) * t;
  };

  for (const belt of BELT_ORDER) {
    const cell = BELT_CELL_M[belt];
    const cols = Math.floor((maxX - minX) / cell);
    const rows = Math.floor((maxZ - minZ) / cell);
    const grid = new GridMesh();

    const nodes = (rows + 2) * (cols + 2);

    // This belt's own view of the one surface: it averages the field over its
    // own cell rather than sampling it — see `ground.ts`.
    const heightAt = (row: number, col: number): number => ground.nodeAt(belt, row, col);

    const solidHeightAt = (row: number, col: number): number => solidHeightOn(belt, row, col);

    const ownHeightAt = (row: number, col: number): number => surfaceHeightOn(belt, row, col);

    /**
     * The height this belt draws at one of its nodes, and the record of what
     * the boundary cost. `drawnHeightOn` holds the rule; this counts.
     */
    const surfaceHeightAt = (row: number, col: number): number => {
      const drawn = drawnHeightOn(belt, row, col);
      const own = ownHeightAt(row, col);
      const moved = Math.abs(drawn - own);
      if (moved < 1e-6) return drawn;
      conformed++;
      if (moved > worstConform) worstConform = moved;
      conformSum += moved;
      if (moved > 1) conformOver1++;
      if (moved > 2) conformOver2++;
      return drawn;
    };

    const vertexAt = (row: number, col: number): number =>
      grid.vertex(
        row * (cols + 2) + col,
        minX + col * cell,
        surfaceHeightAt(row, col),
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
      const value = ponds.has(x, z) ? POND_FILLED_SCALAR_M : rawScalarAt(x, z);
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
      return grid.vertex(key, x, clampToSurface(y), z);
    };

    // Land–water crossings, as vertex pairs, so the coast can drop a skirt once
    // the grid is finished and its positions are settled.
    const shoreEdges: [number, number][] = [];
    // The cells a portal took out, and the ones that were built, so the pit can
    // be walled along its own rim rather than along a guessed rectangle.
    const voidCells: number[] = [];
    const built = new Set<number>();
    // Counter-clockwise seen from above, so the normal points at the sky.
    const walk = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (beltOfCell(row, col, cell) !== belt) continue;
        if (hollow.at(minX + (col + 0.5) * cell, minZ + (row + 0.5) * cell)) {
          voidCells.push(row * (cols + 2) + col);
          continue;
        }
        built.add(row * (cols + 2) + col);

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

    const mesh = grid.finish(TERRAIN_CREASE_DEG);
    addVoidWalls(mesh, voidCells, built, hollow, surfaceHeightAt, minX, minZ, cell, cols);
    addTerrainSkirts(mesh, scalarAt, surfaceHeightAt, beltOfCell, belt, minX, minZ, cell, rows, cols);
    addShoreSkirts(mesh, shoreEdges);
    // The bbox rim is the far belt's: the finer belts sit inside the track's
    // radius and never reach it.
    if (belt === "far") {
      addPlinth(plinth, scalarAt, surfaceHeightAt, minX, minZ, cell, rows, cols);
    }
    meshes[belt] = mesh;
  }

  return {
    meshes,
    plinth,
    cellsByBelt,
    holesFilled,
    conform: {
      nodes: conformed,
      worstM: worstConform,
      meanM: conformSum / Math.max(1, conformed),
      over1M: conformOver1,
      over2M: conformOver2,
    },
  };
}

/**
 * The pit a portal takes out of the hillside, walled along its own rim.
 *
 * The terrain drops the cells whose centre falls in a mouth's void, and what
 * that leaves is a hole whose edge is the grid's, not the void's: a cell is in
 * or out by its centre, so the rim runs up to half a cell past the nominal
 * width and follows the belt's own lattice. Closing it with a rectangle sized
 * from the void's numbers is what left daylight either side of the arch — the
 * rim was two metres wider than the wall built to cover it.
 *
 * So the wall is built from the rim itself: every edge where a dropped cell
 * meets a built one gets a vertical quad, from the ground the built side draws
 * down to the cutting's floor. Nothing to keep in step with, and it cannot be
 * short.
 */
function addVoidWalls(
  mesh: Mesh,
  voidCells: number[],
  built: Set<number>,
  hollow: PortalHollow,
  surfaceHeightAt: (row: number, col: number) => number,
  minX: number,
  minZ: number,
  cell: number,
  cols: number,
): void {
  const stride = cols + 2;
  for (const key of voidCells) {
    const row = Math.floor(key / stride);
    const col = key - row * stride;
    const centreX = minX + (col + 0.5) * cell;
    const centreZ = minZ + (row + 0.5) * cell;
    const floor = hollow.floorAt(centreX, centreZ);
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      if (!built.has((row + dr) * stride + col + dc)) continue;
      // The two grid nodes the dropped cell and its neighbour share.
      // A rim that crosses the bore is a wall across the road: the sleeve
      // covers that stretch, and what shows through the arch has to be the
      // tunnel rather than the far side of the excavation.
      const edgeX = minX + (col + 0.5 + dc * 0.5) * cell;
      const edgeZ = minZ + (row + 0.5 + dr * 0.5) * cell;
      if (hollow.boreAt(edgeX, edgeZ)) continue;
      const nodes = dc !== 0
        ? [[row, col + (dc > 0 ? 1 : 0)], [row + 1, col + (dc > 0 ? 1 : 0)]]
        : [[row + (dr > 0 ? 1 : 0), col], [row + (dr > 0 ? 1 : 0), col + 1]];
      const top = nodes.map(([r, c]) => ({
        x: minX + c * cell,
        y: surfaceHeightAt(r, c),
        z: minZ + r * cell,
      }));
      if (top.some((point) => Number.isNaN(point.y))) continue;
      const base = Math.min(floor, top[0].y, top[1].y) - 0.5;
      // Wound so the face looks into the pit, which is the only side of it a
      // camera can be on.
      const intoVoid =
        (centreX - (top[0].x + top[1].x) / 2) * (top[1].z - top[0].z) -
        (centreZ - (top[0].z + top[1].z) / 2) * (top[1].x - top[0].x);
      const [a, b] = intoVoid > 0 ? [top[0], top[1]] : [top[1], top[0]];
      addFlatQuad(
        mesh,
        a.x, a.y, a.z,
        b.x, b.y, b.z,
        b.x, base, b.z,
        a.x, base, a.z,
      );
    }
  }
}

/**
 * The block the landscape is cut from: a wall around the bbox down to one floor,
 * and the floor itself.
 *
 * The top of the wall is the far belt's own rim vertex wherever the rim is land,
 * so the two meet exactly rather than nearly; where the rim is sea it is the
 * datum, which is where the water quad lies. Land that reads below the datum —
 * a metre of beach — takes the datum too, so the wall is never under the water
 * it is supposed to hold in.
 */
function addPlinth(
  mesh: Mesh,
  scalarAt: (row: number, col: number) => number,
  surfaceHeightAt: (row: number, col: number) => number,
  minX: number,
  minZ: number,
  cell: number,
  rows: number,
  cols: number,
): void {
  const top = (row: number, col: number): number =>
    scalarAt(row, col) > 0 ? Math.max(surfaceHeightAt(row, col), 0) : 0;
  const xAt = (col: number): number => minX + col * cell;
  const zAt = (row: number): number => minZ + row * cell;

  // Each wall is wound so its face looks away from the model.
  for (let col = 0; col < cols; col++) {
    const x0 = xAt(col);
    const x1 = xAt(col + 1);
    const north = zAt(0);
    const south = zAt(rows);
    const n0 = top(0, col);
    const n1 = top(0, col + 1);
    addFlatQuad(mesh, x0, n0, north, x1, n1, north, x1, PLINTH_FLOOR_M, north, x0, PLINTH_FLOOR_M, north);
    const s0 = top(rows, col);
    const s1 = top(rows, col + 1);
    addFlatQuad(mesh, x1, s1, south, x0, s0, south, x0, PLINTH_FLOOR_M, south, x1, PLINTH_FLOOR_M, south);
  }
  for (let row = 0; row < rows; row++) {
    const z0 = zAt(row);
    const z1 = zAt(row + 1);
    const west = xAt(0);
    const east = xAt(cols);
    const w0 = top(row, 0);
    const w1 = top(row + 1, 0);
    addFlatQuad(mesh, west, w1, z1, west, w0, z0, west, PLINTH_FLOOR_M, z0, west, PLINTH_FLOOR_M, z1);
    const e0 = top(row, cols);
    const e1 = top(row + 1, cols);
    addFlatQuad(mesh, east, e0, z0, east, e1, z1, east, PLINTH_FLOOR_M, z1, east, PLINTH_FLOOR_M, z0);
  }

  // The floor is two triangles nobody sees — the camera stops at the horizon —
  // but a block with an open bottom is not a block.
  addFlatQuad(
    mesh,
    xAt(0), PLINTH_FLOOR_M, zAt(0),
    xAt(cols), PLINTH_FLOOR_M, zAt(0),
    xAt(cols), PLINTH_FLOOR_M, zAt(rows),
    xAt(0), PLINTH_FLOOR_M, zAt(rows),
  );
}

/**
 * A vertical drop on every edge whose neighbour cell was not built — the belt
 * boundary and the edge of the bbox. The water's edge is not one of these: it
 * is cut inside the cell and gets its skirt from `addShoreSkirts`.
 */
function addTerrainSkirts(
  mesh: Mesh,
  scalarAt: (row: number, col: number) => number,
  /**
   * The height the *surface* was built at, not the raster's own reading.
   *
   * The two differ wherever the raster has no value for a node the cut calls
   * land, and there the skirt used to be skipped for want of a height while the
   * surface above it was drawn anyway — an open crack down the belt boundary,
   * on half of every boundary in Monaco. A skirt has to answer the same
   * question the emitter did, from the same source.
   */
  surfaceHeightAt: (row: number, col: number) => number,
  beltOfCell: (row: number, col: number, cell: number) => Belt,
  belt: Belt,
  minX: number,
  minZ: number,
  cell: number,
  rows: number,
  cols: number,
): void {
  // Off the grid altogether is the outside of the model. For the far belt that
  // edge is the plinth's, and a hem there would hang inside the block's own
  // wall; the finer belts end on their own cell size — up to 12 m further out
  // than the far belt does — so out there a hem is still all they have.
  const rimIsPlinth = belt === "far";
  const offGrid = (row: number, col: number): boolean =>
    row < 0 || col < 0 || row >= rows || col >= cols;
  const outside = (row: number, col: number): boolean => rimIsPlinth && offGrid(row, col);

  // Built by the same test the emitter used, or a cell would drop a skirt
  // against a neighbour that is standing right there.
  const built = (row: number, col: number): boolean => {
    if (offGrid(row, col)) return false;
    if (beltOfCell(row, col, cell) !== belt) return false;
    return (
      scalarAt(row, col) > 0 ||
      scalarAt(row, col + 1) > 0 ||
      scalarAt(row + 1, col) > 0 ||
      scalarAt(row + 1, col + 1) > 0
    );
  };

  // Only a rim of dry ground gets a grid-aligned skirt: the water's edge is cut
  // inside the cell and gets its own from `addShoreSkirts`. Dry is decided by
  // the same scalar the emitter used and by nothing else.
  const dry = (rowA: number, colA: number, rowB: number, colB: number): boolean =>
    scalarAt(rowA, colA) > 0 && scalarAt(rowB, colB) > 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!built(row, col)) continue;
      const x0 = minX + col * cell;
      const x1 = x0 + cell;
      const z0 = minZ + row * cell;
      const z1 = z0 + cell;
      // The tops are the surface, or the skirt hangs from somewhere the ground
      // is not.
      const h00 = surfaceHeightAt(row, col);
      const h10 = surfaceHeightAt(row, col + 1);
      const h01 = surfaceHeightAt(row + 1, col);
      const h11 = surfaceHeightAt(row + 1, col + 1);

      if (!built(row - 1, col) && !outside(row - 1, col) && dry(row, col, row, col + 1)) {
        addFlatQuad(mesh, x0, h00, z0, x1, h10, z0, x1, h10 - SKIRT_M, z0, x0, h00 - SKIRT_M, z0);
      }
      if (!built(row + 1, col) && !outside(row + 1, col) && dry(row + 1, col, row + 1, col + 1)) {
        addFlatQuad(mesh, x1, h11, z1, x0, h01, z1, x0, h01 - SKIRT_M, z1, x1, h11 - SKIRT_M, z1);
      }
      if (!built(row, col - 1) && !outside(row, col - 1) && dry(row, col, row + 1, col)) {
        addFlatQuad(mesh, x0, h01, z1, x0, h00, z0, x0, h00 - SKIRT_M, z0, x0, h01 - SKIRT_M, z1);
      }
      if (!built(row, col + 1) && !outside(row, col + 1) && dry(row, col + 1, row + 1, col + 1)) {
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

/**
 * The pontoon decks, extruded from their mapped rings.
 *
 * The walls go to the same foot the coast's skirt uses, so a deck meets the sea
 * plane in a wall rather than in a torn edge, and the little the raster kept of
 * the pontoon stays buried under the deck it belongs to.
 */
function bakePierDecks(piers: PierResult): Mesh {
  const mesh = createMesh();
  for (const deck of piers.decks) {
    const foot = Math.min(SHORE_FOOT_M, deck.deckY - 1);
    extrude(mesh, deck.ring, deck.ring.map(() => foot), deck.deckY);
  }
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
/**
 * A footprint worked out to the point where it could be built, but not built.
 *
 * The kit pass (P4.5) has to decide which footprints become models before the
 * props are merged, and it needs the ring after it was pushed off the track,
 * the ground it stands on and the height that was measured — all of which is
 * the first half of what the extrusion does. So the two halves are separate:
 * this settles where the building is, and `bakeBuildings` draws whatever the
 * kit did not take.
 */
interface PreparedBuilding {
  id: string;
  ring: { x: number; z: number }[];
  /**
   * The ring the walls are built from: the footprint, with a vertex added
   * wherever the ground under an edge leaves the straight line between its
   * corners. A footprint that bridges a gully has corners on the lip and
   * nothing under its middle, which is the shape of every "building floating
   * over a ravine" in Monaco.
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

/**
 * How far the ground under an edge may stray from the straight line between its
 * corners before the wall gains a vertex there. Half a metre is under the eye's
 * threshold for a gap at street distance and well over the quantisation step.
 */
const WALL_FOLLOW_TOLERANCE_M = 0.5;
/** No segment is worth splitting below this: nothing shows in a 1 m gap. */
const WALL_FOLLOW_MIN_M = 1;

/**
 * A footprint ring, resampled so its walls follow the ground under them.
 *
 * Corners alone are enough on a plane and on an even slope. They are not enough
 * where the ground drops between two of them: the wall spans the drop as one
 * quad and the building reads as floating over it, which on Monaco's hillside
 * is 271 of 3,742 pieces. Only the edges that need it gain vertices, so a block
 * on flat ground still costs four.
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

function prepareBuildings(
  buildings: BuildingsFile,
  groundAt: (x: number, z: number) => number,
  plane: ScenePlane,
  corridor: Corridor,
  hollow: PortalHollow,
  road: RoadIndex,
  measured: Map<string, { measured: number }>,
  result: BuildingResult,
): PreparedBuilding[] {
  const prepared: PreparedBuilding[] = [];

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
    // and each stands on its own ground.
    for (let piece = 0; piece < pieces.length; piece++) {
      const shape = pieces[piece];

      // Fontvieille stands on reclaimed land and Monaco's quays are built to the
      // water, so a footprint with a corner over a water cell is normal. Only a
      // footprint with no ground under it at all is not a building we can place.
      const grounds: number[] = [];
      for (const point of shape) {
        const h = groundAt(point.x, point.z);
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
      // is neither buried on its uphill side nor left on stilts downhill. There
      // is no floor under how far it may dig: the clamp that used to be here
      // existed because the wall read one surface and the terrain drew another,
      // and a wall that stopped at the clamp stopped in mid-air. It now reads the
      // surface that is drawn, so where it reaches is where the ground is.
      // The corners were pushed clear of the track; a vertex added between two of
      // them lands on the chord, and a chord across a corner can cut inside the
      // corridor the push exists to keep clear. Where the denser ring cannot be
      // pushed clear, the corner ring stands: a wall that follows the ground into
      // the road is worse than one that spans a dip.
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
        heightM: height,
        centreX,
        centreZ,
        belt: beltAtDistance(corridor.distance(centreX, centreZ)),
      });
    }
  }

  return prepared;
}

function bakeBuildings(
  prepared: PreparedBuilding[],
  tags: Map<string, RoofTags>,
  result: BuildingResult,
  /** Footprints a kit model has already taken; their roofs come with it. */
  taken: Set<string>,
): void {
  const meshes = result.meshes;
  for (const building of prepared) {
    if (taken.has(building.id)) continue;
    const { ring, wallRing, footAt, base, heightM, belt } = building;
    const top = base + heightM;
    const plan = planRoof(ring, tags.get(building.id.split("#")[0]) ?? {}, heightM);
    result.roofs[plan.kind]++;

    if (plan.kind === "flat") {
      // The rim is what makes a flat roof read as a roof rather than a lid, so
      // the walls run past the roof plane and turn back down inside it. Only
      // where it can be seen: the far belt is silhouettes.
      const parapet = belt === "far" ? 0 : PARAPET_M;
      extrude(meshes[belt], wallRing, footAt, top - plan.heightM, parapet);
    } else {
      const eaveY = top - plan.heightM;
      extrude(meshes[belt], wallRing, footAt, eaveY, 0);
      buildRoof(meshes[belt], plan, eaveY);
    }
    result.built++;
  }
}

/** Below this the plinth is a lid on the ground rather than a terrace. */
const KIT_PLINTH_MIN_M = 0.2;
/**
 * How far its walls go under the ground they read.
 *
 * A vertex reads the ground at its own point and the terrain between two of
 * them can sit lower; without the dig the audit reads the difference as a house
 * on stilts.
 */
const KIT_PLINTH_DIG_M = 0.3;

/**
 * The terrace a modelled house stands on.
 *
 * A kit house stands on the floor an extrusion would have used — the middle of
 * the ground under its plot — and this is what holds it up on the downhill
 * side: the fitted rectangle walled from the ground to that floor. Standing the
 * model on the plot's lowest corner instead buried it, half its height and more
 * on 12 of the 75 plots. The rectangle rather than the surveyed ring, because
 * the rectangle is what the model covers.
 */
function bakeKitPlinths(
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

function emptyBuildingResult(): BuildingResult {
  return {
    meshes: { core: createMesh(), city: createMesh(), far: createMesh() } as Record<Belt, Mesh>,
    roofs: { flat: 0, gabled: 0, hipped: 0, pyramidal: 0, skillion: 0 },
    built: 0,
    droppedOnTrack: 0,
    droppedOverWater: 0,
    droppedTooLow: 0,
    pushedOffTrack: 0,
  };
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
  // "Mostly inside" is judged on the footprint as it was mapped. Judging it
  // after the densification below would drop a long block for the crossing it
  // is about to be notched around.
  const insideAsMapped = ring.filter(
    (point) => corridor.measure(point.x, point.z).distanceM < TRACK_CLEARANCE_M,
  ).length;
  if (insideAsMapped >= ring.length * 0.6) return null;

  // A wall can cross the corridor between two vertices that are both well
  // outside it — three of Monaco's footprints do, and one of them is the block
  // the tunnel's inland mouth sits under, so the road ran into its side with
  // nowhere to go. Pushing vertices cannot help a footprint with no vertex to
  // push, so an edge that crosses is given some: sampled every metre while it
  // is inside, they are pushed out like any other and the building closes
  // around the road rather than over it.
  const dense = densifyAcrossCorridor(ring, corridor);
  let moved = false;
  // Which side of the road the wall was last seen on. A vertex landing dead on
  // the centreline has no side of its own — the old code left it there, and
  // after densification that put wall vertices 8 m inside the corridor, which
  // the audit reads as a wall on the track. It takes the side its neighbour had.
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
 * The road, taken out of a footprint that stands over it.
 *
 * `pushOffTrack` moves vertices and the points where an edge crosses; neither
 * exists when a small block sits astride the road with its corners well clear —
 * way/1470365896 by the harbour is one, and the lap ran straight through it.
 * The band around the local centreline is subtracted instead, which leaves the
 * building either side of the road and a gap between: the opening a road makes
 * through a building.
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

function buildRoadIndex(points: { x: number; z: number }[]): RoadIndex {
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
 * The cutting, taken out of a footprint that stands over it.
 *
 * `pushOffTrack` slides vertices out of the corridor, which cannot help here:
 * Monaco's inland mouth is under a block whose footprint *contains* the whole
 * cutting, so there is neither a vertex nor an edge inside it to move. The
 * rectangle is subtracted instead, as three half-plane clips that do not
 * overlap — everything left of it, everything right of it, and whatever lies
 * beyond its far end between the two. The front is open because that is where
 * the road comes in.
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
/** Least width of the headwall around the opening — what makes it read as a
 *  portal — and how far it may grow looking for the ground to meet. */
const PORTAL_SURROUND_M = 2.5;
/**
 * Half width of the void the terrain leaves at a mouth, and of the face that
 * closes it.
 *
 * The face has to be the larger of the two, and by a clear margin: the void is
 * decided per cell on the cell's own centre, so the hole it actually leaves
 * runs half a cell — two metres in the core belt — past the nominal edge. A
 * face cut to the nominal size leaves daylight showing around it.
 */
const PORTAL_VOID_HALF_M = PORTAL_HALF_WIDTH_M;
const PORTAL_FACE_HALF_M = PORTAL_HALF_WIDTH_M + 5;
/** Same margin fore and aft: the void starts inside the front face and ends
 *  before the back one. */
const PORTAL_VOID_PAD_M = 3;
/**
 * How far the cutting runs out in front of a mouth.
 *
 * Without one the ground outside the portal stands at hill level — measured at
 * the seaward mouth, about two metres above the road — so it buried the arch's
 * lower half and the opening read as a crescent with the road nowhere in sight.
 * A tunnel has an approach cut; this is it, at the road's own level.
 */
const PORTAL_APPROACH_M = 16;
/** How far the cutting's floor reaches past the void it fills — half a core cell,
 *  plus a little, since a cell is dropped on its centre. */
const PORTAL_CUT_MARGIN_M = 2.5;
/**
 * How far the sleeve stands out of the face, and how far it reaches in.
 *
 * Three metres out, not one: the cut floor meets the hill somewhere inside the
 * cell that straddles the mouth, so the ramp between them can start up to a
 * cell early. The collar stands in front of all of it.
 */
const PORTAL_OUT_M = 5;
/** Wall thickness of the sleeve — what the ring at the mouth shows of itself. */
const PORTAL_RING_M = 0.8;
/**
 * The sleeve reaches past the pit it stands in.
 *
 * At 8 m it ended exactly where the excavation does, so looking into the mouth
 * showed the pit's own far wall — lit terrain, square across the road. Six
 * metres further in is buried in solid hill, costs no triangles (the tube is
 * two rings either way) and puts dark sleeve where the eye follows the road.
 */
const PORTAL_IN_M = 14;
const PORTAL_ARCH_SEGMENTS = 8;
/** How finely the lid over the cutting follows the hill it replaces. */
const PORTAL_LID_STEPS = 4;

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

/**
 * The cells the terrain must not fill: the arch's own footprint at each mouth.
 *
 * This is the one place a height field genuinely cannot answer. The cut floor
 * and the untouched hill are neighbouring nodes 3 m apart with 8.6 m between
 * them, and the surface drawn across that pair is a ramp — measured, it rises
 * from the road to 8.60 m and is drawn straight through the opening, so the
 * mouth showed a slope where the bore should be. No wall in front helps: the
 * ramp is *inside* the hole, not outside it.
 *
 * So the ground is removed over the arch, from the headwall to just past where
 * the ramp lands, and the sleeve — which runs further in than the void does —
 * is what covers the gap. That is D4's boolean cut, reduced to the only shape
 * the field has to lose.
 */
const PORTAL_VOID_IN_M = 8;

/** A portal's own keep-out: a rectangle along the mouth's axis, open at the front. */
export interface PortalCut {
  x: number;
  z: number;
  ux: number;
  uz: number;
  halfM: number;
  frontM: number;
  backM: number;
}

/** Where the terrain stops, and how deep the cutting under it goes. */
export interface PortalHollow {
  at(x: number, z: number): boolean;
  /** Where the sleeve runs: ground walled across here would stand in the bore. */
  boreAt(x: number, z: number): boolean;
  /**
   * The cuttings a portal needs kept clear of buildings.
   *
   * A 36 m block stands over Monaco's inland mouth — measured straight down at
   * the mouth — so the arch was built inside a building and none of it could be
   * seen. A footprint over a cutting has the cutting taken out of it.
   */
  cuts: PortalCut[];
  /** The cutting's floor — the road at the nearest mouth. */
  floorAt(x: number, z: number): number;
}

function portalVoids(
  vaults: VaultedRuns,
  hill: HeightField,
  plane: ScenePlane,
): PortalHollow {
  const { coords, elevations } = hill.trackProfile;
  const boxes: { x: number; z: number; ux: number; uz: number; roadY: number }[] = [];
  for (const run of vaults.runs) {
    for (const end of [
      { index: run[0], into: 1 },
      { index: run[run.length - 1], into: -1 },
    ]) {
      const neighbour = end.index + end.into;
      if (neighbour < 0 || neighbour >= coords.length) continue;
      const x = plane.x(coords[end.index][0]);
      const z = plane.z(coords[end.index][1]);
      let ux = plane.x(coords[neighbour][0]) - x;
      let uz = plane.z(coords[neighbour][1]) - z;
      const length = Math.hypot(ux, uz);
      if (length < 1e-6) continue;
      boxes.push({ x, z, ux: ux / length, uz: uz / length, roadY: elevations[end.index] });
    }
  }
  const inside = (x: number, z: number) => {
    for (const box of boxes) {
      const dx = x - box.x;
      const dz = z - box.z;
      const along = dx * box.ux + dz * box.uz;
      if (along < -PORTAL_APPROACH_M || along > PORTAL_VOID_IN_M - PORTAL_VOID_PAD_M) {
        continue;
      }
      if (Math.abs(dx * -box.uz + dz * box.ux) <= PORTAL_VOID_HALF_M) return box;
    }
    return null;
  };

  // The sleeve's own footprint, which is narrower than the cutting and runs
  // further in. A pit rim that crosses it would be a wall built across the road,
  // and it is exactly what the eye meets looking into the mouth.
  const inBore = (x: number, z: number) => {
    for (const box of boxes) {
      const dx = x - box.x;
      const dz = z - box.z;
      const along = dx * box.ux + dz * box.uz;
      if (along < -PORTAL_APPROACH_M || along > PORTAL_IN_M) continue;
      if (Math.abs(dx * -box.uz + dz * box.ux) <= PORTAL_HALF_WIDTH_M) return true;
    }
    return false;
  };

  const cuts: PortalCut[] = boxes.map((box) => ({
    x: box.x,
    z: box.z,
    ux: box.ux,
    uz: box.uz,
    halfM: PORTAL_VOID_HALF_M + PORTAL_CUT_MARGIN_M,
    frontM: -PORTAL_APPROACH_M - PORTAL_CUT_MARGIN_M,
    backM: PORTAL_VOID_IN_M,
  }));

  return {
    at: (x, z) => inside(x, z) !== null,
    boreAt: inBore,
    cuts,
    floorAt: (x, z) => {
      const box = inside(x, z);
      if (box && !Number.isNaN(box.roadY)) return box.roadY;
      // Off the void the question is not asked; a nearest-mouth answer keeps a
      // caller that rounds to a cell centre from falling through to nothing.
      let best = Number.NaN;
      let bestDistance = Infinity;
      for (const candidate of boxes) {
        const distance = Math.hypot(x - candidate.x, z - candidate.z);
        if (distance < bestDistance && !Number.isNaN(candidate.roadY)) {
          bestDistance = distance;
          best = candidate.roadY;
        }
      }
      return best;
    },
  };
}

function bakePortals(
  vaults: VaultedRuns,
  hill: HeightField,
  plane: ScenePlane,
): { sleeve: Mesh; surround: Mesh; road: Mesh } {
  const mesh = createMesh();
  const surround = createMesh();
  const road = createMesh();
  const profile = portalSection();

  const { coords, elevations } = hill.trackProfile;
  // Mouths sit where the vault does, not where the tag does — see vaultedRuns.
  for (const run of vaults.runs) {
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
      //
      // Inward from the face only. The ground outside it is the cutting's
      // floor, at the road's own level, so including it would read no cover at
      // all and shrink every arch to its floor.
      const crown = PORTAL_WALL_M + PORTAL_ARCH_M;
      let cover = Infinity;
      for (let along = 0; along <= PORTAL_IN_M; along += 2) {
        const probe = hill.heightAt(
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

      // The road the sleeve stands over. The bore has its own floor, but it
      // starts further in than the sleeve does, so without this the first
      // metres of the opening show nothing at all and the mouth reads as a
      // patch of black rather than as somewhere a road goes.
      {
        // As wide as the cutting, not just as the arch: the approach the void
        // takes out of the hill has no bottom of its own, and without one the
        // trench shows the sea through it. Wider than the void's nominal half,
        // for the same reason the face is (D21): a cell is dropped on its own
        // centre, so the hole runs up to half a cell past where it was asked to.
        const left = -PORTAL_VOID_HALF_M - PORTAL_CUT_MARGIN_M;
        const right = PORTAL_VOID_HALF_M + PORTAL_CUT_MARGIN_M;
        const floor = (offset: number, along: number) => ({
          x: mouth.x + nx * offset + mouth.ux * along,
          y: roadY - BORE_FLOOR_DROP_M,
          z: mouth.z + nz * offset + mouth.uz * along,
        });
        const a = floor(left, -PORTAL_APPROACH_M - PORTAL_CUT_MARGIN_M);
        const b = floor(right, -PORTAL_APPROACH_M - PORTAL_CUT_MARGIN_M);
        const c = floor(right, inside);
        const d = floor(left, inside);
        addFlatQuad(road, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      }

      // The ring that makes it a mouth rather than a hole.
      //
      // A sleeve whose faces all point inward is invisible from outside: the
      // camera looks straight through the near wall at the lit far one, and the
      // opening reads as a film stretched over the cutting rather than as a way
      // in. So the tube carries a second skin, `PORTAL_RING_M` thick, wound
      // outward, and the two are joined by a flat annulus at the front. What
      // stands in the cutting is then a length of concrete tube with a dark
      // hole in it, which is what a portal is.
      const ringAt = (index: number, along: number) => {
        const point = profile[index];
        const outward = point.offset === 0 ? 0 : Math.sign(point.offset);
        const spread = point.offset + outward * PORTAL_RING_M;
        return {
          x: mouth.x + nx * spread + mouth.ux * along,
          y: roadY + point.height * scale + PORTAL_RING_M,
          z: mouth.z + nz * spread + mouth.uz * along,
        };
      };
      // The skin runs the sleeve's whole length, not just the collar at its
      // mouth. Inward-facing walls are culled from outside, so through the
      // opening the eye went past the tube and landed on the pit's own far
      // wall — lit terrain, square across the road. With an outside all the way
      // in, what stands there is the tube.
      const ringBack = inside;
      for (let i = 0; i < profile.length - 1; i++) {
        const a = ringAt(i, outside);
        const b = ringAt(i + 1, outside);
        const c = ringAt(i + 1, ringBack);
        const d = ringAt(i, ringBack);
        // The other way round from the sleeve: this skin faces the weather.
        addFlatQuad(surround, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      }
      for (let i = 0; i < profile.length - 1; i++) {
        const inner1 = at(i, outside);
        const inner2 = at(i + 1, outside);
        const outer1 = ringAt(i, outside);
        const outer2 = ringAt(i + 1, outside);
        addFlatQuad(
          surround,
          inner1.x, inner1.y, inner1.z,
          outer1.x, outer1.y, outer1.z,
          outer2.x, outer2.y, outer2.z,
          inner2.x, inner2.y, inner2.z,
        );
      }

      // The headwall closes the cutting, and the void behind it.
      //
      // The cut floor and the untouched hill are neighbouring nodes with 8.6 m
      // between them, and the surface drawn across that pair is a ramp — one
      // cell long, steeper than the arch, drawn straight through the opening.
      // No wall in front of it helps: the ramp is *inside* the hole. So the
      // ground over the arch is removed (`portalVoids`) and the portal closes
      // what that leaves: a face at each end of the void with the arch cut out
      // of it, and a wall down each side. The sleeve runs further in than the
      // void does, so the bore is what shows through both openings.
      const archCentreHeight = PORTAL_WALL_M * scale;
      const groundOver = (offset: number, along: number) => {
        const fx = mouth.x + nx * offset + mouth.ux * along;
        const fz = mouth.z + nz * offset + mouth.uz * along;
        const over = hill.heightAt(plane.lon(fx), plane.lat(fz));
        return Number.isNaN(over) ? roadY : over;
      };
      const at3 = (offset: number, height: number, along: number) => ({
        x: mouth.x + nx * offset + mouth.ux * along,
        y: roadY + height,
        z: mouth.z + nz * offset + mouth.uz * along,
      });
      // Tall enough to reach the hill it is set into, and never below the arch.
      // Read across the face rather than at its centre: the hill falls away
      // sideways, and a face cut to the middle reading leaves its corners short.
      const topOf = (along: number) => {
        let top = crown * scale + PORTAL_SURROUND_M;
        for (const offset of [-PORTAL_FACE_HALF_M, 0, PORTAL_FACE_HALF_M]) {
          top = Math.max(top, groundOver(offset, along) - roadY);
        }
        return top;
      };
      /** Where a ray out of the arch's centre leaves the face's rectangle. */
      const outward = (index: number, top: number) => {
        const point = profile[index];
        const height = point.height * scale;
        const dx = point.offset;
        const dy = height - archCentreHeight;
        const length = Math.hypot(dx, dy) || 1;
        const ox = dx / length;
        const oy = dy / length;
        const toSide = ox > 0
          ? (PORTAL_FACE_HALF_M - point.offset) / ox
          : ox < 0
            ? (-PORTAL_FACE_HALF_M - point.offset) / ox
            : Infinity;
        const toCap = oy > 1e-6 ? (top - height) / oy : oy < -1e-6 ? -height / oy : Infinity;
        const reach = Math.max(0, Math.min(toSide, toCap));
        return { offset: point.offset + ox * reach, height: height + oy * reach };
      };
      const facePlane = (target: Mesh, along: number, flip: boolean) => {
        const top = topOf(along);
        for (let i = 0; i < profile.length - 1; i++) {
          const inner = [profile[i], profile[i + 1]];
          const a = at3(inner[0].offset, inner[0].height * scale, along);
          const b = at3(inner[1].offset, inner[1].height * scale, along);
          const oa = outward(i, top);
          const ob = outward(i + 1, top);
          const c = at3(ob.offset, ob.height, along);
          const d = at3(oa.offset, oa.height, along);
          if (flip) {
            addFlatQuad(target, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
          } else {
            addFlatQuad(target, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, b.x, b.y, b.z);
          }
        }
      };
      const front = outside;
      const back = PORTAL_VOID_IN_M;
      // The sides run between the faces, so the void is closed all round.
      facePlane(surround, front, false);
      facePlane(surround, back, true);

      // A lid over the void. The sleeve's back is 6.5 m below the hilltop, so
      // without one the excavation reads from above as a black rectangle cut
      // into the slope — the hole is closed at the road's level and open at the
      // sky's.
      //
      // It follows the hill rather than spanning it flat. One quad corner to
      // corner read as a grey plate laid on the slope, because the ground it
      // stands in for falls across its width as well as along it; a grid of
      // them, each node taking the hill's own height wherever that is above the
      // arch, reads as ground.
      {
        // The two end rows take the faces' own top, so lid and face meet along
        // one line: a face is flat-topped and the hill is not, and the gap that
        // left showed the void through the hilltop.
        const lidNode = (offset: number, along: number, end: number | null) => {
          if (end !== null) return at3(offset, end, along);
          const floor = crown * scale + PORTAL_SURROUND_M;
          return at3(offset, Math.max(floor, groundOver(offset, along) - roadY), along);
        };
        const endAt = (j: number) =>
          j === 0 ? topOf(front) : j === PORTAL_LID_STEPS ? topOf(back) : null;
        for (let i = 0; i < PORTAL_LID_STEPS; i++) {
          const o0 = -PORTAL_FACE_HALF_M + (2 * PORTAL_FACE_HALF_M * i) / PORTAL_LID_STEPS;
          const o1 = -PORTAL_FACE_HALF_M + (2 * PORTAL_FACE_HALF_M * (i + 1)) / PORTAL_LID_STEPS;
          for (let j = 0; j < PORTAL_LID_STEPS; j++) {
            const a0 = front + ((back - front) * j) / PORTAL_LID_STEPS;
            const a1 = front + ((back - front) * (j + 1)) / PORTAL_LID_STEPS;
            const p00 = lidNode(o0, a0, endAt(j));
            const p10 = lidNode(o1, a0, endAt(j));
            const p11 = lidNode(o1, a1, endAt(j + 1));
            const p01 = lidNode(o0, a1, endAt(j + 1));
            addFlatQuad(surround, p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
          }
        }
      }

      // The sleeve is capped at its far end, in its own dark material.
      //
      // Open, it looked through the hill: the ground's back faces are culled,
      // so past the tube's end the eye ran out the other side of the slope and
      // found the sky — a bright patch sitting where the tunnel should be
      // going. The cap is what the road disappears into until the bore, which
      // only exists where the hill genuinely covers it, takes over.
      {
        const capAt = (index: number) => at(index, inside);
        const centre = {
          x: mouth.x + mouth.ux * inside,
          y: roadY + (PORTAL_WALL_M * 0.5) * scale,
          z: mouth.z + mouth.uz * inside,
        };
        for (let i = 0; i < profile.length - 1; i++) {
          const a = capAt(i);
          const b = capAt(i + 1);
          addFlatTriangle(mesh, centre.x, centre.y, centre.z, b.x, b.y, b.z, a.x, a.y, a.z);
        }
      }
    }
  }

  return { sleeve: mesh, surround, road };
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

/** Cover a full-height portal needs: the crown, plus the headwall around it. */
const PORTAL_NEED_M = PORTAL_WALL_M + PORTAL_ARCH_M + PORTAL_SURROUND_M;
/** How far a mouth may be pushed into the hill looking for that cover. Past
 *  this the hill is not going to arrive and the arch is scaled instead. */
const PORTAL_SEEK_M = 30;

export interface VaultedRuns {
  /** Profile-index runs a vault is built along, mouth to mouth. */
  runs: number[][];
  /** True at a centreline sample a vault covers — the burn-in's hold-back. */
  covers(lon: number, lat: number): boolean;
  stats: { taggedSamples: number; vaultedSamples: number; cutM: number };
}

/**
 * Where the vault goes, and therefore where the ground is left alone (P4.1).
 *
 * A tagged tunnel is longer than the hill it runs under. `coveredRuns` already
 * finds the stretch with real cover, but the terrain was still the raw hill for
 * the whole tag, so the approaches kept a lip of ground rising over the road:
 * the ribbon dived under it, and it cut across the arch in front of the mouth.
 * What is actually there is a cutting, and a cutting is what the burn-in makes.
 *
 * The mouths are then pushed inward to where the hill is tall enough for a
 * full-height portal, up to `PORTAL_SEEK_M`. Selecting the run at that depth
 * instead would break it in two — Monaco thins to 6.6 m of cover halfway
 * through — and put two more mouths in the middle of the hill.
 */
function vaultedRuns(
  field: HeightField,
  plane: ScenePlane,
  tunnels: TunnelMask,
): VaultedRuns {
  const { coords, elevations } = field.trackProfile;
  const coverAt = (i: number) => {
    const ground = field.heightAt(coords[i][0], coords[i][1]);
    return Number.isNaN(ground) ? Number.NaN : ground - elevations[i];
  };
  const stepM = (a: number, b: number) =>
    Math.hypot(
      plane.x(coords[a][0]) - plane.x(coords[b][0]),
      plane.z(coords[a][1]) - plane.z(coords[b][1]),
    );

  let cutM = 0;
  const runs: number[][] = [];
  for (const run of coveredRuns(field, tunnels, BORE_MIN_HEIGHT_M + BORE_COVER_M)) {
    let from = 0;
    let to = run.length - 1;
    let sought = 0;
    while (from < to && coverAt(run[from]) < PORTAL_NEED_M && sought < PORTAL_SEEK_M) {
      sought += stepM(run[from], run[from + 1]);
      from++;
    }
    cutM += sought;
    sought = 0;
    while (to > from && coverAt(run[to]) < PORTAL_NEED_M && sought < PORTAL_SEEK_M) {
      sought += stepM(run[to], run[to - 1]);
      to--;
    }
    cutM += sought;
    if (to - from > 1) runs.push(run.slice(from, to + 1));
  }

  // Keyed on the sample itself. Both passes densify the same centreline with
  // the same step, so the profile is the same array of points either time.
  const covered = new Set<string>();
  for (const run of runs) for (const i of run) covered.add(`${coords[i][0]},${coords[i][1]}`);

  let taggedSamples = 0;
  for (const [lon, lat] of coords) if (tunnels.buried(lon, lat)) taggedSamples++;

  return {
    runs,
    covers: (lon, lat) => covered.has(`${lon},${lat}`),
    stats: {
      taggedSamples,
      vaultedSamples: covered.size,
      cutM: Math.round(cutM),
    },
  };
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
  vaults: VaultedRuns,
  section: { offset: number; height: number }[],
): { lining: Mesh; road: Mesh } {
  const mesh = createMesh();
  const road = createMesh();
  const { coords, elevations } = field.trackProfile;

  for (const run of vaults.runs) {
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
        road,
        nearLeft.x, nearLeft.y, nearLeft.z,
        nearRight.x, nearRight.y, nearRight.z,
        farRight.x, farRight.y, farRight.z,
        farLeft.x, farLeft.y, farLeft.z,
      );
    }
  }

  return { lining: mesh, road };
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
  plane: ScenePlane,
  field: HeightField,
  vaults: VaultedRuns,
): [number, number][] {
  // Walked along the field's own densified profile, not the drawn centreline.
  // Both describe the same polyline, so a distance fraction means the same
  // thing on either — but the drawn one carries a vertex every 30 to 70 m
  // through the tunnel, and a span can only begin at a vertex. Snapping to
  // those left 51 m of ribbon drawn inside the hill at the entry. The profile
  // is sampled every 3 m.
  const points = field.trackProfile.coords;
  if (points.length < 2) return [];

  // Fractions of lap length, not of vertex count. The runtime samples its curve
  // evenly by distance while the centreline's own vertices are spaced by
  // whoever drew it — on Monaco the hairpins carry vertices every few metres and
  // the straights every twenty, so an index fraction points somewhere else
  // entirely and the ribbon vanishes well past the tunnel.
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    distances.push(
      distances[i - 1] +
        Math.hypot(
          plane.x(points[i][0]) - plane.x(points[i - 1][0]),
          plane.z(points[i][1]) - plane.z(points[i - 1][1]),
        ),
    );
  }
  const last = points.length - 1;
  const closed = points[0][0] === points[last][0] && points[0][1] === points[last][1];
  const total = closed
    ? distances[last]
    : distances[last] +
      Math.hypot(
        plane.x(points[0][0]) - plane.x(points[last][0]),
        plane.z(points[0][1]) - plane.z(points[last][1]),
      );
  if (total <= 0) return [];

  // Hidden exactly where the vault covers the road, and nowhere else.
  //
  // Not the tag: OSM marks the whole 455 m, but at both ends the thing overhead
  // is a building or nothing at all, and hiding by the tag took the ribbon away
  // while the car was still in the open. Measuring the ground instead was
  // closer but still early — the mouth is pushed inland to where the hill is
  // deep enough for a full-height portal, so between the first centimetre of
  // cover and the portal itself the road went missing with nothing to go into.
  // The vault knows where its own mouths are; the ribbon stops at them.
  const spans: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < points.length; i++) {
    const covered = vaults.covers(points[i][0], points[i][1]);
    if (covered && start < 0) start = i;
    if (!covered && start >= 0) {
      spans.push([distances[start] / total, distances[i - 1] / total]);
      start = -1;
    }
  }
  if (start >= 0) spans.push([distances[start] / total, distances[last] / total]);
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
  conform: TerrainResult["conform"];
  holesFilled: number;
  trackVertices: number;
  portalTriangles: number;
  barrierTriangles: number;
  shore: ShoreResult;
  piers: PierResult;
  coast: CoastlineStats;
  heights: HeightStats;
  tunnels: TunnelMask;
  vaults: VaultedRuns["stats"];
  props: PropResult["stats"];
  greenery: GreeneryResult["stats"];
  kit: KitResult["stats"] & { plinths: number };
  slopeShaded: number;
  overrides: OverrideStats;
}

/**
 * Everything the bake reads from outside itself: the network, the caches on
 * disk, the asset packs. Nothing below this point fetches anything, so the same
 * pipeline runs over a circuit and over a committed fixture — which is what
 * makes layer B of `docs/scene-goals.md` §3 possible at all.
 */
export interface BakeInputs {
  circuitId: string;
  /** Centreline in lon/lat, the closed loop as the circuit is drawn. */
  coords: [number, number][];
  /** The window baked. A circuit's is its own padded bbox; a fixture's is smaller. */
  bbox: RasterBBox;
  dtm: Raster;
  /** Surface model, where a provider has one. Building heights come off it. */
  mnh: Raster | null;
  structures: StructureWay[];
  shoreWays: ShoreWay[];
  buildingWays: BuildingWay[];
  greenWays: GreenWay[];
  breaklineWays: BreaklineWay[];
  overrides: CityOverrides | null;
  kitHouses: KitModel[];
  /** Boat model paths, as the props pass wants them. */
  kitBoats: string[];
  /** Kit trees, planted at the survey's own tree nodes. */
  kitTrees: string[];
}

/** The reads, all of them, in one place. */
export async function loadBakeInputs(circuitId: string, refresh = false): Promise<BakeInputs> {
  const coords = await loadCircuitCoords(circuitId);
  const bbox = circuitBBox(coords);
  const dtm = await fetchElevationRaster({ kind: "dtm", bbox, refresh });
  // A surface model where one exists. Skadi has no layer for it at all, and
  // IGN's box reaches into countries it holds nothing for, so the test is
  // whether the raster came back with any data — not whether a provider claimed
  // the ground. A circuit without measured heights is not a circuit without
  // buildings; the tags carry it.
  const surface = providerFor(bbox)?.layerFor("mnh")
    ? await fetchElevationRaster({ kind: "mnh", bbox, refresh })
    : null;

  return {
    circuitId,
    coords,
    bbox,
    dtm,
    mnh: surface && surface.header.validCount > 0 ? surface : null,
    structures: await fetchStructureWays(circuitId, bbox, refresh),
    shoreWays: await fetchShoreWays(circuitId, bbox, refresh),
    buildingWays: await fetchBuildingWays(circuitId, bbox, refresh),
    greenWays: await fetchGreenWays(circuitId, bbox, refresh),
    breaklineWays: await fetchBreaklineWays(circuitId, bbox, refresh),
    overrides: await loadOverrides(circuitId),
    // Downloaded packs, if this checkout has them (`bun run assets:fetch`).
    kitHouses: await loadKitHouses(REPO_ROOT, "assets/models/kenney-city-suburban"),
    kitTrees: await loadKitPaths(REPO_ROOT, "assets/models/kenney-city-suburban", ["tree-"]),
    kitBoats: await loadKitPaths(REPO_ROOT, "assets/models/kenney-watercraft", [
      "boat-speed",
      "boat-row",
      "boat-fishing",
      "boat-sail",
    ]),
  };
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
  /**
   * The ground before the cuttings were burned into it. The tunnel's own
   * geometry is sized against this: the cut at a mouth is there because the
   * portal is, so reading it back would shrink the arch to nothing.
   */
  hill: HeightField;
  corridor: ReturnType<typeof buildCorridor>;
  tunnels: TunnelMask;
  vaults: VaultedRuns;
}

export function buildCircuitGround(inputs: BakeInputs): CircuitGround {
  const { circuitId, coords, bbox, dtm, structures, overrides } = inputs;
  const plane = scenePlaneFor(coords);
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

  // Two passes, because where a vault goes cannot be known until the ground is
  // known (P4.1). The first keeps every tagged metre of tunnel unburned, which
  // is the only way to read how much hill there is over the road; the second
  // holds back only the stretch that turned out to have a hill, so the
  // approaches are burned in as the cuttings they are.
  const survey = buildHeightField({
    dtm,
    track: {
      coords,
      halfWidthM: DEFAULT_TRACK_HALF_WIDTH_M,
      buried: tunnels.buried,
    },
  });
  const vaults = vaultedRuns(survey, plane, tunnels);
  const field = buildHeightField({
    dtm,
    track: {
      coords,
      halfWidthM: DEFAULT_TRACK_HALF_WIDTH_M,
      buried: tunnels.buried,
      vaulted: vaults.covers,
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
    hill: survey,
    corridor: buildCorridor(coords, plane),
    tunnels,
    vaults,
  };
}

export async function bakeCircuit(circuitId: string, refresh = false): Promise<BakeReport> {
  return bakeFrom(await loadBakeInputs(circuitId, refresh));
}

export interface BakeOptions {
  /** Where the GLBs and the manifest land. Defaults to `public/environments/<id>`. */
  outDir?: string;
}

/** The pipeline itself, over inputs somebody else read. */
export async function bakeFrom(inputs: BakeInputs, options: BakeOptions = {}): Promise<BakeReport> {
  const { circuitId, buildingWays, greenWays, breaklineWays, mnh, kitHouses, kitBoats, kitTrees } =
    inputs;
  const { coords, plane, field, hill, corridor, tunnels, vaults, overrides, overrideStats } =
    buildCircuitGround(inputs);
  const shoreWays = overrideShoreWays(inputs.shoreWays, overrides, overrideStats);
  const coast = buildCoastline(shoreWays, field, plane);
  const shore = bakeShoreWalls(shoreWays, field, plane, coast);
  const piers = buildPiers(shoreWays, field, plane);
  const pierDecks = bakePierDecks(piers);

  const elevations = trackElevations(field, coords, plane);
  const portals = bakePortals(vaults, hill, plane);
  const bore = bakeTunnelBody(hill, plane, vaults, portalSection());
  const barriers = bakeBarriers(field, plane, tunnels, DEFAULT_TRACK_HALF_WIDTH_M);
  // The surveyed lines the belts' filter may not average across: cliffs and
  // retaining walls from their own query, quays and breakwaters from the shore.
  const breaklines = buildBreaklines(field, breaklineWays, shoreWays);
  const ground = buildGround(field, plane, breaklines);
  const hollow = portalVoids(vaults, hill, plane);
  const terrain = bakeTerrain(field, ground, plane, corridor, coast, piers, hollow);
  const water = bakeWater(field, plane);

  const buildingsFile = applyBuildingOverrides(
    fromOverpass(buildingWays),
    overrides,
    overrideStats,
  );
  const heightStats = { value: { measured: 0, fellBack: 0, medianDeltaM: 0, tallest: 0 } };
  const measured = measureBuildingHeights(buildingsFile.buildings, mnh, heightStats);
  const roofTags = new Map<string, RoofTags>(
    buildingWays.map((way) => [way.id, way.tags as RoofTags]),
  );
  const buildings = emptyBuildingResult();
  // The one surface, and it is the drawn one. The mesher's own node table would
  // be a second derivation: the coast is cut inside a cell, a seam node is
  // conformed to the coarser belt's chord, and a vertex is clamped to the
  // surface band — all after the nodes were read. A wall asking where the
  // ground is gets the triangle it will stand on.
  const drawnGround = buildSurfaceIndex(BELT_ORDER.map((belt) => [terrain.meshes[belt]]));
  const standOn = (x: number, z: number): number => drawnGround.at(x, z);
  // Only where the road is actually drawn: a building over a tunnel is a
  // building over a tunnel, and cutting a slot through it would open the hill.
  const roadIndex = buildRoadIndex(
    field.trackProfile.coords
      .filter(([lon, lat]) => !vaults.covers(lon, lat))
      .map(([lon, lat]) => ({ x: plane.x(lon), z: plane.z(lat) })),
  );
  // After the terrain, because these lie on the ground that is drawn rather
  // than on the field the belts filtered.
  const greenery = buildGreenery(greenWays, standOn, plane);
  const greeneryStats = { ...greenery.stats };

  const prepared = prepareBuildings(
    buildingsFile, standOn, plane, corridor, hollow, roadIndex, measured, buildings,
  );

  // The kit runs before the props are merged, because its houses are props: it
  // decides which footprints it can do better than an extrusion, and the rest
  // are extruded as they always were.
  const kit = chooseKitHouses(
    prepared.map((building) => ({
      id: building.id,
      ring: building.ring,
      // The floor an extrusion would have used. What the downhill side stands
      // on is the plinth `bakeBuildings` walls up to it.
      groundY: building.base,
      heightM: building.heightM,
      centreX: building.centreX,
      centreZ: building.centreZ,
    })),
    kitHouses,
    corridor,
    plane,
    (distanceM) => {
      const belt = beltAtDistance(distanceM);
      return belt === "far" ? null : belt;
    },
    {
      core: Math.round(BELT_BUDGET.core.triangles * KIT_BUDGET_SHARE),
      city: Math.round(BELT_BUDGET.city.triangles * KIT_BUDGET_SHARE),
    },
  );
  const kitHousePaths = new Set(kitHouses.map((model) => model.path));
  bakeBuildings(prepared, roofTags, buildings, kit.taken);
  const kitPlinths = bakeKitPlinths(kit, buildings.meshes, standOn, corridor);

  // Berthed from the harbour survey, the kit's houses, then whatever the
  // overrides add by hand.
  const overrideProps = overrides?.props ?? [];
  overrideStats.props = overrideProps.length;
  const props = await buildProps(
    [
      ...berthYachts(piers, field, plane, kitBoats),
      ...plantTrees(greenWays, kitTrees, plane, (x, z) => corridor.distance(x, z) >= TREE_CLEARANCE_M),
      ...kit.placements,
      ...overrideProps,
    ],
    standOn,
    plane,
    REPO_ROOT,
    // The kit's houses take this scene's paint; its trees and its boats keep
    // their own, because a green tree and a white hull are already the colours
    // the thing is.
    (path, mesh) => {
      if (kitHousePaths.has(path)) repaintKitHouse(mesh);
    },
  );
  props.stats.berthed = props.stats.byKind.yacht ?? 0;
  props.stats.fromOverrides = overrideProps.length;

  // Occlusion last: everything that casts it has to exist first.
  const standing = [
    buildings.meshes.core,
    buildings.meshes.city,
    buildings.meshes.far,
    portals.surround,
    // A kit house in a row of kit houses shades the one beside it, and a hull
    // shades the hull it is moored against. Props are built before this for
    // exactly that reason.
    props.dark,
    props.light,
    props.models,
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
    pierDecks,
    props.dark,
    props.light,
    props.models,
  ]) {
    applyAmbientOcclusion(mesh, occluders);
  }
  // Same reason as the slope pass: AO owns `colors` and writes it from nothing,
  // so a model's own palette can only be multiplied in once it has run.
  // The tone is the city's own building colour normalised to its brightness, so
  // it shifts hue without lightening what it touches.
  applyAlbedo(props.models, MODEL_TONE);
  // After the occlusion pass, which owns the same array: an open hillside sees
  // the whole sky, so AO says nothing about it and slope is what is left to
  // read the relief by.
  let slopeShaded = 0;
  for (const belt of BELT_ORDER) {
    slopeShaded += shadeBySlope(terrain.meshes[belt]);
  }

  const outDir = options.outDir ?? join(OUTPUT_ROOT, circuitId);
  await mkdir(outDir, { recursive: true });

  const layout: Record<Belt, { kind: MeshKind; mesh: Mesh }[]> = {
    core: [
      { kind: "terrain", mesh: terrain.meshes.core },
      { kind: "building", mesh: buildings.meshes.core },
      { kind: "tunnel", mesh: portals.sleeve },
      { kind: "tunnel", mesh: bore.lining },
      { kind: "boreRoad", mesh: bore.road },
      { kind: "boreRoad", mesh: portals.road },
      // Its own mesh, not merged into the buildings: a headwall stands over the
      // road on purpose, and the corridor check would read it as a wall in the
      // way.
      { kind: "portal", mesh: portals.surround },
      { kind: "barrier", mesh: barriers },
      // Flat, ground-level and near the road, so they belong with the core.
      { kind: "pool", mesh: greenery.pools },
      { kind: "pitch", mesh: greenery.pitches },
    ],
    city: [
      { kind: "terrain", mesh: terrain.meshes.city },
      { kind: "building", mesh: buildings.meshes.city },
      // The waterfront is one thing wherever it runs, so it ships whole rather
      // than split across belts by distance.
      { kind: "shore", mesh: shore.walls },
      // Decks go with the waterfront for the same reason: the harbour is one
      // thing, and splitting it by distance would cut a pontoon in half.
      { kind: "pier", mesh: pierDecks },
      // The boats belong to the harbour they are tied to, so they ship with it.
      { kind: "propDark", mesh: props.dark },
      { kind: "prop", mesh: props.light },
      { kind: "model", mesh: props.models },
      // Parks are ground cover and reach well past the core's 150 m, so they
      // ship with the belt that covers the city rather than with the track.
      { kind: "park", mesh: greenery.parks },
    ],
    far: [
      { kind: "terrain", mesh: terrain.meshes.far },
      { kind: "building", mesh: buildings.meshes.far },
      { kind: "water", mesh: water },
      // The block the whole thing is cut from: it arrives with the belt that
      // owns the rim, so a wide shot never shows the model without its body.
      { kind: "plinth", mesh: terrain.plinth },
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
    conform: terrain.conform,
    holesFilled: terrain.holesFilled,
    trackVertices: elevations.length,
    portalTriangles: triangleCount(portals.sleeve) + triangleCount(portals.surround),
    barrierTriangles: triangleCount(barriers),
    shore,
    piers,
    coast: coast.stats,
    heights: heightStats.value,
    tunnels,
    vaults: vaults.stats,
    props: props.stats,
    greenery: greeneryStats,
    kit: { ...kit.stats, plinths: kitPlinths },
    slopeShaded,
    overrides: overrideStats,
  };
  await writeManifest(outDir, circuitId, field, plane, report, elevations, buriedSpans(plane, field, vaults));
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
  console.log(
    `  belt seams ${report.conform.nodes} nodes conformed to the coarser chord, ` +
      `worst ${report.conform.worstM.toFixed(2)} m, mean ${report.conform.meanM.toFixed(2)} m, ` +
      `${report.conform.over1M} over 1 m, ${report.conform.over2M} over 2 m`,
  );
  console.log(`  enclosed water ${report.holesFilled} cells filled as holes`);
  console.log(
    `  piers ${report.piers.decks.length} decks, ` +
      `${report.piers.skippedOpen} mapped as a line, ` +
      `${report.piers.skippedSmall} too small, ` +
      `${report.piers.skippedSolid} already solid ground`,
  );
  console.log(
    `  surfaces ${report.greenery.pools} pools, ${report.greenery.pitches} pitches, `
      + `${report.greenery.parks} parks`
      + `; ${report.slopeShaded} ground nodes shaded by slope`,
  );
  console.log(
    `  kit ${report.kit.models} houses modelled (${report.kit.triangles.toLocaleString()} tris) — `
      + `${report.kit.eligible} footprints fit the shape, ${report.kit.aloneInTheStreet} stood alone, `
      + `${report.kit.noModelFits} had no model at their proportion, ${report.kit.overBudget} over budget, `
      + `${report.kit.plinths} on a plinth`,
  );
  console.log(
    `  props ${report.props.placed} placed — ${report.props.berthed} yachts berthed along the pontoons`
      + `, ${report.props.fromOverrides} from overrides, ${report.props.fromModels} from models`
      + (report.props.skippedAground ? `, ${report.props.skippedAground} with no ground under them` : ""),
  );
  if (report.tunnels.runs.length) {
    console.log(`  tunnels ${report.tunnels.runs.length} run(s), ${report.tunnels.buriedLengthM} m buried`);
    console.log(
      `  vaults ${report.vaults.vaultedSamples} of ${report.vaults.taggedSamples} tunnel samples`
        + ` have a hill over them, ${report.vaults.cutM} m cut open at the mouths`,
    );
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
