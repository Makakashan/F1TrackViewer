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
import { addFlatQuad, addFlatTriangle, createMesh, GridMesh, isEmpty, triangleCount, type Mesh } from "./mesh";
import { scenePlaneFor, type ScenePlane } from "./plane";
import { fetchElevationRaster } from "./raster";
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

type MeshKind = "terrain" | "building" | "track" | "water";

const MESH_COLOR: Record<MeshKind, string> = {
  terrain: DIORAMA_COLORS.terrain,
  building: DIORAMA_COLORS.building,
  track: "#3B3F45",
  water: DIORAMA_COLORS.water,
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
        const centreX = minX + (col + 0.5) * cell;
        const centreZ = minZ + (row + 0.5) * cell;
        if (beltAtDistance(corridor.distance(centreX, centreZ)) !== belt) continue;

        const h00 = heightAt(row, col);
        const h10 = heightAt(row, col + 1);
        const h01 = heightAt(row + 1, col);
        const h11 = heightAt(row + 1, col + 1);
        if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) continue;

        const a = vertexAt(row, col);
        const b = vertexAt(row, col + 1);
        const c = vertexAt(row + 1, col + 1);
        const d = vertexAt(row + 1, col);
        grid.triangle(a, b, c);
        grid.triangle(a, c, d);
        cellsByBelt[belt]++;
      }
    }

    const mesh = grid.finish();
    addTerrainSkirts(mesh, field, plane, corridor, belt, minX, minZ, cell, rows, cols);
    meshes[belt] = mesh;
  }

  return { meshes, cellsByBelt };
}

/** A vertical drop on every edge whose neighbour cell was not built. */
function addTerrainSkirts(
  mesh: Mesh,
  field: HeightField,
  plane: ScenePlane,
  corridor: Corridor,
  belt: Belt,
  minX: number,
  minZ: number,
  cell: number,
  rows: number,
  cols: number,
): void {
  const built = (row: number, col: number): boolean => {
    if (row < 0 || col < 0 || row >= rows || col >= cols) return false;
    const centreX = minX + (col + 0.5) * cell;
    const centreZ = minZ + (row + 0.5) * cell;
    if (beltAtDistance(corridor.distance(centreX, centreZ)) !== belt) return false;
    for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      const h = field.heightAt(
        plane.lon(minX + (col + dc) * cell),
        plane.lat(minZ + (row + dr) * cell),
      );
      if (Number.isNaN(h)) return false;
    }
    return true;
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
  addFlatQuad(mesh, x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
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
    if (building.height < MIN_BUILDING_HEIGHT_M) {
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
    let base = Infinity;
    let grounded = 0;
    for (const point of pushed.ring) {
      const h = field.heightAt(plane.lon(point.x), plane.lat(point.z));
      if (Number.isNaN(h)) continue;
      grounded++;
      if (h < base) base = h;
    }
    if (grounded === 0 || !Number.isFinite(base)) {
      result.droppedOverWater++;
      continue;
    }

    let centreX = 0;
    let centreZ = 0;
    for (const point of pushed.ring) {
      centreX += point.x;
      centreZ += point.z;
    }
    centreX /= pushed.ring.length;
    centreZ /= pushed.ring.length;
    const belt = beltAtDistance(corridor.distance(centreX, centreZ));

    extrude(meshes[belt], pushed.ring, base, base + building.height);
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

// ─── track ─────────────────────────────────────────────────────────────────

/**
 * The racing surface as a ribbon on the field it was burned into. Kerbs, apron
 * and painted markings still come from the runtime for now; D13 moves them here
 * once this holds.
 */
function bakeTrack(field: HeightField, plane: ScenePlane, halfWidthM: number): Mesh {
  const mesh = createMesh();
  const { coords } = field.trackProfile;
  const points = coords.map(([lon, lat]) => {
    const x = plane.x(lon);
    const z = plane.z(lat);
    const y = field.heightAt(lon, lat);
    return { x, y: Number.isNaN(y) ? 0 : y + TRACK_RAISE_M, z };
  });

  for (let i = 0; i < points.length; i++) {
    const previous = points[(i - 1 + points.length) % points.length];
    const next = points[(i + 1) % points.length];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    (points[i] as { nx?: number; nz?: number }).nx = (-dz / length) * halfWidthM;
    (points[i] as { nx?: number; nz?: number }).nz = (dx / length) * halfWidthM;
  }

  for (let i = 0; i < points.length; i++) {
    const a = points[i] as { x: number; y: number; z: number; nx: number; nz: number };
    const b = points[(i + 1) % points.length] as typeof a;
    addFlatQuad(
      mesh,
      a.x - a.nx, a.y, a.z - a.nz,
      b.x - b.nx, b.y, b.z - b.nz,
      b.x + b.nx, b.y, b.z + b.nz,
      a.x + a.nx, a.y, a.z + a.nz,
    );
  }

  return mesh;
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
  trackTriangles: number;
}

export async function bakeCircuit(circuitId: string, refresh = false): Promise<BakeReport> {
  const coords = await loadCircuitCoords(circuitId);
  const bbox = circuitBBox(coords);
  const plane = scenePlaneFor(coords);
  const dtm = await fetchElevationRaster({ kind: "dtm", bbox, refresh });
  const field = buildHeightField({
    dtm,
    track: { coords, halfWidthM: DEFAULT_TRACK_HALF_WIDTH_M },
  });
  const corridor = buildCorridor(coords, plane);

  const terrain = bakeTerrain(field, plane, corridor);
  const water = bakeWater(field, plane);
  const track = bakeTrack(field, plane, DEFAULT_TRACK_HALF_WIDTH_M);

  const buildingsFile = JSON.parse(
    await readFile(join(OUTPUT_ROOT, circuitId, "buildings.json"), "utf8"),
  ) as BuildingsFile;
  const buildings = bakeBuildings(buildingsFile, field, plane, corridor);

  const outDir = join(OUTPUT_ROOT, circuitId);
  await mkdir(outDir, { recursive: true });

  const layout: Record<Belt, { kind: MeshKind; mesh: Mesh }[]> = {
    core: [
      { kind: "terrain", mesh: terrain.meshes.core },
      { kind: "building", mesh: buildings.meshes.core },
      { kind: "track", mesh: track },
    ],
    city: [
      { kind: "terrain", mesh: terrain.meshes.city },
      { kind: "building", mesh: buildings.meshes.city },
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
    trackTriangles: triangleCount(track),
  };
  await writeManifest(outDir, circuitId, field, plane, report);
  return report;
}

async function writeManifest(
  outDir: string,
  circuitId: string,
  field: HeightField,
  plane: ScenePlane,
  report: BakeReport,
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
  console.log(`  track ${report.trackTriangles} tris`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
