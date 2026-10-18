/**
 * Bakes a circuit's city into GLB. Everything reads one height field, so terrain,
 * buildings, water and the track agree on where the ground is.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DIORAMA_COLORS } from "../../src/lib/env/diorama-palette";
import { ENVIRONMENT_ATTRIBUTION } from "../../src/lib/env/environment-types";
import {
  BELT_BUDGET,
  BELT_CELL_M,
  BELT_ORDER,
  BELT_RADIUS_M,
  beltAtDistance,
  buildCorridor,
  type Belt,
} from "./belts";
import { buildHeightField, type HeightField } from "./heightfield";
import { addFlatQuad, createMesh, isEmpty, triangleCount, type Mesh } from "./mesh";
import { scenePlaneFor, type ScenePlane } from "./plane";
import {
  applyAlbedo,
  applyAmbientOcclusion,
  buildGroundShade,
  buildOccluders,
  paintGround,
} from "./ao";
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
import { buildBreaklines } from "./breaklines";
import { buildRibbon } from "./ribbon";
import { buildGround } from "./ground";
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
import { buildPiers, type PierResult } from "./piers";
import { berthYachts, buildProps, type PropResult } from "./props";
import { buildCoastline, type CoastlineStats } from "./coastline";
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
import {
  bakePortals,
  bakeTunnelBody,
  portalSection,
  portalVoids,
  type VaultedRuns,
  vaultedRuns,
} from "./portals";
import { latticeOf, type MeshKind, writeGlb } from "./glb";
import {
  bakeBuildings,
  bakeKitPlinths,
  type BuildingResult,
  buildRoadIndex,
  emptyBuildingResult,
  fromOverpass,
  prepareBuildings,
  TRACK_CLEARANCE_M,
} from "./buildings";
import {
  bakePierDecks,
  bakeTerrain,
  bakeWater,
  buildLandAt,
  DEFAULT_TRACK_HALF_WIDTH_M,
  modelRim,
  roadLevel,
  type TerrainResult,
} from "./terrain";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

const OUTPUT_ROOT = join(REPO_ROOT, "public", "environments");

/** Clear of the ground the track was burned into, just enough to beat depth precision. */
const TRACK_RAISE_M = 0.05;

/**
 * Wider than the corridor: a tree's canopy reaches past its trunk, and Monaco's
 * street trees are mapped right at the kerb.
 */
const TREE_CLEARANCE_M = 11;

/** The palette's building hue, luminance divided out, that merged models are pulled toward. */
const MODEL_TONE: [number, number, number] = (() => {
  const hex = DIORAMA_COLORS.building.replace("#", "");
  const rgb = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [rgb[0] / luminance, rgb[1] / luminance, rgb[2] / luminance];
})();

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
