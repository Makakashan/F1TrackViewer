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
import { fetchShoreWays, fetchStructureWays } from "./overpass";
import { fetchElevationRaster, sampleRaster } from "./raster";
import { measureBuildingHeights, type HeightStats } from "./building-heights";
import { bakeShoreWalls, type ShoreResult } from "./shore";
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
/** Buildings below this are noise — bin stores, lift housings, map clutter. */
const MIN_BUILDING_HEIGHT_M = 2;

type MeshKind = "terrain" | "building" | "water" | "tunnel" | "portal" | "shore";

const MESH_COLOR: Record<MeshKind, string> = {
  terrain: DIORAMA_COLORS.terrain,
  building: DIORAMA_COLORS.building,
  water: DIORAMA_COLORS.water,
  tunnel: "#14161A",
  portal: DIORAMA_COLORS.buildingSide,
  shore: DIORAMA_COLORS.buildingSide,
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
 */
function bakeTerrain(field: HeightField, plane: ScenePlane, corridor: Corridor): TerrainResult {
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

    const vertexAt = (row: number, col: number): number =>
      grid.vertex(row * (cols + 2) + col, minX + col * cell, heightAt(row, col), minZ + row * cell);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (beltOfCell(row, col, cell) !== belt) continue;

        const h00 = heightAt(row, col);
        const h10 = heightAt(row, col + 1);
        const h01 = heightAt(row + 1, col);
        const h11 = heightAt(row + 1, col + 1);
        const land00 = !Number.isNaN(h00);
        const land10 = !Number.isNaN(h10);
        const land01 = !Number.isNaN(h01);
        const land11 = !Number.isNaN(h11);
        if (!land00 && !land10 && !land01 && !land11) continue;

        // Per triangle, not per cell. Dropping the whole cell when one corner
        // is water costs a full cell of coast — 16 m in the far belt — and the
        // shoreline comes out as teeth of sea biting into the city.
        // Counter-clockwise seen from above, so the normal points at the sky.
        let built = false;
        if (land00 && land11 && land10) {
          grid.triangle(vertexAt(row, col), vertexAt(row + 1, col + 1), vertexAt(row, col + 1));
          built = true;
        }
        if (land00 && land01 && land11) {
          grid.triangle(vertexAt(row, col), vertexAt(row + 1, col), vertexAt(row + 1, col + 1));
          built = true;
        }
        if (built) cellsByBelt[belt]++;
      }
    }

    const mesh = grid.finish();
    addTerrainSkirts(mesh, field, plane, beltOfCell, belt, minX, minZ, cell, rows, cols);
    meshes[belt] = mesh;
  }

  return { meshes, cellsByBelt };
}

/** A vertical drop on every edge whose neighbour cell was not built. */
function addTerrainSkirts(
  mesh: Mesh,
  field: HeightField,
  plane: ScenePlane,
  beltOfCell: (row: number, col: number, cell: number) => Belt,
  belt: Belt,
  minX: number,
  minZ: number,
  cell: number,
  rows: number,
  cols: number,
): void {
  const built = (row: number, col: number): boolean => {
    if (row < 0 || col < 0 || row >= rows || col >= cols) return false;
    if (beltOfCell(row, col, cell) !== belt) return false;
    let land = 0;
    for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      const h = field.heightAt(
        plane.lon(minX + (col + dc) * cell),
        plane.lat(minZ + (row + dr) * cell),
      );
      if (!Number.isNaN(h)) land++;
    }
    return land >= 3;
  };

  const heightAt = (row: number, col: number): number =>
    field.heightAt(plane.lon(minX + col * cell), plane.lat(minZ + row * cell));

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
      if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) {
        continue; // a shoreline cell: its own edge is the coast, and needs no skirt
      }

      if (!built(row - 1, col)) {
        addFlatQuad(mesh, x0, h00, z0, x1, h10, z0, x1, h10 - SKIRT_M, z0, x0, h00 - SKIRT_M, z0);
      }
      if (!built(row + 1, col)) {
        addFlatQuad(mesh, x1, h11, z1, x0, h01, z1, x0, h01 - SKIRT_M, z1, x1, h11 - SKIRT_M, z1);
      }
      if (!built(row, col - 1)) {
        addFlatQuad(mesh, x0, h01, z1, x0, h00, z0, x0, h00 - SKIRT_M, z0, x0, h01 - SKIRT_M, z1);
      }
      if (!built(row, col + 1)) {
        addFlatQuad(mesh, x1, h10, z0, x1, h11, z1, x1, h11 - SKIRT_M, z1, x1, h10 - SKIRT_M, z0);
      }
    }
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

interface BuildingResult {
  meshes: Record<Belt, Mesh>;
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
): BuildingResult {
  const meshes = { core: createMesh(), city: createMesh(), far: createMesh() } as Record<Belt, Mesh>;
  const result: BuildingResult = {
    meshes,
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
    const foot = grounds[0];

    let centreX = 0;
    let centreZ = 0;
    for (const point of pushed.ring) {
      centreX += point.x;
      centreZ += point.z;
    }
    centreX /= pushed.ring.length;
    centreZ /= pushed.ring.length;
    const belt = beltAtDistance(corridor.distance(centreX, centreZ));

    extrude(meshes[belt], pushed.ring, foot, base + height);
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
  base: number,
  top: number,
): void {
  const contour = ring.map((point) => new Vector2(point.x, -point.z));
  const clockwise = ShapeUtils.area(contour) < 0;
  const ordered = clockwise ? [...ring].reverse() : ring;
  const orderedContour = clockwise ? [...contour].reverse() : contour;

  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    const b = ordered[(i + 1) % ordered.length];
    addFlatQuad(mesh, a.x, base, a.z, b.x, base, b.z, b.x, top, b.z, a.x, top, a.z);
  }

  for (const [i, j, k] of ShapeUtils.triangulateShape(orderedContour, [])) {
    addFlatTriangle(
      mesh,
      ordered[i].x, top, ordered[i].z,
      ordered[k].x, top, ordered[k].z,
      ordered[j].x, top, ordered[j].z,
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
function bakePortals(
  tunnels: TunnelMask,
  field: HeightField,
  plane: ScenePlane,
): { sleeve: Mesh; surround: Mesh } {
  const mesh = createMesh();
  const surround = createMesh();

  /** Half an arch section: up the wall, then over the crown. */
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

  for (const run of tunnels.runs) {
    for (const mouth of [run.entry, run.exit]) {
      const roadY = trackHeightNear(field, plane, mouth.x, mouth.z);
      if (Number.isNaN(roadY)) continue;
      // Right-hand normal of the direction: the arch spans across the road.
      const nx = -mouth.uz;
      const nz = mouth.ux;

      const at = (index: number, along: number) => {
        const point = profile[index];
        return {
          x: mouth.x + nx * point.offset + mouth.ux * along,
          y: roadY + point.height,
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
      const archCentreHeight = PORTAL_WALL_M;
      const outward = (index: number) => {
        const point = profile[index];
        const dx = point.offset;
        const dy = point.height - archCentreHeight;
        const length = Math.hypot(dx, dy) || 1;
        return {
          offset: point.offset + (dx / length) * PORTAL_SURROUND_M,
          height: point.height + (dy / length) * PORTAL_SURROUND_M,
        };
      };
      const face = (offset: number, height: number) => ({
        x: mouth.x + nx * offset + mouth.ux * outside,
        y: roadY + height,
        z: mouth.z + nz * offset + mouth.uz * outside,
      });
      for (let i = 0; i < profile.length - 1; i++) {
        const a = face(profile[i].offset, profile[i].height);
        const b = face(profile[i + 1].offset, profile[i + 1].height);
        const oa = outward(i);
        const ob = outward(i + 1);
        const c = face(ob.offset, ob.height);
        const d = face(oa.offset, oa.height);
        addFlatQuad(surround, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z, b.x, b.y, b.z);
      }

      // The far end is capped, or the sleeve is a hole through the hill.
      const centre = {
        x: mouth.x + mouth.ux * inside,
        y: roadY,
        z: mouth.z + mouth.uz * inside,
      };
      for (let i = 0; i < profile.length - 1; i++) {
        const a = at(i, inside);
        const b = at(i + 1, inside);
        addFlatTriangle(mesh, centre.x, centre.y, centre.z, a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
  }

  return { sleeve: mesh, surround };
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
  shore: ShoreResult;
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
  const shore = bakeShoreWalls(
    overrideShoreWays(await fetchShoreWays(circuitId, bbox, refresh), overrides, overrideStats),
    field,
    plane,
  );

  const elevations = trackElevations(field, coords, plane);
  const portals = bakePortals(tunnels, field, plane);
  const terrain = bakeTerrain(field, plane, corridor);
  const water = bakeWater(field, plane);

  const buildingsFile = applyBuildingOverrides(
    JSON.parse(await readFile(join(OUTPUT_ROOT, circuitId, "buildings.json"), "utf8")) as BuildingsFile,
    overrides,
    overrideStats,
  );
  const heightStats = { value: { measured: 0, fellBack: 0, medianDeltaM: 0, tallest: 0 } };
  const mnh = await fetchElevationRaster({ kind: "mnh", bbox, refresh });
  const measured = measureBuildingHeights(buildingsFile.buildings, mnh, heightStats);
  const buildings = bakeBuildings(buildingsFile, field, plane, corridor, measured);

  const outDir = join(OUTPUT_ROOT, circuitId);
  await mkdir(outDir, { recursive: true });

  const layout: Record<Belt, { kind: MeshKind; mesh: Mesh }[]> = {
    core: [
      { kind: "terrain", mesh: terrain.meshes.core },
      { kind: "building", mesh: buildings.meshes.core },
      { kind: "tunnel", mesh: portals.sleeve },
      // Its own mesh, not merged into the buildings: a headwall stands over the
      // road on purpose, and the corridor check would read it as a wall in the
      // way.
      { kind: "portal", mesh: portals.surround },
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
    shore,
    heights: heightStats.value,
    tunnels,
    overrides: overrideStats,
  };
  await writeManifest(outDir, circuitId, field, plane, report, elevations);
  return report;
}

async function writeManifest(
  outDir: string,
  circuitId: string,
  field: HeightField,
  plane: ScenePlane,
  report: BakeReport,
  trackElevationProfile: number[],
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
  console.log(`  portals ${report.portalTriangles} tris`);
  console.log(
    `  shore ${report.shore.built} wall segments, ` +
      `${report.shore.skippedDisagreement} skipped where OSM and the raster disagree, ` +
      `${report.shore.skippedKind} piers skipped`,
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
