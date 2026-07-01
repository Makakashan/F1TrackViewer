"use client";

import { useMemo, useEffect } from "react";
import * as THREE from "three";
import type {
  EnvironmentBundle,
  BuildingFeature,
  WaterPolygon,
  RoadLine,
  TerrainFile,
  EnvironmentManifest,
  SurfaceFile,
} from "@/lib/environment-types";
import { DIORAMA_COLORS } from "@/lib/diorama-palette";
import {
  buildTerrainSampler,
  terrainLocalHeight,
  terrainReferenceElevation,
  type TerrainSampler,
} from "@/lib/terrain-sampler";

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
  roads: 0.28,
  buildings: 0.08,
} as const;

const LAYER_Y_DRAPE = {
  landuse: 0.3,
  water: 0.6,
  roads: 0.9,
  buildings: 1.2,
} as const;

const MIN_WATER_AREA_SQ_M = 2_500;
const TERRAIN_SKIRT_BOTTOM_Y = -2;
const TERRAIN_BASE_SLAB_DEPTH = 10;
const TERRAIN_TRACK_CARVE_RADIUS_M = 24;
const TERRAIN_TRACK_CARVE_DEPTH_M = 1.5;
const BROADCAST_VIEW_PADDING_M = 360;
const MAX_BROADCAST_BUILDINGS = 420;

const THEME_COLORS = {
  light: {
    base: "#EEF1F5",
    grid: "#CCD3DE",
    terrain: "#E5EAF1",
    terrainSlab: "#D5DCE6",
    sideTop: "#C9D1DC",
    sideBottom: "#AEB8C6",
    building: "#FFFFFF",
    road: "#AAB4C2",
  },
  dark: {
    base: "#05070B",
    grid: "#1A202A",
    terrain: "#090D13",
    terrainSlab: "#05070B",
    sideTop: "#101722",
    sideBottom: "#030406",
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

export interface EnvironmentLayerProps {
  bundle: EnvironmentBundle;
  trackCoordinates: [number, number][];
  originLon: number;
  originLat: number;
  baseY?: number;
  showTerrain?: boolean;
  resolvedTheme?: EnvironmentTheme;
}

export default function EnvironmentLayer({
  bundle,
  trackCoordinates,
  originLon,
  originLat,
  baseY = 0,
  showTerrain = true,
  resolvedTheme = "dark",
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

  // Build a terrain sampler once — used by all draped layers to query the
  // elevation at any [lon, lat] point. Water areas are flattened based on
  // proximity to known water polygon vertices.
  const terrainSampler = useMemo(() => {
    if (!hasTerrain) return null;
    return buildTerrainSampler(bundle.terrain, manifest);
  }, [bundle.terrain, manifest, hasTerrain]);

  return (
    <group>
      <DioramaBase
        bbox={broadcastBBox}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        hasTerrain={hasTerrain}
        resolvedTheme={resolvedTheme}
      />
      {hasTerrain && (
        <TerrainMesh
          terrain={bundle.terrain}
          manifest={manifest}
          originLon={originLon}
          originLat={originLat}
          baseY={baseY}
          waterPolygons={bundle.water.polygons}
          surface={bundle.surface}
          trackCoordinates={trackCoordinates}
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

  // When terrain is on, lower the base plane so the terrain mesh sits above
  // it and forms the "ground" of the diorama.
  const yPos = baseY + (hasTerrain ? -2 : 0);

  const material = (
    <meshStandardMaterial
      map={gridTexture}
      color={hasTerrain ? colors.terrainSlab : colors.base}
      roughness={1}
      metalness={0}
      side={THREE.DoubleSide}
      polygonOffset
      polygonOffsetFactor={3}
      polygonOffsetUnits={3}
    />
  );

  if (hasTerrain) {
    return (
      <mesh
        position={[
          center.x,
          yPos - TERRAIN_BASE_SLAB_DEPTH / 2,
          center.z,
        ]}
        receiveShadow
      >
        <boxGeometry
          args={[halfW * 2, TERRAIN_BASE_SLAB_DEPTH, halfH * 2, 1, 1, 1]}
        />
        {material}
      </mesh>
    );
  }

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[center.x, yPos, center.z]}
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
  terrain,
  manifest,
  originLon,
  originLat,
  baseY,
  waterPolygons,
  surface,
  trackCoordinates,
  bbox,
  resolvedTheme,
}: {
  terrain: TerrainFile;
  manifest: EnvironmentManifest;
  originLon: number;
  originLat: number;
  baseY: number;
  waterPolygons: WaterPolygon[];
  surface: SurfaceFile | null;
  trackCoordinates: [number, number][];
  bbox: BBox;
  resolvedTheme: EnvironmentTheme;
}) {
  const geometry = useMemo(() => {
    const n = terrain.gridSize;
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
    const referenceElevation = terrainReferenceElevation(terrain);

    const themeColors = THEME_COLORS[resolvedTheme];
    const terrainTop = new THREE.Color(themeColors.terrain);
    const waterMasks = waterPolygons
      .map((poly) =>
        poly.points.map(([lon, lat]) =>
          lonLatToShapeXY(lon, lat, originLon, originLat),
        ),
      )
      .filter((poly) => poly.length >= 3 && polygonArea2D(poly) >= MIN_WATER_AREA_SQ_M);
    const trackPoints = trackCoordinates.map(([lon, lat]) =>
      lonLatToShapeXY(lon, lat, originLon, originLat),
    );
    const trackCarveRadiusSq =
      TERRAIN_TRACK_CARVE_RADIUS_M * TERRAIN_TRACK_CARVE_RADIUS_M;

    function isInsideTrackCarve(point: { x: number; y: number }): boolean {
      for (let i = 0; i < trackPoints.length - 1; i++) {
        if (
          distanceToSegmentSq2D(point, trackPoints[i], trackPoints[i + 1]) <=
          trackCarveRadiusSq
        ) {
          return true;
        }
      }
      if (trackPoints.length > 2) {
        return (
          distanceToSegmentSq2D(
            point,
            trackPoints[trackPoints.length - 1],
            trackPoints[0],
          ) <= trackCarveRadiusSq
        );
      }
      return false;
    }

    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const idx = row * n + col;
        const lon = minLon + ((maxLon - minLon) * col) / (n - 1);
        const lat = minLat + ((maxLat - minLat) * row) / (n - 1);
        const { x, z } = lonLatToXZ(lon, lat, originLon, originLat);
        const shapePoint = { x, y: -z };
        const h = terrain.heights[idx] ?? 0;
        const isWater =
          surface?.gridSize === n
            ? surface.waterMask[idx] === 1
            : waterMasks.some((mask) => isPointInPolygon(shapePoint, mask));
        const rawY = isWater ? 0 : terrainLocalHeight(h, referenceElevation);
        const y = isInsideTrackCarve(shapePoint)
          ? Math.max(0, rawY - TERRAIN_TRACK_CARVE_DEPTH_M)
          : rawY;
        positions.push(x, y, z);
        uvs.push(
          cols === 1 ? 0 : (col - colStart) / (cols - 1),
          rows === 1 ? 0 : (row - rowStart) / (rows - 1),
        );

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

    const sideTop = new THREE.Color(themeColors.sideTop);
    const sideBottom = new THREE.Color(themeColors.sideBottom);

    function appendSkirtSegment(a: number, b: number) {
      const base = positions.length / 3;
      const ax = positions[a * 3];
      const ay = positions[a * 3 + 1];
      const az = positions[a * 3 + 2];
      const bx = positions[b * 3];
      const by = positions[b * 3 + 1];
      const bz = positions[b * 3 + 2];

      positions.push(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        ax,
        TERRAIN_SKIRT_BOTTOM_Y,
        az,
        bx,
        TERRAIN_SKIRT_BOTTOM_Y,
        bz,
      );
      uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
      colors.push(
        sideTop.r,
        sideTop.g,
        sideTop.b,
        sideTop.r,
        sideTop.g,
        sideTop.b,
        sideBottom.r,
        sideBottom.g,
        sideBottom.b,
        sideBottom.r,
        sideBottom.g,
        sideBottom.b,
      );
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }

    for (let col = 0; col < cols - 1; col++) {
      appendSkirtSegment(col, col + 1);
      appendSkirtSegment((rows - 1) * cols + col + 1, (rows - 1) * cols + col);
    }
    for (let row = 0; row < rows - 1; row++) {
      appendSkirtSegment((row + 1) * cols, row * cols);
      appendSkirtSegment(row * cols + cols - 1, (row + 1) * cols + cols - 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [
    terrain,
    manifest,
    originLon,
    originLat,
    waterPolygons,
    surface,
    trackCoordinates,
    bbox,
    resolvedTheme,
  ]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} position={[0, baseY, 0]} receiveShadow>
      <meshStandardMaterial
        vertexColors
        roughness={0.92}
        metalness={0}
        flatShading
        side={THREE.DoubleSide}
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
    for (const road of roads) {
      if (road.points.length < 2) continue;
      for (let i = 0; i < road.points.length - 1; i++) {
        let [aLon, aLat] = road.points[i];
        let [bLon, bLat] = road.points[i + 1];
        if (bbox) {
          const clipped = clipSegmentToBBox([aLon, aLat], [bLon, bLat], bbox);
          if (!clipped) continue;
          [[aLon, aLat], [bLon, bLat]] = clipped;
        }
        const a = lonLatToXZ(aLon, aLat, originLon, originLat);
        const b = lonLatToXZ(bLon, bLat, originLon, originLat);
        const aY = terrainSampler
          ? baseY + terrainSampler.heightAt(aLon, aLat) + drapeY
          : baseY + flatY;
        const bY = terrainSampler
          ? baseY + terrainSampler.heightAt(bLon, bLat) + drapeY
          : baseY + flatY;
        positions.push(a.x, aY, a.z, b.x, bY, b.z);
      }
    }
    if (!positions.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [roads, originLon, originLat, terrainSampler, baseY, drapeY, flatY, bbox]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <lineSegments geometry={geometry} renderOrder={10}>
      <lineBasicMaterial
        color={THEME_COLORS[resolvedTheme].road}
        depthWrite={false}
        transparent
        opacity={0.72}
      />
    </lineSegments>
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
    return filtered.slice(0, MAX_BROADCAST_BUILDINGS);
  }, [buildings, bbox]);

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
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        color={THEME_COLORS[resolvedTheme].building}
        roughness={0.82}
        metalness={0}
        flatShading
        side={THREE.DoubleSide}
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
