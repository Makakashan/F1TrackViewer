/** The terrain belts, their shoreline cut, the plinth and the sea. */

import { DEFAULT_HALF_WIDTH_M as RIBBON_HALF_WIDTH_M } from "../../src/lib/track/track-geometry";
import { BELT_CELL_M, BELT_ORDER, beltAtDistance, type Belt, type Corridor } from "./belts";
import { DEFAULT_VERGE_M, type HeightField } from "./heightfield";
import { addFlatQuad, createMesh, GridMesh, type Mesh } from "./mesh";
import type { ScenePlane } from "./plane";
import type { Breaklines } from "./breaklines";
import cdt2d from "cdt2d";
import { clipToCell, type Ribbon } from "./ribbon";
import { SHORE_LIP_M, splitsOnMain, type Ground } from "./ground";
import type { PierResult } from "./piers";
import type { Coastline } from "./coastline";
import { buildShoreDistance } from "./shore-distance";
import type { PortalHollow } from "./portals";
import { extrude } from "./buildings";

/** Half the racing surface where no width profile exists. */
export const DEFAULT_TRACK_HALF_WIDTH_M = 6;

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

/**
 * How far the cut may sit below the land behind it; the rest of the drop goes to
 * the skirt, or a cliff face hangs on one row of triangles.
 */
export const MAX_COAST_DROP_M = 6;

export interface TerrainResult {
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

export function bakeTerrain(
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
export function modelRim(field: HeightField, plane: ScenePlane): { minX: number; maxX: number; minZ: number; maxZ: number } {
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
export function bakeWater(field: HeightField, plane: ScenePlane): Mesh {
  const mesh = createMesh();
  const { minX: x0, maxX: x1, minZ: z0, maxZ: z1 } = modelRim(field, plane);
  addFlatQuad(mesh, x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0);
  return mesh;
}

/** Pontoon decks extruded from their mapped rings, walled down to the skirt's foot. */
export function bakePierDecks(piers: PierResult): Mesh {
  const mesh = createMesh();
  for (const deck of piers.decks) {
    const foot = Math.min(SHORE_FOOT_M, deck.deckY - 1);
    extrude(mesh, deck.ring, deck.ring.map(() => foot), deck.deckY);
  }
  return mesh;
}
