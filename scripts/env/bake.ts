/**
 * Bakes a circuit's city into GLB. Everything reads one height field, so terrain,
 * buildings, water and the track agree on where the ground is.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMeshQuantization } from "@gltf-transform/extensions";
import { meshopt, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { ShapeUtils, Vector2 } from "three";

import { BAKED_MESH_COLORS, DIORAMA_COLORS, type BakedMeshKind } from "../../src/lib/env/diorama-palette";
import { ENVIRONMENT_ATTRIBUTION, type BuildingsFile } from "../../src/lib/env/environment-types";
import { DEFAULT_HALF_WIDTH_M as RIBBON_HALF_WIDTH_M } from "../../src/lib/track/track-geometry";
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
import { buildHeightField, DEFAULT_VERGE_M, type HeightField } from "./heightfield";
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
import { applyAlbedo, applyAmbientOcclusion, buildGroundShade, buildOccluders, paintGround } from "./ao";
import {
  fetchBuildingWays,
  fetchStreetWays,
  fetchGreenWays,
  fetchBreaklineWays,
  fetchShoreWays,
  fetchStructureWays,
  type BreaklineWay,
  type BuildingWay,
  type StreetWay,
  type GreenWay,
  type ShoreWay,
  type StructureWay,
} from "./overpass";
import { buildGreenery, plantTrees, type GreeneryResult } from "./greenery";
import { buildSurfaceIndex } from "./baked-scene";
import { buildBreaklines, type Breaklines } from "./breaklines";
import cdt2d from "cdt2d";
import { buildRibbon, clipToCell, type Ribbon } from "./ribbon";
import { buildGround, SHORE_LIP_M, splitsOnMain, type Ground } from "./ground";
import { buildStreetGround } from "./streets";
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
import { buildPiers, type PierDeck, type PierResult } from "./piers";
import { berthYachts, buildProps, type PropResult } from "./props";
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
import { circuitBBox, circuitLengthM, loadCircuitCoords } from "./circuit";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const OUTPUT_ROOT = join(REPO_ROOT, "public", "environments");

/** Clear of the ground the track was burned into, just enough to beat depth precision. */
const TRACK_RAISE_M = 0.05;
/** Half the racing surface where no width profile exists. */
const DEFAULT_TRACK_HALF_WIDTH_M = 6;
/** Ground the track corridor owns; a footprint inside it is pushed out. */
const TRACK_CLEARANCE_M = 8;
/**
 * Wider than the corridor: a tree's canopy reaches past its trunk, and Monaco's
 * street trees are mapped right at the kerb.
 */
const TREE_CLEARANCE_M = 11;
/** How far a terrain edge drops where its neighbour is missing, to hide the seam. */
const SKIRT_M = 3;
/**
 * Bottom of the block the landscape is cut from. A thin skirt under a tall hill
 * reads as paper, so the rim drops to one flat floor instead.
 */
const PLINTH_FLOOR_M = -60;
/** Where the step at the shoreline and a pontoon deck's walls end, under the sea plane. */
const SHORE_FOOT_M = -3;
/**
 * Highest the land may be at the water's edge. Without the cap a cliff's edge took
 * the clifftop height and the shore came out as a palisade of slabs.
 */
export const SHORE_EDGE_MAX_M = 3;
/**
 * Land held this far above the sea quad, so a beach at y = 0 does not z-fight
 * with the water as the camera moves.
 */
export const WATER_CLEARANCE_M = 0.25;
/**
 * How far the surveyed line may say "water" before the raster overrules it. A pier
 * meeting its quay punches a shallow false hole at the corner.
 */
const SURVEYED_HOLE_M = 2.5;
const RASTER_CONFIDENT_M = 8;
/** How wet a node cleared for a deck reads. Any negative would do; this keeps the cut's interpolation sane. */
const DECK_CLEARED_SCALAR_M = 2;
/** How the seabed falls away from the shoreline, metres per metre, and where it stops. */
const SEABED_SLOPE = 4;
const SEABED_FLOOR_M = -15;
/** Keys for the vertices the shoreline adds, clear of the grid's and the road's. */
const SHORE_VERTEX_KEY = 2e12;
/** Ground this far under the sea plane is not drawn. */
const SEABED_HIDDEN_M = -2;
/** Buildings below this are noise — bin stores, lift housings, map clutter. */
const MIN_BUILDING_HEIGHT_M = 2;

/**
 * How far the cut may sit below the land behind it; the rest of the drop goes to
 * the skirt, or a cliff face hangs on one row of triangles.
 */
export const MAX_COAST_DROP_M = 6;

/** The palette's building hue, luminance divided out, that merged models are pulled toward. */
const MODEL_TONE: [number, number, number] = (() => {
  const hex = DIORAMA_COLORS.building.replace("#", "");
  const rgb = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [rgb[0] / luminance, rgb[1] / luminance, rgb[2] / luminance];
})();

type MeshKind = BakedMeshKind;

/** The light set is what the bake writes; the dark one is the runtime's. */
const MESH_COLOR = BAKED_MESH_COLORS.light;

// terrain
interface TerrainResult {
  meshes: Record<Belt, Mesh>;
  blocks: BeltBlocks;
  /** The block's sides and its floor, cut from the far belt's own rim. */
  plinth: Mesh;
  cellsByBelt: Record<Belt, number>;
  /** Cells of water that never reached the sea and were filled as holes. */
  holesFilled: number;
  /** Cells of water too narrow to draw, filled as land. */
  inletsFilled: number;
  /** Cells of land too small and too far out to be anything but noise, drawn as sea. */
  isletsDrowned: number;
  /** How much the fine belts gave up to meet the coarse ones — see `surfaceHeightAt`. */
  conform: { nodes: number; worstM: number; meanM: number; over1M: number; over2M: number };
}

/** The finest lattice any belt samples, so every belt sees the same fill. */
const POND_CELL_M = BELT_CELL_M.core;
/** Enclosed water smaller than this is a hole to fill, not a basin. */
const MIN_POND_M2 = 400;
/** How much land a filled hole reports. Enough that no cell edge crosses zero inside it. */
const POND_FILLED_SCALAR_M = 2;
/** Water with high land this many nodes away on both sides is too narrow to draw. */
const PINCH_NODES = 2;
const PINCH_LAND_M = SHORE_EDGE_MAX_M + MAX_COAST_DROP_M;

/**
 * Small water that never reaches the open sea. Real basins all reach the sea, so
 * these are artefacts of the cut at pier corners and get filled.
 */
function findEnclosedWater(
  scalarAt: (x: number, z: number) => number,
  heightAt: (x: number, z: number) => number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): {
  cells: number;
  pinched: number;
  islets: number;
  /** Land drawn where the scalar says water, or water where it says land; zero where it is left alone. */
  overrideAt(x: number, z: number): number;
} {
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
  const drowned = new Uint8Array(rows * cols);
  const maxCells = Math.round(MIN_POND_M2 / (POND_CELL_M * POND_CELL_M));
  /** Every patch of nodes `wet` marks as `kind` that is small and never reaches the bbox's edge. */
  const enclosed = (kind: number, into: Uint8Array): number => {
    const seen = new Uint8Array(rows * cols);
    const component: number[] = [];
    const queue: number[] = [];
    let cells = 0;
    for (let start = 0; start < wet.length; start++) {
      if (seen[start] || wet[start] !== kind) continue;
      component.length = 0;
      queue.length = 0;
      queue.push(start);
      seen[start] = 1;
      let reachesTheEdge = false;

      while (queue.length) {
        const index = queue.pop() as number;
        component.push(index);
        const row = Math.floor(index / cols);
        const col = index - row * cols;
        if (row === 0 || col === 0 || row === rows - 1 || col === cols - 1) reachesTheEdge = true;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const next = nr * cols + nc;
          if (seen[next] || wet[next] !== kind) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }

      if (reachesTheEdge || component.length > maxCells) continue;
      for (const index of component) into[index] = 1;
      cells += component.length;
    }
    return cells;
  };
  const cells = enclosed(1, filled);
  // The same holds the other way round: a scrap of land the sea rings, smaller
  // than a hole would be, is the line and the raster disagreeing off a quay.
  for (let i = 0; i < wet.length; i++) if (filled[i]) wet[i] = 1 - wet[i];
  const islets = enclosed(0, drowned);
  for (let i = 0; i < wet.length; i++) if (filled[i]) wet[i] = 1 - wet[i];

  // Land close on both sides along any axis, straight or diagonal.
  const dryWithin = (row: number, col: number, dr: number, dc: number): boolean => {
    for (let step = 1; step <= PINCH_NODES; step++) {
      const r = row + dr * step;
      const c = col + dc * step;
      if (r < 0 || c < 0 || r >= rows || c >= cols) return false;
      if (!wet[r * cols + c]) return heightAt(minX + c * POND_CELL_M, minZ + r * POND_CELL_M) > PINCH_LAND_M;
    }
    return false;
  };
  let pinched = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      if (!wet[index] || filled[index]) continue;
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
        if (!dryWithin(row, col, dr, dc) || !dryWithin(row, col, -dr, -dc)) continue;
        filled[index] = 1;
        pinched++;
        break;
      }
    }
  }

  return {
    cells,
    pinched,
    islets,
    overrideAt(x: number, z: number): number {
      const col = Math.round((x - minX) / POND_CELL_M);
      const row = Math.round((z - minZ) / POND_CELL_M);
      if (row < 0 || col < 0 || row >= rows || col >= cols) return 0;
      const index = row * cols + col;
      return filled[index] ? POND_FILLED_SCALAR_M : drowned[index] ? -POND_FILLED_SCALAR_M : 0;
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
   * Is this a node the fine belt gave up to the coarse one? Shared with the audit so
   * the rule lives in one place.
   */
  conformsAt(x: number, z: number): boolean;
  /**
   * The coarsest cell among the blocks a point touches. Both sides of a seam see the same value.
   */
  coarsestCellAt(x: number, z: number): number;
}

/**
 * Which belt owns which patch of ground, decided on the coarsest grid so the finer
 * ones divide into it exactly. Coast blocks grow by one and use the finest cell.
 */
export function buildBeltBlocks(
  field: HeightField,
  plane: ScenePlane,
  corridor: Corridor,
  /** Metres from the shoreline, positive on land. The raster alone misses breakwaters. */
  landAt?: (x: number, z: number) => number,
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
      if (straddlesWater(field, plane, x, z, blockM, landAt)) straddles[row * blockCols + col] = 1;
    }
  }
  // Steep blocks get the fine cell too: a coarse cell on a cliff reads as sawteeth.
  const steep = new Uint8Array(blockRows * blockCols);
  for (let row = 0; row < blockRows; row++) {
    for (let col = 0; col < blockCols; col++) {
      const x = minX + (col + 0.5) * blockM;
      const z = minZ + (row + 0.5) * blockM;
      const east = field.heightAt(plane.lon(x + blockM / 2), plane.lat(z));
      const west = field.heightAt(plane.lon(x - blockM / 2), plane.lat(z));
      const south = field.heightAt(plane.lon(x), plane.lat(z + blockM / 2));
      const north = field.heightAt(plane.lon(x), plane.lat(z - blockM / 2));
      if ([east, west, south, north].some(Number.isNaN)) continue;
      const run = Math.hypot((east - west) / blockM, (south - north) / blockM);
      if ((Math.atan(run) * 180) / Math.PI > FACE_DEG) steep[row * blockCols + col] = 1;
    }
  }

  const coastal = new Uint8Array(blockRows * blockCols);
  for (let row = 0; row < blockRows; row++) {
    for (let col = 0; col < blockCols; col++) {
      if (!straddles[row * blockCols + col] && !steep[row * blockCols + col]) continue;
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
  // A coast raised to the core has far blocks for neighbours, and a 4 m block
  // bent onto a 16 m chord drew Larvotto as a patchwork of slabs. A far block
  // beside a core one steps to the city, so the cell never jumps more than twice.
  const core = BELT_ORDER.indexOf("core");
  const far = BELT_ORDER.indexOf("far");
  const besideCore = (row: number, col: number): boolean => {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || c < 0 || r >= blockRows || c >= blockCols) continue;
        if (blockBelt[r * blockCols + c] === core) return true;
      }
    }
    return false;
  };
  for (let row = 0; row < blockRows; row++) {
    for (let col = 0; col < blockCols; col++) {
      const index = row * blockCols + col;
      if (blockBelt[index] === far && besideCore(row, col)) blockBelt[index] = BELT_ORDER.indexOf("city");
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

  const coarsestCellAt = (x: number, z: number): number => {
    let coarsest = 0;
    for (const dx of [-0.5, 0.5]) {
      for (const dz of [-0.5, 0.5]) {
        const cell = cellOfBlock(Math.floor((z - minZ + dz) / blockM), Math.floor((x - minX + dx) / blockM));
        if (cell > coarsest) coarsest = cell;
      }
    }
    return coarsest || BELT_CELL_M.core;
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
    // Boundary nodes take the coarse belt's chord, so the two sides cannot split.
    return coarsest > finest;
  };

  return { blockM, blockRows, blockCols, blockBelt, beltOfCell, conformsAt, coarsestCellAt };
}

/** Above this the ground is a face, not a slope, and a coarse cell aliases it. */
const FACE_DEG = 35;

/** Does this block have both land and water in it? */
function straddlesWater(
  field: HeightField,
  plane: ScenePlane,
  centreX: number,
  centreZ: number,
  sizeM: number,
  landAt?: (x: number, z: number) => number,
): boolean {
  let land = false;
  let water = false;
  let dry = false;
  let wet = false;
  const half = sizeM / 2;
  for (const dx of [-half, 0, half]) {
    for (const dz of [-half, 0, half]) {
      const value = field.heightAt(plane.lon(centreX + dx), plane.lat(centreZ + dz));
      if (Number.isNaN(value)) water = true;
      else land = true;
      if (landAt) {
        if (landAt(centreX + dx, centreZ + dz) > 0) dry = true;
        else wet = true;
      }
      if ((land && water) || (dry && wet)) return true;
    }
  }
  return false;
}

/** Faces disagreeing by more than this split their corner. Only a wall's foot keeps the edge. */
const TERRAIN_CREASE_DEG = 15;
/** The road's own ground. A tunnel's hill is not level across, so the vault is left out. */
const ROAD_HELD_M = DEFAULT_TRACK_HALF_WIDTH_M + DEFAULT_VERGE_M;
/**
 * The road level at a node, or NaN off it. Banks left under the ribbon poked through the tarmac.
 */
export function roadLevel(
  corridor: Corridor,
  field: HeightField,
  plane: ScenePlane,
  buried: (x: number, z: number) => boolean,
): (x: number, z: number) => number {
  return (x, z) => {
    const { distanceM, footX, footZ } = corridor.measure(x, z);
    if (distanceM > ROAD_HELD_M) return Number.NaN;
    const here = field.heightAt(plane.lon(x), plane.lat(z));
    const road = field.heightAt(plane.lon(footX), plane.lat(footZ));
    if (distanceM <= RIBBON_HALF_WIDTH_M && !buried(x, z)) return road;
    return Math.abs(here - road) < 0.5 ? here : Number.NaN;
  };
}

/** Within a cell of a retaining wall the crease stays sharp; a cliff shades like ground. */
export function atSurveyedWall(
  breaklines: Breaklines,
  plane: ScenePlane,
  x: number,
  z: number,
  cell: number,
): boolean {
  const lon = plane.lon(x);
  const lat = plane.lat(z);
  return (
    breaklines.crossesRetainingLonLat(plane.lon(x - cell), lat, plane.lon(x + cell), lat)
    || breaklines.crossesRetainingLonLat(lon, plane.lat(z - cell), lon, plane.lat(z + cell))
  );
}

/** Faces flatter than this count toward a vertex's light; steeper ones are a step, a skirt or a wall. */
const LIT_FACE_MIN_NY = 0.3;
/** Passes of averaging each lit place's normal with its neighbours'. */
const LIGHT_SMOOTH_PASSES = 3;

/** Area-weighted normals summed across belts, so both sides of a seam light the same. */
function smoothLight(parts: [Mesh, Uint8Array][]): void {
  const key = (x: number, z: number) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
  const sums = new Map<string, [number, number, number]>();
  const neighbours = new Map<string, Set<string>>();
  for (const [mesh] of parts) {
    const p = mesh.positions;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const wx = p[c * 3] - p[a * 3], wy = p[c * 3 + 1] - p[a * 3 + 1], wz = p[c * 3 + 2] - p[a * 3 + 2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const length = Math.hypot(nx, ny, nz);
      if (length < 1e-9) continue;
      // Wound either way, the ground faces up.
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      if (ny / length < LIT_FACE_MIN_NY) continue;
      if (Math.max(p[a * 3 + 1], p[b * 3 + 1], p[c * 3 + 1]) < 0) continue;
      const keys = [a, b, c].map((v) => key(p[v * 3], p[v * 3 + 2]));
      for (let i = 0; i < 3; i++) {
        const sum = sums.get(keys[i]);
        if (sum) { sum[0] += nx; sum[1] += ny; sum[2] += nz; }
        else sums.set(keys[i], [nx, ny, nz]);
        let around = neighbours.get(keys[i]);
        if (!around) neighbours.set(keys[i], (around = new Set()));
        around.add(keys[(i + 1) % 3]);
        around.add(keys[(i + 2) % 3]);
      }
    }
  }
  // A face is one cell of ripple; a vertex's own ring still turns the light
  // per cell on gentle ground. A pass or two over the neighbours' normals takes
  // that out and leaves the relief, which is wider than a ring.
  let normals = new Map<string, [number, number, number]>();
  for (const [k, sum] of sums) {
    const length = Math.hypot(...sum);
    normals.set(k, [sum[0] / length, sum[1] / length, sum[2] / length]);
  }
  for (let pass = 0; pass < LIGHT_SMOOTH_PASSES; pass++) {
    const next = new Map<string, [number, number, number]>();
    for (const [k, own] of normals) {
      const sum: [number, number, number] = [...own];
      for (const other of neighbours.get(k) ?? []) {
        const n = normals.get(other);
        if (n) { sum[0] += n[0]; sum[1] += n[1]; sum[2] += n[2]; }
      }
      const length = Math.hypot(...sum);
      next.set(k, [sum[0] / length, sum[1] / length, sum[2] / length]);
    }
    normals = next;
  }
  for (const [mesh, lit] of parts) {
    const p = mesh.positions;
    for (let v = 0; v < lit.length; v++) {
      if (!lit[v] || p[v * 3 + 1] < 0) continue;
      const normal = normals.get(key(p[v * 3], p[v * 3 + 2]));
      if (normal) [mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]] = normal;
    }
  }
}

/** Keys for the vertices the road adds, clear of every grid node's own. */
const ROAD_VERTEX_KEY = 1e12;

/**
 * Land at a point: distance to the surveyed shore where there is one, otherwise the
 * smoothed raster distance. Ground and mesh both read this.
 */
export function buildLandAt(
  field: HeightField,
  plane: ScenePlane,
  coast: Coastline,
  piers: PierResult,
): (x: number, z: number) => number {
  const rasterShore = buildShoreDistance(field);
  return (x, z) => {
    // The raster's copy of a deck is not land: it saw the pontoon and the boats, off
    // from where the ring is mapped. Keep only the deck.
    if (piers.clearsTerrain(x, z)) return -DECK_CLEARED_SCALAR_M;
    const surveyed = coast.signedDistance(x, z);
    const raster = rasterShore.at(plane.lon(x), plane.lat(z));
    const value = Number.isNaN(surveyed) ? raster : surveyed;
    if (value < 0 && value > -SURVEYED_HOLE_M && raster > RASTER_CONFIDENT_M) {
      return raster;
    }
    return value;
  };
}

function bakeTerrain(
  field: HeightField,
  ground: Ground,
  plane: ScenePlane,
  corridor: Corridor,
  rawScalarAt: (x: number, z: number) => number,
  /** Sharp turns of the surveyed line: the lip routes through these. */
  corners: { x: number; z: number }[],
  hollow: PortalHollow,
  breaklines: Breaklines,
  /** Where the viewer draws the road; its edges are edges of the core belt's mesh. */
  ribbon: Ribbon | null,
): TerrainResult {
  let conformed = 0;
  let worstConform = 0;
  let conformSum = 0;
  let conformOver1 = 0;
  let conformOver2 = 0;
  let holesFilled = 0;
  const meshes = {} as Record<Belt, Mesh>;
  const litByBelt = {} as Record<Belt, Uint8Array>;
  const plinth = createMesh();
  const cellsByBelt = { core: 0, city: 0, far: 0 } as Record<Belt, number>;

  const minX = plane.x(field.bbox.minLon);
  const maxX = plane.x(field.bbox.maxLon);
  const minZ = plane.z(field.bbox.maxLat); // north edge is the smaller Z
  const maxZ = plane.z(field.bbox.minLat);

  const ponds = findEnclosedWater(rawScalarAt, (x, z) => ground.at(x, z, "core"), minX, maxX, minZ, maxZ);
  holesFilled = ponds.cells;
  const inletsFilled = ponds.pinched;
  const isletsDrowned = ponds.islets;

  const blocks = buildBeltBlocks(field, plane, corridor, rawScalarAt);
  const { blockM, blockRows, blockCols, blockBelt, beltOfCell } = blocks;

  /**
   * A height for a node the terrain stands on. Where the raster says sea but the line
   * says land, take the nearest dry reading rather than ramping into the water.
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

  /** Metres from the shoreline at a belt's node: positive on land. */
  const landCache = {} as Record<Belt, Map<number, number>>;
  const landOn = (belt: Belt, row: number, col: number): number => {
    const cache = (landCache[belt] ??= new Map());
    const key = row * 1e6 + col;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const cell = BELT_CELL_M[belt];
    const x = minX + col * cell;
    const z = minZ + row * cell;
    const value = ponds.overrideAt(x, z) || rawScalarAt(x, z);
    cache.set(key, value);
    return value;
  };

  /**
   * The ground continues under the water as a falling seabed, so there is no edge to fall through.
   */
  const surfaceHeightOn = (belt: Belt, row: number, col: number): number => {
    const land = landOn(belt, row, col);
    if (land <= 0) return Math.max(SEABED_FLOOR_M, land * SEABED_SLOPE);
    // A node the line calls land and the raster sea borrows its neighbours'
    // height, which can be a clifftop's: it is held off the shore as the ground is.
    const solid = solidHeightOn(belt, row, col);
    const borrowed = Number.isNaN(ground.nodeAt(belt, row, col));
    return Math.max(borrowed ? Math.min(solid, ground.ceilingAt(belt, row, col)) : solid, WATER_CLEARANCE_M);
  };

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
   * The height a belt draws at its own node. On a boundary with a coarser belt it takes
   * the coarse belt's chord, or the seam becomes a step on flat ground.
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
    const cols = Math.round((rimEnd(minX, maxX) - minX) / cell);
    const rows = Math.round((rimEnd(minZ, maxZ) - minZ) / cell);
    const grid = new GridMesh();

    const ownHeightAt = (row: number, col: number): number => surfaceHeightOn(belt, row, col);

    /** This belt's drawn height, plus a count of what the boundary cost. */
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

    // The ribbon's edges, clipped to the core cells they cross. A cell a 4 m
    // grid splits on its diagonal cannot hold an edge that runs through it, and
    // the hillside beside the road ramped onto the tarmac within one cell.
    const roadInCell = new Map<number, number[][]>();
    if (ribbon && belt === "core") {
      for (const edge of ribbon.edges) {
        for (let i = 1; i < edge.length; i++) {
          const a = edge[i - 1];
          const b = edge[i];
          const c0 = Math.floor((Math.min(a.x, b.x) - minX) / cell);
          const c1 = Math.floor((Math.max(a.x, b.x) - minX) / cell);
          const r0 = Math.floor((Math.min(a.z, b.z) - minZ) / cell);
          const r1 = Math.floor((Math.max(a.z, b.z) - minZ) / cell);
          for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
              const piece = clipToCell(a, b, minX + c * cell, minZ + r * cell, cell);
              if (!piece) continue;
              const key = r * (cols + 2) + c;
              const list = roadInCell.get(key);
              if (list) list.push(piece);
              else roadInCell.set(key, [piece]);
            }
          }
        }
      }
    }
    // Shared by position, so two cells that meet on an edge meet at its points.
    const roadVertices = new Map<string, number>();
    const roadVertex = (x: number, y: number, z: number): number => {
      const key = `${x.toFixed(3)},${z.toFixed(3)}`;
      let id = roadVertices.get(key);
      if (id === undefined) {
        id = grid.vertex(ROAD_VERTEX_KEY + roadVertices.size, x, y, z);
        roadVertices.set(key, id);
      }
      return id;
    };
    const splitByRoad = (row: number, col: number, pieces: number[][]): boolean => {
      const x0 = minX + col * cell;
      const z0 = minZ + row * cell;
      const x1 = x0 + cell;
      const z1 = z0 + cell;
      const corners: [number, number, number][] = [
        [x0, z0, vertexAt(row, col)],
        [x0, z1, vertexAt(row + 1, col)],
        [x1, z1, vertexAt(row + 1, col + 1)],
        [x1, z0, vertexAt(row, col + 1)],
      ];
      const points: [number, number][] = [];
      const ids: number[] = [];
      const local = (x: number, y: number, z: number): number => {
        // A point on a corner is the corner: two vertices there would crack.
        for (const [cx, cz, id] of corners) {
          if (Math.abs(cx - x) < 0.05 && Math.abs(cz - z) < 0.05) return addLocal(cx, cz, id);
        }
        return addLocal(x, z, roadVertex(x, y, z));
      };
      const addLocal = (x: number, z: number, id: number): number => {
        const found = ids.indexOf(id);
        if (found >= 0) return found;
        points.push([x, z]);
        ids.push(id);
        return points.length - 1;
      };
      for (const [x, z, id] of corners) addLocal(x, z, id);
      const constraints: [number, number][] = [];
      for (const [ax, ay, az, bx, by, bz] of pieces) {
        const a = local(ax, ay, az);
        const b = local(bx, by, bz);
        if (a !== b) constraints.push([a, b]);
      }
      // The cell's own rim, through every point that landed on it, so the
      // neighbour across each side sees the same points.
      const sides: [(p: [number, number]) => boolean, (p: [number, number]) => number][] = [
        [(p) => Math.abs(p[0] - x0) < 1e-3, (p) => p[1]],
        [(p) => Math.abs(p[1] - z1) < 1e-3, (p) => p[0]],
        [(p) => Math.abs(p[0] - x1) < 1e-3, (p) => p[1]],
        [(p) => Math.abs(p[1] - z0) < 1e-3, (p) => p[0]],
      ];
      for (const [on, along] of sides) {
        const rim = points.map((p, i) => i).filter((i) => on(points[i]));
        rim.sort((i, j) => along(points[i]) - along(points[j]));
        for (let i = 1; i < rim.length; i++) constraints.push([rim[i - 1], rim[i]]);
      }
      let triangles: [number, number, number][];
      try {
        triangles = cdt2d(points, constraints);
      } catch {
        return false;
      }
      if (!triangles.length) return false;
      for (const [a, b, c] of triangles) {
        const area =
          (points[b][0] - points[a][0]) * (points[c][1] - points[a][1])
          - (points[b][1] - points[a][1]) * (points[c][0] - points[a][0]);
        if (Math.abs(area) < 1e-9) continue;
        // The grid's own winding, (x0,z0) → (x0,z1) → (x1,z1), is negative here.
        if (area < 0) grid.triangle(ids[a], ids[b], ids[c]);
        else grid.triangle(ids[a], ids[c], ids[b]);
      }
      return true;
    };

    /** Sharp surveyed corners by the cell that holds them, so the lip can miter through them. */
    const cornerCells = new Map<number, { x: number; z: number }[]>();
    for (const corner of corners) {
      const key = Math.floor((corner.z - minZ) / cell) * (cols + 2) + Math.floor((corner.x - minX) / cell);
      const list = cornerCells.get(key);
      if (list) list.push(corner);
      else cornerCells.set(key, [corner]);
    }
    /** Keys for the vertices a surveyed corner adds, clear of every other kind's. */
    const CORNER_VERTEX_KEY = 3e12;
    /** How far in from its cell's edges a corner has to be: one on an edge would leave the neighbour's edge straight. */
    const CORNER_MARGIN_M = 0.25;
    /**
     * The surveyed corner nearest a cell's lip. Without it the lip cuts the corner and leaves a
     * tooth.
     */
    const shoreCorner = (row: number, col: number, inTop: number, outTop: number): [number, number] | null => {
      const p = grid.mesh.positions;
      const ax = p[inTop * 3], az = p[inTop * 3 + 2];
      const abx = p[outTop * 3] - ax, abz = p[outTop * 3 + 2] - az;
      const lengthSquared = abx * abx + abz * abz;
      if (lengthSquared < 1e-9) return null;
      const x0 = minX + col * cell + CORNER_MARGIN_M, x1 = minX + (col + 1) * cell - CORNER_MARGIN_M;
      const z0 = minZ + row * cell + CORNER_MARGIN_M, z1 = minZ + (row + 1) * cell - CORNER_MARGIN_M;
      let best: { x: number; z: number } | null = null;
      let bestDistance = cell / 2;
      for (const corner of cornerCells.get(row * (cols + 2) + col) ?? []) {
        if (corner.x < x0 || corner.x > x1 || corner.z < z0 || corner.z > z1) continue;
        const t = ((corner.x - ax) * abx + (corner.z - az) * abz) / lengthSquared;
        if (t <= 0.05 || t >= 0.95) continue;
        const distance = Math.hypot(corner.x - (ax + abx * t), corner.z - (az + abz * t));
        if (distance < bestDistance) {
          best = corner;
          bestDistance = distance;
        }
      }
      if (!best) return null;
      const surface = ground.at(best.x, best.z, belt);
      const ends = Math.max(p[inTop * 3 + 1], p[outTop * 3 + 1]);
      const topY = Math.max(WATER_CLEARANCE_M, Math.min(Number.isNaN(surface) ? ends : surface, SHORE_LIP_M));
      const key = CORNER_VERTEX_KEY + (Math.round(best.x * 4) + 20000) * 50000 + Math.round(best.z * 4) + 20000;
      return [grid.vertex(key, best.x, topY, best.z), grid.vertex(key + 1, best.x, SHORE_FOOT_M, best.z)];
    };

    /**
     * Where the shore crosses a cell edge. Both neighbouring cells share it, so the step cannot
     * part.
     */
    const shoreVertices = (rowA: number, colA: number, sA: number, rowB: number, colB: number, sB: number): [number, number] => {
      const key =
        SHORE_VERTEX_KEY
        + 4 * (Math.min(rowA, rowB) * (cols + 2) + Math.min(colA, colB))
        + (rowA === rowB ? 0 : 2);
      const t = sA / (sA - sB);
      const x = minX + (colA + (colB - colA) * t) * cell;
      const z = minZ + (rowA + (rowB - rowA) * t) * cell;
      const dry = sA > 0 ? surfaceHeightAt(rowA, colA) : surfaceHeightAt(rowB, colB);
      return [
        grid.vertex(key, x, Math.min(dry, SHORE_LIP_M), z),
        grid.vertex(key + 1, x, SHORE_FOOT_M, z),
      ];
    };

    /**
     * A cell the shore crosses: land side, a step down at the line, then seabed, so the
     * waterline follows the shore instead of wherever a slope met the sea plane.
     */
    const splitByShore = (row: number, col: number, lands: number[]): void => {
      const dryAt = (i: number) => lands[i % 4] > 0;
      const shore = walk.map(([dr, dc], i) => {
        if (dryAt(i) === dryAt(i + 1)) return null;
        const [nr, nc] = walk[(i + 1) % 4];
        return shoreVertices(row + dr, col + dc, lands[i], row + nr, col + nc, lands[(i + 1) % 4]);
      });

      // One run of land may miter its lip through a surveyed corner; a saddle's
      // two runs keep their straight lips.
      const runs = [0, 1, 2, 3].filter((i) => dryAt(i) && !dryAt(i + 3));
      const one = runs.length === 1 ? runs[0] : -1;
      let corner: [number, number] | null = null;
      let oneEnd = one;
      if (one >= 0) {
        while (dryAt(oneEnd)) oneEnd++;
        corner = shoreCorner(row, col, shore[(one + 3) % 4]![0], shore[(oneEnd - 1) % 4]![0]);
      }

      // The sea side, fanned from the corner's foot where there is one: it
      // sits on the lip between the run's two feet, so the fan stays inside.
      const wet: number[] = [];
      for (let i = 0; i < 4; i++) {
        if (!dryAt(i)) wet.push(vertexAt(row + walk[i][0], col + walk[i][1]));
        const pair = shore[i];
        if (pair) wet.push(pair[1]);
      }
      if (corner) {
        const inAt = wet.indexOf(shore[(one + 3) % 4]![1]);
        wet.splice(0, wet.length, corner[1], ...wet.slice(inAt + 1), ...wet.slice(0, inAt + 1));
      }
      for (let i = 1; i < wet.length - 1; i++) grid.triangle(wet[0], wet[i], wet[i + 1]);

      // Each run of dry corners is its own piece of land, from the line it
      // comes in across to the line it goes out across.
      for (const start of runs) {
        const [inTop, inFoot] = shore[(start + 3) % 4]!;
        const dry = [inTop];
        let end = start;
        while (dryAt(end)) {
          dry.push(vertexAt(row + walk[end % 4][0], col + walk[end % 4][1]));
          end++;
        }
        const [outTop, outFoot] = shore[(end - 1) % 4]!;
        dry.push(outTop);
        const landRow = row + walk[start][0];
        const landCol = col + walk[start][1];
        if (!corner) {
          for (let i = 1; i < dry.length - 1; i++) grid.triangle(dry[0], dry[i], dry[i + 1]);
          addStep(inTop, inFoot, outTop, outFoot, landRow, landCol);
          continue;
        }
        // The corner closes the run between its two lips; fanned from it, the
        // land covers its cell whichever side of the straight lip it stands.
        for (let i = 0; i < dry.length - 1; i++) grid.triangle(corner[0], dry[i], dry[i + 1]);
        addStep(inTop, inFoot, corner[0], corner[1], landRow, landCol);
        addStep(corner[0], corner[1], outTop, outFoot, landRow, landCol);
      }
    };

    /** The step under the shoreline, wound to face away from the land at (`landRow`, `landCol`). */
    const addStep = (
      topA: number, footA: number, topB: number, footB: number,
      landRow: number, landCol: number,
    ): void => {
      const p = grid.mesh.positions;
      const ax = p[topA * 3], az = p[topA * 3 + 2];
      const alongX = p[topB * 3] - ax;
      const alongZ = p[topB * 3 + 2] - az;
      const landX = minX + landCol * cell - ax;
      const landZ = minZ + landRow * cell - az;
      // The face (top A, foot A, foot B) faces (-alongZ, alongX).
      if (alongX * landZ - alongZ * landX < 0) {
        grid.triangle(topA, footA, footB);
        grid.triangle(topA, footB, topB);
      } else {
        grid.triangle(topB, footB, footA);
        grid.triangle(topB, footA, topA);
      }
    };

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

        const heights = walk.map(([dr, dc]) => surfaceHeightAt(row + dr, col + dc));
        // Seabed wholly under the opaque sea plane is never seen.
        if (heights.every((h) => h < SEABED_HIDDEN_M)) continue;

        const lands = walk.map(([dr, dc]) => landOn(belt, row + dr, col + dc));
        if (lands.some((s) => s > 0) && lands.some((s) => s <= 0)) {
          splitByShore(row, col, lands);
          cellsByBelt[belt]++;
          continue;
        }

        // The road is land's: a ribbon edge over the sea is a chord the
        // centreline closes across a window, not a road.
        const pieces = lands.every((s) => s > 0) ? roadInCell.get(row * (cols + 2) + col) : undefined;
        // A cell on a seam is drawn on the coarse belt's chord; splitting it
        // would put points on that chord the coarse side does not have.
        const onSeam = pieces && walk.some(([dr, dc]) => blocks.conformsAt(minX + (col + dc) * cell, minZ + (row + dr) * cell));
        if (!pieces || onSeam || !splitByRoad(row, col, pieces)) {
          const a = vertexAt(row, col), b = vertexAt(row + 1, col);
          const c = vertexAt(row + 1, col + 1), d = vertexAt(row, col + 1);
          const y = (id: number) => grid.mesh.positions[id * 3 + 1];
          if (splitsOnMain(y(a), y(b), y(c), y(d))) {
            grid.triangle(a, b, c);
            grid.triangle(a, c, d);
          } else {
            grid.triangle(a, b, d);
            grid.triangle(b, c, d);
          }
        }
        cellsByBelt[belt]++;
      }
    }

    const mesh = grid.finish(TERRAIN_CREASE_DEG);
    // The band kept at a surveyed line keeps its crease; everything else is
    // lit by the faces around it, once every belt is drawn (`smoothLight`).
    const vertices = mesh.positions.length / 3;
    const lit = new Uint8Array(vertices);
    for (let v = 0; v < vertices; v++) {
      const x = mesh.positions[v * 3];
      const z = mesh.positions[v * 3 + 2];
      if (!atSurveyedWall(breaklines, plane, x, z, BELT_CELL_M.core)) lit[v] = 1;
    }
    litByBelt[belt] = lit;
    addVoidWalls(mesh, voidCells, built, hollow, surfaceHeightAt, minX, minZ, cell, cols);
    addTerrainSkirts(mesh, surfaceHeightAt, beltOfCell, belt, minX, minZ, cell, rows, cols);
    addPlinth(plinth, surfaceHeightAt, (row, col) => beltOfCell(row, col, cell) === belt, minX, minZ, cell, rows, cols);
    if (belt === "far") addPlinthFloor(plinth, minX, minZ, minX + cols * cell, minZ + rows * cell);
    meshes[belt] = mesh;
  }
  smoothLight(BELT_ORDER.map((belt) => [meshes[belt], litByBelt[belt]]));

  return {
    meshes,
    blocks,
    plinth,
    cellsByBelt,
    holesFilled,
    inletsFilled,
    isletsDrowned,
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
 * Walls round the pit a portal cuts out of the hillside, built from the dropped
 * cells' own rim, so they cannot come out shorter than the hole.
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
      // The two grid nodes the dropped cell and its neighbour share. A rim across the
      // bore would wall off the road, and the sleeve covers that stretch.
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
 * One belt's stretch of the wall round the block, down to the floor. The top is
 * that belt's rim vertex, or the datum where the rim is sea.
 */
function addPlinth(
  mesh: Mesh,
  surfaceHeightAt: (row: number, col: number) => number,
  /** Whether a rim cell is this belt's: each belt walls its own stretch, from its own rim. */
  owns: (row: number, col: number) => boolean,
  minX: number,
  minZ: number,
  cell: number,
  rows: number,
  cols: number,
): void {
  const top = (row: number, col: number): number => Math.max(surfaceHeightAt(row, col), 0);
  const xAt = (col: number): number => minX + col * cell;
  const zAt = (row: number): number => minZ + row * cell;

  // Each wall is wound so its face looks away from the model.
  for (let col = 0; col < cols; col++) {
    const x0 = xAt(col);
    const x1 = xAt(col + 1);
    const north = zAt(0);
    const south = zAt(rows);
    if (owns(0, col)) {
      const n0 = top(0, col);
      const n1 = top(0, col + 1);
      addFlatQuad(mesh, x0, n0, north, x1, n1, north, x1, PLINTH_FLOOR_M, north, x0, PLINTH_FLOOR_M, north);
    }
    if (owns(rows - 1, col)) {
      const s0 = top(rows, col);
      const s1 = top(rows, col + 1);
      addFlatQuad(mesh, x1, s1, south, x0, s0, south, x0, PLINTH_FLOOR_M, south, x1, PLINTH_FLOOR_M, south);
    }
  }
  for (let row = 0; row < rows; row++) {
    const z0 = zAt(row);
    const z1 = zAt(row + 1);
    const west = xAt(0);
    const east = xAt(cols);
    if (owns(row, 0)) {
      const w0 = top(row, 0);
      const w1 = top(row + 1, 0);
      addFlatQuad(mesh, west, w1, z1, west, w0, z0, west, PLINTH_FLOOR_M, z0, west, PLINTH_FLOOR_M, z1);
    }
    if (owns(row, cols - 1)) {
      const e0 = top(row, cols);
      const e1 = top(row + 1, cols);
      addFlatQuad(mesh, east, e0, z0, east, e1, z1, east, PLINTH_FLOOR_M, z1, east, PLINTH_FLOOR_M, z0);
    }
  }
}

/** The block's floor: two triangles nobody sees, but a block with an open bottom is not a block. */
function addPlinthFloor(mesh: Mesh, minX: number, minZ: number, maxX: number, maxZ: number): void {
  addFlatQuad(
    mesh,
    minX, PLINTH_FLOOR_M, minZ,
    maxX, PLINTH_FLOOR_M, minZ,
    maxX, PLINTH_FLOOR_M, maxZ,
    minX, PLINTH_FLOOR_M, maxZ,
  );
}

/** A vertical drop on every edge whose neighbour belongs to another belt or lies past the bbox. */
function addTerrainSkirts(
  mesh: Mesh,
  /** The height the surface was built at, or the skirt hangs from where the ground is not. */
  surfaceHeightAt: (row: number, col: number) => number,
  beltOfCell: (row: number, col: number, cell: number) => Belt,
  belt: Belt,
  minX: number,
  minZ: number,
  cell: number,
  rows: number,
  cols: number,
): void {
  // Off the grid altogether is the outside of the model, and that edge is the
  // plinth's: a hem there would hang in the block's own wall and flicker with it.
  const offGrid = (row: number, col: number): boolean =>
    row < 0 || col < 0 || row >= rows || col >= cols;

  const built = (row: number, col: number): boolean =>
    !offGrid(row, col) && beltOfCell(row, col, cell) === belt;

  const first = mesh.normals.length;
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

      if (!built(row - 1, col) && !offGrid(row - 1, col)) {
        addFlatQuad(mesh, x0, h00, z0, x1, h10, z0, x1, h10 - SKIRT_M, z0, x0, h00 - SKIRT_M, z0);
      }
      if (!built(row + 1, col) && !offGrid(row + 1, col)) {
        addFlatQuad(mesh, x1, h11, z1, x0, h01, z1, x0, h01 - SKIRT_M, z1, x1, h11 - SKIRT_M, z1);
      }
      if (!built(row, col - 1) && !offGrid(row, col - 1)) {
        addFlatQuad(mesh, x0, h01, z1, x0, h00, z0, x0, h00 - SKIRT_M, z0, x0, h01 - SKIRT_M, z1);
      }
      if (!built(row, col + 1) && !offGrid(row, col + 1)) {
        addFlatQuad(mesh, x1, h10, z0, x1, h11, z1, x1, h11 - SKIRT_M, z1, x1, h10 - SKIRT_M, z0);
      }
    }
  }
  // The seam between two belts is a hairline, and through it a skirt lit as a
  // wall drew Larvotto as brickwork. Lit as the ground it hangs from, it is not seen.
  for (let i = first; i < mesh.normals.length; i += 3) {
    mesh.normals[i] = 0;
    mesh.normals[i + 1] = 1;
    mesh.normals[i + 2] = 0;
  }
}

/**
 * Where the model ends on its far sides: the far belt's last whole cell. Every belt
 * and the sea stop there, at the plinth.
 */
function rimEnd(start: number, end: number): number {
  return start + Math.floor((end - start) / BELT_CELL_M.far) * BELT_CELL_M.far;
}

/** The ground the model covers: the bbox, cut back on its far sides to `rimEnd`. */
function modelRim(field: HeightField, plane: ScenePlane): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const minX = plane.x(field.bbox.minLon);
  const minZ = plane.z(field.bbox.maxLat);
  return {
    minX,
    maxX: rimEnd(minX, plane.x(field.bbox.maxLon)),
    minZ,
    maxZ: rimEnd(minZ, plane.z(field.bbox.minLat)),
  };
}

// water
/** One quad at sea level. The terrain's edge is the coastline, so the water needs none. */
function bakeWater(field: HeightField, plane: ScenePlane): Mesh {
  const mesh = createMesh();
  const { minX: x0, maxX: x1, minZ: z0, maxZ: z1 } = modelRim(field, plane);
  addFlatQuad(mesh, x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0);
  return mesh;
}

/** Pontoon decks extruded from their mapped rings, walled down to the skirt's foot. */
function bakePierDecks(piers: PierResult): Mesh {
  const mesh = createMesh();
  for (const deck of piers.decks) {
    const foot = Math.min(SHORE_FOOT_M, deck.deckY - 1);
    extrude(mesh, deck.ring, deck.ring.map(() => foot), deck.deckY);
  }
  return mesh;
}

// buildings
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

interface BuildingResult {
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

function prepareBuildings(
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

function bakeBuildings(
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

function extrude(
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

// tunnel portals
/** Half the opening. Wider than the road, the way a real portal is. */
const PORTAL_HALF_WIDTH_M = 7;
/** Springing height of the arch, and the crown above it. */
const PORTAL_WALL_M = 3;
const PORTAL_ARCH_M = 3.5;
/** Least width of the headwall around the opening — what makes it read as a
 *  portal — and how far it may grow looking for the ground to meet. */
const PORTAL_SURROUND_M = 2.5;
/**
 * Half width of the void at a mouth and the face that closes it. The real hole runs
 * half a cell wider, so the face must be bigger.
 */
const PORTAL_VOID_HALF_M = PORTAL_HALF_WIDTH_M;
const PORTAL_FACE_HALF_M = PORTAL_HALF_WIDTH_M + 5;
/** Same margin fore and aft: the void starts inside the front face and ends
 *  before the back one. */
const PORTAL_VOID_PAD_M = 3;
/**
 * How far the cutting runs out in front of a mouth, at road level. Without it the
 * hill buries the arch's lower half.
 */
const PORTAL_APPROACH_M = 16;
/** How far the cutting's floor reaches past the void it fills — half a core cell,
 *  plus a little, since a cell is dropped on its centre. */
const PORTAL_CUT_MARGIN_M = 2.5;
/**
 * How far the sleeve stands out of the face. The ramp to the hill can start up to
 * a cell early, so the collar covers it.
 */
const PORTAL_OUT_M = 5;
/** Wall thickness of the sleeve — what the ring at the mouth shows of itself. */
const PORTAL_RING_M = 0.8;
/**
 * The sleeve reaches past the pit it stands in, so the mouth shows dark tube
 * instead of the pit's lit far wall.
 */
const PORTAL_IN_M = 14;
const PORTAL_ARCH_SEGMENTS = 8;
/** How finely the lid over the cutting follows the hill it replaces. */
const PORTAL_LID_STEPS = 4;

/**
 * A portal is a short arched sleeve at each mouth. A height field cannot hold a
 * cavity, so the opening is what sells the tunnel.
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
 * Cells the terrain must not fill over the arch. The ground between the cut floor and
 * the hill is drawn as a ramp through the opening, so it has to go.
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
  /** Cuttings that buildings must stay out of. A block stands over Monaco's inland mouth. */
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

      // Scale the arch to fit under the lowest cover the sleeve passes, measured inward
      // from the face only, or the crown pokes out of the slope.
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

      // Road under the sleeve. The bore's floor starts further in, so the mouth was black.
      {
        // As wide as the cutting, or the trench shows the sea. Wider than nominal because
        // cells drop by their centre.
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

      // A second, outward skin joined by a flat ring at the front, so from outside the
      // portal reads as a tube with a hole instead of an invisible film.
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
      // The outer skin runs the sleeve's whole length, so the eye does not land on the pit wall.
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

      // The headwall closes the cutting and the void behind it: a face at each end with
      // the arch cut out, and a wall down each side.
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

      // A lid over the void that follows the hill, so from above the excavation is not a
      // black rectangle or a flat grey plate.
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

      // Cap the sleeve's far end, or the eye runs through the culled hill to the sky.
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
 * The buried stretch with real hill over it. Under buildings the DTM reads the ground,
 * not the roof, so the vault follows cover instead of the OSM tag.
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
 * Where the vault goes and the ground is left alone. Mouths move inward to where the
 * hill fits a full portal, without splitting the run in two.
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
 * The bore: floor, walls and vault along the buried lap, swept along its axis since
 * it is only ever seen through a mouth.
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
      // The section ducks under whatever cover there is; a lower crown costs nothing seen
      // along the axis.
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

// barriers
/** Clear of the racing surface, where a barrier actually stands. */
const BARRIER_OFFSET_M = 1.2;
const BARRIER_HEIGHT_M = 1.05;
const BARRIER_THICKNESS_M = 0.3;

/** Barriers along a street circuit, one mesh in the core belt. None inside the tunnel. */
function bakeBarriers(
  field: HeightField,
  plane: ScenePlane,
  tunnels: TunnelMask,
  halfWidthM: number,
  /** Distance to the nearest stretch of the lap, whichever leg it is. */
  fromTrack: (x: number, z: number) => number,
): Mesh {
  const mesh = createMesh();
  const { coords, elevations } = field.trackProfile;
  const offset = halfWidthM + BARRIER_OFFSET_M;
  // On the inside of a hairpin, or beside a parallel leg, the offset lands on
  // the road; that run of steel was drawn across the asphalt.
  const onRoad = (x: number, z: number) => fromTrack(x, z) < offset - BARRIER_THICKNESS_M;

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
      if (onRoad(cx0, cz0) || onRoad(cx1, cz1) || onRoad((cx0 + cx1) / 2, (cz0 + cz1) / 2)) continue;
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

// track
/**
 * The track's height along its centreline, one value per vertex. The runtime still
 * builds the ribbon and needs to know where the ground ended up.
 */
/**
 * Index spans of the centreline that run underground, so the runtime skips drawing
 * the ribbon there instead of fighting the depth buffer.
 */
function buriedSpans(
  plane: ScenePlane,
  field: HeightField,
  vaults: VaultedRuns,
): [number, number][] {
  // Walk the 3 m profile, not the drawn centreline: its sparse tunnel vertices left
  // 51 m of ribbon inside the hill.
  const points = field.trackProfile.coords;
  if (points.length < 2) return [];

  // Fractions of lap length, not vertex count; vertex spacing varies by who drew it.
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

  // Hide the ribbon exactly where the vault covers the road. The tag and raw cover
  // both hid it while the car was still in the open.
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

// GLB
/** glTF base colour is linear; the palette is written the way CSS reads it. */
function srgbToLinear(hex: string): [number, number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(16), channel(8), channel(0), 1];
}

/** Meshes whose edges meet another file's share one quantisation lattice, or seams crack. */
const SEAMED_KINDS: ReadonlySet<MeshKind> = new Set(["terrain", "plinth"]);

/** The box every seamed mesh is quantised on: its centre and half its widest side. */
interface Lattice {
  offset: [number, number, number];
  scale: number;
}

function latticeOf(meshes: Mesh[]): Lattice {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i++) {
      const axis = i % 3;
      if (mesh.positions[i] < min[axis]) min[axis] = mesh.positions[i];
      if (mesh.positions[i] > max[axis]) max[axis] = mesh.positions[i];
    }
  }
  const offset = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2) as Lattice["offset"];
  const scale = Math.max(...[0, 1, 2].map((axis) => (max[axis] - min[axis]) / 2));
  return { offset, scale };
}

async function writeGlb(
  path: string,
  parts: { kind: MeshKind; mesh: Mesh }[],
  lattice: Lattice,
): Promise<number> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();

  const add = (kind: MeshKind, mesh: Mesh, positions: Float32Array<ArrayBuffer> | Int16Array<ArrayBuffer>) => {
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
        document
          .createAccessor()
          .setType("VEC3")
          .setArray(positions)
          .setNormalized(positions instanceof Int16Array)
          .setBuffer(buffer),
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

    const node = document.createNode(kind).setMesh(document.createMesh(kind).addPrimitive(primitive));
    scene.addChild(node);
    return node;
  };

  for (const { kind, mesh } of parts) {
    if (!isEmpty(mesh) && !SEAMED_KINDS.has(kind)) add(kind, mesh, new Float32Array(mesh.positions));
  }
  await MeshoptEncoder.ready;
  await document.transform(meshopt({ encoder: MeshoptEncoder }));

  // Quantised here rather than by `meshopt`, which would fit each its own box:
  // 14 bits spread over the int16 the way `quantize` stores them.
  const { offset, scale } = lattice;
  for (const { kind, mesh } of parts) {
    if (isEmpty(mesh) || !SEAMED_KINDS.has(kind)) continue;
    const positions = new Int16Array(mesh.positions.length);
    for (let i = 0; i < positions.length; i++) {
      const value = (mesh.positions[i] - offset[i % 3]) / scale;
      const step = Math.round(Math.min(1, Math.abs(value)) * 8191);
      positions[i] = Math.sign(value) * ((step << 2) | (step >> 11));
    }
    add(kind, mesh, positions).setTranslation(offset).setScale([scale, scale, scale]);
  }
  document.createExtension(KHRMeshQuantization).setRequired(true);
  await document.transform(
    quantize({ pattern: /^COLOR_0$/ }),
    reorder({ encoder: MeshoptEncoder, target: "size" }),
  );

  const glb = await new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder })
    .writeBinary(document);
  await writeFile(path, glb);
  return glb.byteLength;
}

// run
export interface BakeReport {
  circuitId: string;
  belts: Record<Belt, { bytes: number; triangles: number; drawCalls: number }>;
  buildings: BuildingResult;
  cellsByBelt: Record<Belt, number>;
  conform: TerrainResult["conform"];
  holesFilled: number;
  inletsFilled: number;
  isletsDrowned: number;
  trackVertices: number;
  portalTriangles: number;
  barrierTriangles: number;
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
 * Everything the bake reads from outside. Nothing below fetches, so the same pipeline
 * runs on a circuit and on a committed fixture.
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
  /** The street network: what the town's ground is built to. */
  streetWays: StreetWay[];
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
  // Use a surface model only if the raster came back with data; providers claim boxes
  // they hold nothing for.
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
    streetWays: await fetchStreetWays(circuitId, bbox, refresh),
    overrides: await loadOverrides(circuitId),
    // Kit house packs, switched off: a stretched model reads as a different city. The
    // list is the switch.
    kitHouses: await loadKitHouses(REPO_ROOT, []),
    kitTrees: await loadKitPaths(REPO_ROOT, "assets/models/kenney-city-suburban", ["tree-"]),
    // Switched off for the same reason: a kit's painted speedboat among the
    // harbour's white yachts was a toy in somebody else's colours. The short
    // berths take the parametric yacht at their own length instead.
    kitBoats: await loadKitPaths(REPO_ROOT, "assets/models/kenney-watercraft", []),
  };
}

/**
 * Everything the bake and the audit both need, built once from one recipe so they
 * cannot disagree.
 */
export interface CircuitGround {
  circuitId: string;
  overrides: CityOverrides | null;
  overrideStats: OverrideStats;
  coords: [number, number][];
  bbox: ReturnType<typeof circuitBBox>;
  plane: ScenePlane;
  field: HeightField;
  /** The ground before cuttings were burned in. The portal is sized against this. */
  hill: HeightField;
  corridor: ReturnType<typeof buildCorridor>;
  tunnels: TunnelMask;
  vaults: VaultedRuns;
}

export function buildCircuitGround(inputs: BakeInputs): CircuitGround {
  const { circuitId, coords, bbox, dtm, structures, overrides } = inputs;
  const plane = scenePlaneFor(coords);
  // The surveyed lines, indexed on the raster so the burn can stop at them.
  const lines = buildBreaklines(dtm.header, inputs.breaklineWays, inputs.shoreWays);
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

  // Two passes: the first keeps the whole tagged tunnel unburned to measure the hill,
  // the second burns in the approaches as cuttings.
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
      walls: lines.crossesLonLat,
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
  const { circuitId, buildingWays, greenWays, breaklineWays, streetWays, mnh, kitHouses, kitBoats, kitTrees } =
    inputs;
  const { coords, plane, field, hill, corridor, tunnels, vaults, overrides, overrideStats } =
    buildCircuitGround(inputs);
  const shoreWays = overrideShoreWays(inputs.shoreWays, overrides, overrideStats);
  const coast = buildCoastline(shoreWays, field, plane);
  const piers = buildPiers(shoreWays, field, plane);
  const pierDecks = bakePierDecks(piers);

  const elevations = trackElevations(field, coords, plane);
  const portals = bakePortals(vaults, hill, plane);
  const bore = bakeTunnelBody(hill, plane, vaults, portalSection());
  const barriers = bakeBarriers(field, plane, tunnels, DEFAULT_TRACK_HALF_WIDTH_M, (x, z) => corridor.distance(x, z));
  // The surveyed lines the belts' filter may not average across: cliffs and
  // retaining walls from their own query, quays and breakwaters from the shore.
  const breaklines = buildBreaklines(field, breaklineWays, shoreWays);
  // Where there is land at all: a walkway along a pontoon is not ground whose
  // level the town sets, and laying one serrated the quays.
  const shoreDistance = buildShoreDistance(field);
  const landAt = (x: number, z: number): number => {
    const surveyed = coast.signedDistance(x, z);
    return Number.isNaN(surveyed) ? shoreDistance.at(plane.lon(x), plane.lat(z)) : surveyed;
  };
  // The town's own levels, from the street network the audit reads too.
  const streets = buildStreetGround(
    streetWays,
    coords,
    field,
    plane,
    breaklines,
    landAt,
  );
  const terrainLand = buildLandAt(field, plane, coast, piers);
  const ground = buildGround(
    field, plane, breaklines, streets,
    roadLevel(corridor, field, plane, (x, z) => tunnels.buried(plane.lon(x), plane.lat(z))),
    terrainLand,
  );
  const hollow = portalVoids(vaults, hill, plane);
  // The road as the viewer draws it, so the ground meets the ribbon at its edge.
  const lapLengthM = (await circuitLengthM(circuitId))
    ?? coords.slice(1).reduce((sum, [lon, lat], i) =>
      sum + Math.hypot(plane.x(lon) - plane.x(coords[i][0]), plane.z(lat) - plane.z(coords[i][1])), 0);
  const ribbon = buildRibbon(coords, elevations, plane, lapLengthM, (x, z) =>
    tunnels.buried(plane.lon(x), plane.lat(z)));
  const terrain = bakeTerrain(field, ground, plane, corridor, terrainLand, coast.corners, hollow, breaklines, ribbon);
  const water = bakeWater(field, plane);

  const buildingsFile = applyBuildingOverrides(
    fromOverpass(buildingWays),
    overrides,
    overrideStats,
  );
  const heightStats = { value: { measured: 0, fellBack: 0, medianDeltaM: 0, tallest: 0 } };
  const measured = measureBuildingHeights(buildingsFile.buildings, mnh, heightStats);
  const buildings = emptyBuildingResult();
  // The drawn surface is the one truth: walls ask for the triangle they will stand on.
  const drawnGround = buildSurfaceIndex(BELT_ORDER.map((belt) => [terrain.meshes[belt]]));
  // The seabed is drawn but is no ground: nothing is built or planted on it.
  const standOn = (x: number, z: number): number => {
    const y = drawnGround.at(x, z);
    return y < 0 ? Number.NaN : y;
  };
  // Only where the road is actually drawn: a building over a tunnel is a
  // building over a tunnel, and cutting a slot through it would open the hill.
  const roadIndex = buildRoadIndex(
    field.trackProfile.coords
      .filter(([lon, lat]) => !vaults.covers(lon, lat))
      .map(([lon, lat]) => ({ x: plane.x(lon), z: plane.z(lat) })),
  );
  // After the terrain, because these lie on the ground that is drawn rather
  // than on the field the belts filtered.
  const greenery = buildGreenery(greenWays, standOn, plane, (x, z) => corridor.distance(x, z) >= TRACK_CLEARANCE_M);
  const greeneryStats = { ...greenery.stats };

  const prepared = prepareBuildings(
    buildingsFile, standOn, plane, corridor, hollow, roadIndex, measured, buildings, piers.decks, modelRim(field, plane),
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
    Math.round(BELT_BUDGET.city.triangles * KIT_BUDGET_SHARE),
  );
  const kitHousePaths = new Set(kitHouses.map((model) => model.path));
  bakeBuildings(prepared, buildings, kit.taken);
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
  const occluders = buildOccluders(field, plane, standing, (x, z) => ground.at(x, z, "core"));
  for (const mesh of [
    ...standing,
    pierDecks,
    props.dark,
    props.light,
    props.models,
  ]) {
    applyAmbientOcclusion(mesh, occluders);
  }
  // AO writes `colors` from nothing, so a model's palette is multiplied in after it.
  applyAlbedo(props.models, MODEL_TONE);
  // The walls' own bands, over the occlusion that shares the array. Neutral
  // tone: a band is a shade of the colour the building already is.
  for (const belt of BELT_ORDER) applyAlbedo(buildings.meshes[belt], [1, 1, 1]);
  // One reading of how steep the ground is, for every belt alike: the drawn
  // surface over a stride of eight metres. Read off the raw field, a cliff's
  // spikes shaded the smoothed face as a field of flames.
  const SLOPE_STRIDE_M = 8;
  const slopeDegAt = (x: number, z: number): number => {
    const east = ground.at(x + SLOPE_STRIDE_M, z, "core");
    const west = ground.at(x - SLOPE_STRIDE_M, z, "core");
    const south = ground.at(x, z + SLOPE_STRIDE_M, "core");
    const north = ground.at(x, z - SLOPE_STRIDE_M, "core");
    if ([east, west, south, north].some(Number.isNaN)) return 0;
    const run = Math.hypot(
      (east - west) / (2 * SLOPE_STRIDE_M),
      (south - north) / (2 * SLOPE_STRIDE_M),
    );
    return (Math.atan(run) * 180) / Math.PI;
  };
  // The ground's shade once, on the finest surface, and every belt reads it.
  const groundShade = buildGroundShade(
    occluders,
    {
      minX: plane.x(field.bbox.minLon),
      maxX: plane.x(field.bbox.maxLon),
      minZ: plane.z(field.bbox.maxLat),
      maxZ: plane.z(field.bbox.minLat),
    },
    (x, z) => ground.at(x, z, "core"),
    slopeDegAt,
  );
  for (const belt of BELT_ORDER) {
    paintGround(terrain.meshes[belt], groundShade, occluders, slopeDegAt, terrain.blocks.coarsestCellAt);
  }
  const slopeShaded = groundShade.sloped;

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
      // The harbour is one thing, so its decks ship whole rather than split
      // across belts by distance, which would cut a pontoon in half.
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
  const lattice = latticeOf([...BELT_ORDER.map((belt) => terrain.meshes[belt]), terrain.plinth]);
  for (const belt of BELT_ORDER) {
    const parts = layout[belt].filter((part) => !isEmpty(part.mesh));
    const bytes = await writeGlb(join(outDir, `${belt}.glb`), parts, lattice);
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
    inletsFilled: terrain.inletsFilled,
    isletsDrowned: terrain.isletsDrowned,
    trackVertices: elevations.length,
    portalTriangles: triangleCount(portals.sleeve) + triangleCount(portals.surround),
    barrierTriangles: triangleCount(barriers),
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
      `dropped: ${b.droppedOnTrack} on track, ${b.droppedOverWater} over water, ${b.droppedOffEdge} off the edge, ` +
      `${b.droppedTooLow} too low`
      + (b.terraced ? `, ${b.terraced} terraces split along the fall line` : "")
      + `, ${b.cliffHeights} on a cliff at their tagged height`,
  );
  console.log(`  track profile ${report.trackVertices} vertices`);
  const h = report.heights;
  console.log(
    `  heights ${h.measured} measured from MNH, ${h.fellBack} on OSM tags, ` +
      `median move ${h.medianDeltaM.toFixed(1)} m, tallest ${h.tallest.toFixed(1)} m`,
  );
  console.log(`  portals ${report.portalTriangles} tris`);
  console.log(`  barriers ${report.barrierTriangles} tris`);
  console.log(
    `  coast ${report.coast.oriented} of ${report.coast.ways} ways cut the terrain ` +
      `(${report.coast.segments} segments), ${report.coast.unoriented} without a land side, ` +
      `${report.coast.segmentsDropped} segments the raster does not confirm`,
  );
  console.log(
    `  belt seams ${report.conform.nodes} nodes conformed to the coarser chord, ` +
      `worst ${report.conform.worstM.toFixed(2)} m, mean ${report.conform.meanM.toFixed(2)} m, ` +
      `${report.conform.over1M} over 1 m, ${report.conform.over2M} over 2 m`,
  );
  console.log(
    `  enclosed water ${report.holesFilled} cells filled as holes, ${report.inletsFilled} in inlets too narrow to draw, ${report.isletsDrowned} of islets drowned`,
  );
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
      + `${report.kit.eligible} footprints fit the shape, `
      + `${report.kit.noModelFits} had no model at their proportion, `
      + `${report.kit.onTheTrack} on the track, ${report.kit.overBudget} over budget, `
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
