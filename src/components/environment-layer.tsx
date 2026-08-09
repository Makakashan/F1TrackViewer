"use client";

import { useMemo, useEffect } from "react";
import * as THREE from "three";
import type {
  EnvironmentBundle,
  BuildingFeature,
  RoadLine,
  EnvironmentManifest,
} from "@/lib/environment-types";
import { DIORAMA_COLORS } from "@/lib/diorama-palette";
import { densifyCoords, xzToLonLat } from "@/lib/geo-utils";
import { buildTerrainSampler, type TerrainSampler } from "@/lib/terrain-sampler";

/**
 * Local-meters projection of a [lon, lat] pair onto the diorama plane.
 * The track, terrain grid, buildings, water, roads and landuse all use the
 * same origin (the manifest center) so they sit in one metric space.
 *
 * Convention matches geo-utils.ts: north → -Z, east → +X, up → +Y.
 */
function lonLatToXZ(
  lon: number,
  lat: number,
  originLon: number,
  originLat: number,
): { x: number; z: number } {
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((originLat * Math.PI) / 180);
  return {
    x: (lon - originLon) * metersPerDegLon,
    z: -(lat - originLat) * metersPerDegLat,
  };
}

function lonLatToShapeXY(
  lon: number,
  lat: number,
  originLon: number,
  originLat: number,
): { x: number; y: number } {
  const { x, z } = lonLatToXZ(lon, lat, originLon, originLat);
  return { x, y: -z };
}

/**
 * Flat-mode offsets between diorama layers, in meters. Terrain mode uses
 * draped geometry with small offsets above the terrain mesh.
 */
const LAYER_Y_FLAT = {
  base: 0,
  water: 0.08,
  landuse: 0.16,
  roads: 0.24,
  buildings: 0.08,
} as const;

const LAYER_Y_DRAPE = {
  landuse: 0.1,
  water: 0.08,
  // Enough to win the depth test against the surface the ribbon is sampled
  // from, and nothing more — see the triangle interpolation in
  // buildTerrainSampler.
  roads: 0.05,
  buildings: 0.15,
} as const;

const MIN_WATER_AREA_SQ_M = 2_500;
const ROAD_RIBBON_WIDTH_M = 1.2;
// OSM road ways can have points several hundred meters apart on long straight
// roads. Each ribbon segment only samples terrain height at its two
// endpoints, so a hill between sparse points doesn't get "seen" and the road
// dips below the terrain mesh — same failure mode as the track curve.
const ROAD_MAX_SEGMENT_M = 25;
const TERRAIN_BASE_SLAB_DEPTH = 0;
const TERRAIN_TRACK_CARVE_RADIUS_M = 30;
const TERRAIN_TRACK_CARVE_DEPTH_M = 4;
const BROADCAST_VIEW_PADDING_M = 360;
const MAX_BROADCAST_BUILDINGS = 420;
// Building extrusion runs ExtrudeGeometry synchronously per building on the
// main thread (~1-1.5ms each on a mid-tier mobile CPU) — profiled at ~500ms+
// of blocked main thread when enabling 3D mode on a dense city circuit. This
// cap keeps that rebuild well under a frame budget on weaker devices.
const LOW_DETAIL_MAX_BUILDINGS = 150;
/**
 * Margin added to the ribbon's half width when deciding a building sits on the
 * track.
 *
 * OSM maps start/finish structures, pit walls and grandstand roofs as plain
 * `building` ways, and some are drawn over the racing surface — Silverstone
 * has a 25 × 3 m, 9 m tall way 4.6 m off the centerline, which extrudes into a
 * wall standing on the start straight. Nothing in the tags separates those
 * from an ordinary building, so position is the only filter available.
 *
 * Keyed to the rendered half width rather than a fixed distance because that
 * is exactly the question being asked: does this footprint overlap the ribbon
 * the scene draws. The margin covers kerbs. Anything further out — a pit
 * complex 26 m away — is a real building beside a real track and stays.
 */
const TRACK_CORRIDOR_MARGIN_M = 1;
/**
 * Track vertices can be hundreds of meters apart on a straight, so a building
 * can sit squarely between two of them. Resampling the centerline at this
 * spacing before the corridor test means any crossing structure has a sample
 * inside it.
 */
const TRACK_CORRIDOR_SAMPLE_M = 20;

const THEME_COLORS = {
  light: {
    base: "#EEF1F5",
    grid: "#CCD3DE",
    terrain: "#C8C8CA",
    terrainSlab: "#252C36",
    building: "#BCC0C4",
    road: "#9AA2AA",
  },
  dark: {
    base: "#0B1017",
    grid: "#141A22",
    terrain: "#111720",
    terrainSlab: "#090D13",
    building: "#6F7887",
    road: "#6F7784",
  },
} as const;

type EnvironmentTheme = keyof typeof THEME_COLORS;

interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

function isPointInPolygon(
  point: { x: number; y: number },
  polygon: { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function buildTrackFocusBBox(
  trackCoordinates: [number, number][],
  originLat: number,
  paddingMeters: number,
): BBox | null {
  if (!trackCoordinates.length) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of trackCoordinates) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((originLat * Math.PI) / 180);
  const dLon = paddingMeters / metersPerDegLon;
  const dLat = paddingMeters / metersPerDegLat;
  return {
    minLon: minLon - dLon,
    minLat: minLat - dLat,
    maxLon: maxLon + dLon,
    maxLat: maxLat + dLat,
  };
}

function clampBBox(inner: BBox, outer: BBox): BBox {
  return {
    minLon: Math.max(inner.minLon, outer.minLon),
    minLat: Math.max(inner.minLat, outer.minLat),
    maxLon: Math.min(inner.maxLon, outer.maxLon),
    maxLat: Math.min(inner.maxLat, outer.maxLat),
  };
}

function bboxCenter(bbox: BBox): { lon: number; lat: number } {
  return {
    lon: (bbox.minLon + bbox.maxLon) / 2,
    lat: (bbox.minLat + bbox.maxLat) / 2,
  };
}

function isLonLatInBBox(lon: number, lat: number, bbox: BBox): boolean {
  return (
    lon >= bbox.minLon &&
    lon <= bbox.maxLon &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat
  );
}

function clipSegmentToBBox(
  a: [number, number],
  b: [number, number],
  bbox: BBox,
): [[number, number], [number, number]] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const tests: [number, number][] = [
    [-dx, a[0] - bbox.minLon],
    [dx, bbox.maxLon - a[0]],
    [-dy, a[1] - bbox.minLat],
    [dy, bbox.maxLat - a[1]],
  ];

  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }

  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ];
}

function polygonArea2D(points: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function distanceToSegmentSq2D(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = point.x - a.x;
  const wy = point.y - a.y;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  const x = a.x + vx * t;
  const y = a.y + vy * t;
  const dx = point.x - x;
  const dy = point.y - y;
  return dx * dx + dy * dy;
}

type XY = { x: number; y: number };

/**
 * A test for "does this footprint sit on the track".
 *
 * The centerline is resampled and hashed into a uniform grid once, so each
 * building only measures against the handful of track samples near it rather
 * than the whole lap — the naive form is 400 buildings × a few thousand
 * samples, which is long enough to be felt when 3D mode is switched on.
 */
function buildTrackCorridorTest(
  trackCoordinates: [number, number][],
  originLon: number,
  originLat: number,
  clearance: number,
): ((footprint: XY[]) => boolean) | null {
  if (trackCoordinates.length < 2) return null;

  const samples: XY[] = [];
  let previous = lonLatToShapeXY(
    trackCoordinates[0][0],
    trackCoordinates[0][1],
    originLon,
    originLat,
  );
  samples.push(previous);
  for (let i = 1; i < trackCoordinates.length; i++) {
    const next = lonLatToShapeXY(
      trackCoordinates[i][0],
      trackCoordinates[i][1],
      originLon,
      originLat,
    );
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / TRACK_CORRIDOR_SAMPLE_M));
    for (let step = 1; step <= steps; step++) {
      samples.push({
        x: previous.x + (dx * step) / steps,
        y: previous.y + (dy * step) / steps,
      });
    }
    previous = next;
  }

  const cellSize = Math.max(clearance, TRACK_CORRIDOR_SAMPLE_M) * 2;
  const grid = new Map<string, XY[]>();
  const key = (cx: number, cy: number) => `${cx}:${cy}`;
  for (const sample of samples) {
    const cx = Math.floor(sample.x / cellSize);
    const cy = Math.floor(sample.y / cellSize);
    const bucket = grid.get(key(cx, cy));
    if (bucket) bucket.push(sample);
    else grid.set(key(cx, cy), [sample]);
  }

  const clearanceSq = clearance * clearance;

  return (footprint: XY[]) => {
    if (footprint.length < 3) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of footprint) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }

    const cx0 = Math.floor((minX - clearance) / cellSize);
    const cx1 = Math.floor((maxX + clearance) / cellSize);
    const cy0 = Math.floor((minY - clearance) / cellSize);
    const cy1 = Math.floor((maxY + clearance) / cellSize);

    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = grid.get(key(cx, cy));
        if (!bucket) continue;
        for (const sample of bucket) {
          if (
            sample.x < minX - clearance ||
            sample.x > maxX + clearance ||
            sample.y < minY - clearance ||
            sample.y > maxY + clearance
          ) {
            continue;
          }
          if (isPointInPolygon(sample, footprint)) return true;
          for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) {
            if (distanceToSegmentSq2D(sample, footprint[j], footprint[i]) < clearanceSq) {
              return true;
            }
          }
        }
      }
    }
    return false;
  };
}

export interface EnvironmentLayerProps {
  bundle: EnvironmentBundle;
  trackCoordinates: [number, number][];
  originLon: number;
  originLat: number;
  baseY?: number;
  showTerrain?: boolean;
  resolvedTheme?: EnvironmentTheme;
  /** Reduces building count for weaker devices. */
  lowDetail?: boolean;
  /** Half width of the rendered ribbon, in meters — see TRACK_CORRIDOR_MARGIN_M. */
  trackHalfWidthM?: number;
}

export default function EnvironmentLayer({
  bundle,
  trackCoordinates,
  originLon,
  originLat,
  baseY = 0,
  showTerrain = true,
  resolvedTheme = "dark",
  lowDetail = false,
  trackHalfWidthM = 7,
}: EnvironmentLayerProps) {
  const { manifest } = bundle;
  const hasTerrain = showTerrain && bundle.terrain.gridSize > 0;
  const broadcastBBox = useMemo(() => {
    const focus = buildTrackFocusBBox(
      trackCoordinates,
      originLat,
      BROADCAST_VIEW_PADDING_M,
    );
    return focus ? clampBBox(focus, manifest.bbox) : manifest.bbox;
  }, [trackCoordinates, originLat, manifest.bbox]);

  /**
   * One sampler, carrying the same flattening and carving the terrain mesh
   * renders. Every draped layer reads its height from here, so nothing has to
   * guess at a clearance that keeps it above a surface it cannot see.
   */
  const terrainSampler = useMemo(() => {
    if (!hasTerrain) return null;
    const waterMasks = bundle.water.polygons
      .map((poly) =>
        poly.points.map(([lon, lat]) =>
          lonLatToShapeXY(lon, lat, originLon, originLat),
        ),
      )
      .filter(
        (poly) => poly.length >= 3 && polygonArea2D(poly) >= MIN_WATER_AREA_SQ_M,
      );
    const surface =
      bundle.surface?.gridSize === bundle.terrain.gridSize
        ? bundle.surface
        : null;
    const gridSize = bundle.terrain.gridSize;
    const { minLon, minLat, maxLon, maxLat } = manifest.bbox;

    const trackPoints = trackCoordinates.map(([lon, lat]) =>
      lonLatToShapeXY(lon, lat, originLon, originLat),
    );
    const carveRadiusSq =
      TERRAIN_TRACK_CARVE_RADIUS_M * TERRAIN_TRACK_CARVE_RADIUS_M;

    return buildTerrainSampler(bundle.terrain, manifest, {
      isWater(lon, lat) {
        if (surface) {
          const col = Math.round(((lon - minLon) / (maxLon - minLon)) * (gridSize - 1));
          const row = Math.round(((lat - minLat) / (maxLat - minLat)) * (gridSize - 1));
          return surface.waterMask[row * gridSize + col] === 1;
        }
        const point = lonLatToShapeXY(lon, lat, originLon, originLat);
        return waterMasks.some((mask) => isPointInPolygon(point, mask));
      },
      isCarved(lon, lat) {
        const point = lonLatToShapeXY(lon, lat, originLon, originLat);
        for (let i = 0; i < trackPoints.length; i++) {
          const next = trackPoints[(i + 1) % trackPoints.length];
          if (distanceToSegmentSq2D(point, trackPoints[i], next) <= carveRadiusSq) {
            return true;
          }
        }
        return false;
      },
      carveDepthMeters: TERRAIN_TRACK_CARVE_DEPTH_M,
    });
  }, [
    bundle.terrain,
    bundle.surface,
    bundle.water.polygons,
    manifest,
    hasTerrain,
    originLon,
    originLat,
    trackCoordinates,
  ]);

  return (
    <group>
      {!hasTerrain && (
        <DioramaBase
          bbox={broadcastBBox}
          originLon={originLon}
          originLat={originLat}
          baseY={baseY}
          hasTerrain={hasTerrain}
          resolvedTheme={resolvedTheme}
        />
      )}
      {hasTerrain && terrainSampler && (
        <TerrainMesh
          sampler={terrainSampler}
          manifest={manifest}
          originLon={originLon}
          originLat={originLat}
          baseY={baseY}
          bbox={broadcastBBox}
          resolvedTheme={resolvedTheme}
        />
      )}
      <RoadLinesMesh
        roads={bundle.roads.roads}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        terrainSampler={terrainSampler}
        drapeY={LAYER_Y_DRAPE.roads}
        flatY={LAYER_Y_FLAT.roads}
        bbox={broadcastBBox}
        resolvedTheme={resolvedTheme}
      />
      <BuildingExtrusions
        buildings={bundle.buildings.buildings}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        terrainSampler={terrainSampler}
        drapeY={LAYER_Y_DRAPE.buildings}
        flatY={LAYER_Y_FLAT.buildings}
        bbox={broadcastBBox}
        resolvedTheme={resolvedTheme}
        maxBuildings={lowDetail ? LOW_DETAIL_MAX_BUILDINGS : MAX_BROADCAST_BUILDINGS}
        trackCoordinates={trackCoordinates}
        trackHalfWidthM={trackHalfWidthM}
      />
    </group>
  );
}

// ─── DioramaBase ────────────────────────────────────────────────────────────

function DioramaBase({
  bbox,
  originLon,
  originLat,
  baseY,
  hasTerrain,
  resolvedTheme,
}: {
  bbox: BBox;
  originLon: number;
  originLat: number;
  baseY: number;
  hasTerrain: boolean;
  resolvedTheme: EnvironmentTheme;
}) {
  const colors = THEME_COLORS[resolvedTheme];
  const centerLonLat = bboxCenter(bbox);
  const center = lonLatToXZ(centerLonLat.lon, centerLonLat.lat, originLon, originLat);
  const halfW =
    ((bbox.maxLon - bbox.minLon) *
      111_320 *
      Math.cos((centerLonLat.lat * Math.PI) / 180)) /
    2;
  const halfH =
    ((bbox.maxLat - bbox.minLat) * 111_320) / 2;

  // Grid texture drawn procedurally on a canvas, matching the pale broadcast
  // map-board outside the circuit grounds.
  const gridTexture = useMemo(() => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    const step = size / 32;
    for (let i = 0; i <= 32; i++) {
      const p = i * step;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 8);
    tex.anisotropy = 4;
    return tex;
  }, [colors.base, colors.grid]);

  useEffect(() => {
    return () => {
      gridTexture?.dispose();
    };
  }, [gridTexture]);

  // Place the base at terrain-bottom level (baseY=0 in terrain mode) so
  // there is no vertical gap between the platform and the 3-D scene.
  const yPos = baseY;

  const material = (
    <meshStandardMaterial
      map={gridTexture}
      color={hasTerrain ? colors.terrainSlab : colors.base}
      roughness={1}
      metalness={0}
      side={THREE.FrontSide}
      polygonOffset
      polygonOffsetFactor={3}
      polygonOffsetUnits={3}
    />
  );

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[center.x, hasTerrain ? yPos - TERRAIN_BASE_SLAB_DEPTH : yPos, center.z]}
      receiveShadow
    >
      <planeGeometry args={[halfW * 2, halfH * 2, 1, 1]} />
      {material}
    </mesh>
  );
}

// ─── TerrainMesh ────────────────────────────────────────────────────────────
//
// Volumetric 3D terrain mesh, flat-shaded for the low-poly diorama look.
// Vertical scale is exaggerated so hills are visible but the city still
// reads on top.

function TerrainMesh({
  sampler,
  manifest,
  originLon,
  originLat,
  baseY,
  bbox,
  resolvedTheme,
}: {
  sampler: TerrainSampler;
  manifest: EnvironmentManifest;
  originLon: number;
  originLat: number;
  baseY: number;
  bbox: BBox;
  resolvedTheme: EnvironmentTheme;
}) {
  const geometry = useMemo(() => {
    const n = sampler.gridSize;
    if (n < 2) return null;
    const minLon = manifest.bbox.minLon;
    const minLat = manifest.bbox.minLat;
    const maxLat = manifest.bbox.maxLat;
    const maxLon = manifest.bbox.maxLon;
    const colStart = Math.max(
      0,
      Math.floor(((bbox.minLon - minLon) / (maxLon - minLon)) * (n - 1)),
    );
    const colEnd = Math.min(
      n - 1,
      Math.ceil(((bbox.maxLon - minLon) / (maxLon - minLon)) * (n - 1)),
    );
    const rowStart = Math.max(
      0,
      Math.floor(((bbox.minLat - minLat) / (maxLat - minLat)) * (n - 1)),
    );
    const rowEnd = Math.min(
      n - 1,
      Math.ceil(((bbox.maxLat - minLat) / (maxLat - minLat)) * (n - 1)),
    );
    const cols = colEnd - colStart + 1;
    const rows = rowEnd - rowStart + 1;
    if (cols < 2 || rows < 2) return null;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];

    const themeColors = THEME_COLORS[resolvedTheme];
    const terrainTop = new THREE.Color(themeColors.terrain);
    const terrainEdge = new THREE.Color(
      resolvedTheme === "dark" ? "#020304" : "#C8D0DB",
    );

    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const lon = minLon + ((maxLon - minLon) * col) / (n - 1);
        const lat = minLat + ((maxLat - minLat) * row) / (n - 1);
        const { x, z } = lonLatToXZ(lon, lat, originLon, originLat);
        positions.push(x, sampler.heightAtNode(row, col), z);
        uvs.push(
          cols === 1 ? 0 : (col - colStart) / (cols - 1),
          rows === 1 ? 0 : (row - rowStart) / (rows - 1),
        );

        // Solid terrain color — no edge fade gradient.
        colors.push(terrainTop.r, terrainTop.g, terrainTop.b);
      }
    }

    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const a = row * cols + col;
        const b = row * cols + col + 1;
        const c = (row + 1) * cols + col;
        const d = (row + 1) * cols + col + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    // ── Skirt: vertical walls around the terrain perimeter ──
    // Prevents the "box" effect by adding solid dark faces that extend
    // below the terrain surface, blending into the scene background.
    const skirtY = -25;
    const baseVertexCount = cols * rows;
    let skirtIdx = 0;

    function addSkirtEdge(edgeVertIndices: number[]) {
      for (let i = 0; i < edgeVertIndices.length - 1; i++) {
        const topA = edgeVertIndices[i];
        const topB = edgeVertIndices[i + 1];
        const skirtA = baseVertexCount + skirtIdx++;
        const skirtB = baseVertexCount + skirtIdx++;

        const ax = positions[topA * 3];
        const az = positions[topA * 3 + 2];
        const bx = positions[topB * 3];
        const bz = positions[topB * 3 + 2];

        positions.push(ax, skirtY, az, bx, skirtY, bz);
        uvs.push(0, 0, 0, 0);
        colors.push(
          terrainEdge.r, terrainEdge.g, terrainEdge.b,
          terrainEdge.r, terrainEdge.g, terrainEdge.b,
        );

        indices.push(topA, skirtA, topB);
        indices.push(topB, skirtA, skirtB);
      }
    }

    // Collect edge vertex indices for all four sides
    const topEdge: number[] = [];
    const bottomEdge: number[] = [];
    const leftEdge: number[] = [];
    const rightEdge: number[] = [];
    for (let col = 0; col < cols; col++) {
      topEdge.push(col);
      bottomEdge.push((rows - 1) * cols + col);
    }
    for (let row = 0; row < rows; row++) {
      leftEdge.push(row * cols);
      rightEdge.push(row * cols + (cols - 1));
    }
    addSkirtEdge(topEdge);
    addSkirtEdge([...bottomEdge].reverse());
    addSkirtEdge(leftEdge);
    addSkirtEdge([...rightEdge].reverse());

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [sampler, manifest, originLon, originLat, bbox, resolvedTheme]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} position={[0, baseY, 0]} receiveShadow>
      <meshBasicMaterial
        vertexColors
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

// ─── RoadLinesMesh ──────────────────────────────────────────────────────────

function RoadLinesMesh({
  roads,
  originLon,
  originLat,
  baseY,
  terrainSampler,
  drapeY,
  flatY,
  bbox,
  resolvedTheme,
}: {
  roads: RoadLine[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
  bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null;
  resolvedTheme: EnvironmentTheme;
}) {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const road of roads) {
      if (road.points.length < 2) continue;
      const points = terrainSampler
        ? densifyCoords(road.points, ROAD_MAX_SEGMENT_M)
        : road.points;
      for (let i = 0; i < points.length - 1; i++) {
        let [aLon, aLat] = points[i];
        let [bLon, bLat] = points[i + 1];
        if (bbox) {
          const clipped = clipSegmentToBBox([aLon, aLat], [bLon, bLat], bbox);
          if (!clipped) continue;
          [[aLon, aLat], [bLon, bLat]] = clipped;
        }
        const a = lonLatToXZ(aLon, aLat, originLon, originLat);
        const b = lonLatToXZ(bLon, bLat, originLon, originLat);
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.01) continue;
        const halfWidth = ROAD_RIBBON_WIDTH_M / 2;
        const offsetX = (-dz / len) * halfWidth;
        const offsetZ = (dx / len) * halfWidth;
        const base = positions.length / 3;

        // Sampled at each corner rather than once on the centreline: a 1.2 m
        // ribbon laid across a hillside picks up half a meter of drop over its
        // own width, which is the whole remaining gap once the sampler agrees
        // with the mesh.
        const cornerY = (x: number, z: number) => {
          if (!terrainSampler) return baseY + flatY;
          const [lon, lat] = xzToLonLat(x, z, originLon, originLat);
          return baseY + terrainSampler.heightAt(lon, lat) + drapeY;
        };

        for (const [x, z] of [
          [a.x + offsetX, a.z + offsetZ],
          [a.x - offsetX, a.z - offsetZ],
          [b.x + offsetX, b.z + offsetZ],
          [b.x - offsetX, b.z - offsetZ],
        ]) {
          positions.push(x, cornerY(x, z), z);
        }
        indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    }
    if (!positions.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    return geo;
  }, [roads, originLon, originLat, terrainSampler, baseY, drapeY, flatY, bbox]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} renderOrder={10}>
      <meshBasicMaterial
        color={THEME_COLORS[resolvedTheme].road}
        side={THREE.DoubleSide}
        depthTest
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-4}
        polygonOffsetUnits={-4}
        transparent
        opacity={0.72}
      />
    </mesh>
  );
}

// ─── BuildingExtrusions ─────────────────────────────────────────────────────

function BuildingExtrusions({
  buildings,
  originLon,
  originLat,
  baseY,
  terrainSampler,
  drapeY,
  flatY,
  bbox,
  resolvedTheme,
  maxBuildings = MAX_BROADCAST_BUILDINGS,
  trackCoordinates,
  trackHalfWidthM,
}: {
  buildings: BuildingFeature[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
  bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null;
  resolvedTheme: EnvironmentTheme;
  maxBuildings?: number;
  trackCoordinates: [number, number][];
  trackHalfWidthM: number;
}) {
  const capped = useMemo(() => {
    let filtered = buildings;
    if (bbox) {
      filtered = filtered.filter((b) => {
        if (b.footprint.length < 3) return false;
        for (const [lon, lat] of b.footprint) {
          if (!isLonLatInBBox(lon, lat, bbox)) return false;
        }
        return true;
      });
    }

    const onTrack = buildTrackCorridorTest(
      trackCoordinates,
      originLon,
      originLat,
      trackHalfWidthM + TRACK_CORRIDOR_MARGIN_M,
    );
    if (onTrack) {
      filtered = filtered.filter(
        (b) =>
          !onTrack(
            b.footprint.map(([lon, lat]) =>
              lonLatToShapeXY(lon, lat, originLon, originLat),
            ),
          ),
      );
    }

    return filtered.slice(0, maxBuildings);
  }, [
    buildings,
    bbox,
    maxBuildings,
    trackCoordinates,
    originLon,
    originLat,
    trackHalfWidthM,
  ]);

  const geometry = useMemo(() => {
    const geos: THREE.BufferGeometry[] = [];
    for (const b of capped) {
      if (b.footprint.length < 3) continue;
      const shape = new THREE.Shape();
      b.footprint.forEach(([lon, lat], i) => {
        const { x, y } = lonLatToShapeXY(lon, lat, originLon, originLat);
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      });
      shape.closePath();
      // Clamp building height so no single tower pokes through the track
      // ribbon (which floats above the city).
      const rawHeight = Math.max(2, b.height);
      const height = Math.min(rawHeight, 34);
      const extrude = new THREE.ExtrudeGeometry(shape, {
        depth: height,
        bevelEnabled: false,
        steps: 1,
      });
      // ExtrudeGeometry extrudes along +Z. Rotate so depth maps to +Y.
      extrude.rotateX(-Math.PI / 2);

      // When terrain is on, sample the terrain height at the building's
      // centroid and lift the whole building onto the terrain.
      if (terrainSampler) {
        let sumLon = 0;
        let sumLat = 0;
        for (const [lon, lat] of b.footprint) {
          sumLon += lon;
          sumLat += lat;
        }
        const centroidLon = sumLon / b.footprint.length;
        const centroidLat = sumLat / b.footprint.length;
        const h = terrainSampler.heightAt(centroidLon, centroidLat);
        extrude.translate(0, baseY + h + drapeY, 0);
      } else {
        extrude.translate(0, baseY + flatY, 0);
      }
      geos.push(extrude);
    }
    if (!geos.length) return null;
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    return merged;
  }, [capped, originLon, originLat, terrainSampler, baseY, drapeY, flatY]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} renderOrder={60} castShadow receiveShadow>
      <meshStandardMaterial
        color={THEME_COLORS[resolvedTheme].building}
        roughness={0.82}
        metalness={0}
        flatShading
        side={THREE.DoubleSide}
        transparent={false}
        opacity={1}
        depthTest
        depthWrite
      />
    </mesh>
  );
}

/**
 * Minimal BufferGeometry merger — Three.js ships BufferGeometryUtils.mergeGeometries
 * but importing it from three/examples breaks Next.js SSR. This handles only
 * what we need: position + normal + index, no groups.
 */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  let totalVerts = 0;
  let totalIdx = 0;
  let hasIndex = false;
  for (const g of geos) {
    totalVerts += (g.getAttribute("position").count) ?? 0;
    if (g.getIndex()) {
      hasIndex = true;
      totalIdx += g.getIndex()!.count;
    }
  }

  const positions = new Float32Array(totalVerts * 3);
  let vOff = 0;
  const normals = new Float32Array(totalVerts * 3);
  let nOff = 0;
  let vCount = 0;

  const indices = hasIndex ? new Uint32Array(totalIdx) : null;
  let iOff = 0;

  for (const g of geos) {
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    positions.set(pos.array as Float32Array, vOff);
    vOff += pos.array.length;

    const nrm = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
    if (nrm) {
      normals.set(nrm.array as Float32Array, nOff);
    }
    nOff += pos.count * 3;

    const idx = g.getIndex();
    if (idx && indices) {
      for (let i = 0; i < idx.count; i++) {
        indices[iOff++] = idx.getX(i) + vCount;
      }
    }
    vCount += pos.count;
  }

  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  if (indices) merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}
