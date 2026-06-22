"use client";

import { useMemo, useEffect } from "react";
import * as THREE from "three";
import type {
  EnvironmentBundle,
  BuildingFeature,
  WaterPolygon,
  RoadLine,
  LandusePolygon,
  TerrainFile,
  EnvironmentManifest,
  SurfaceFile,
} from "@/lib/environment-types";
import { DIORAMA_COLORS, landuseColor } from "@/lib/diorama-palette";
import {
  buildTerrainSampler,
  TERRAIN_VERTICAL_SCALE,
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

const VISIBLE_LANDUSE_KINDS = new Set<LandusePolygon["kind"]>([
  "park",
  "wood",
  "grass",
]);
const MIN_WATER_AREA_SQ_M = 2_500;
const TERRAIN_SKIRT_BOTTOM_Y = -2;
const TERRAIN_BASE_SLAB_DEPTH = 10;
const TERRAIN_TRACK_CARVE_RADIUS_M = 18;
const TERRAIN_TRACK_CARVE_DEPTH_M = 2.5;

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

type LonLat = [number, number];

function clipPolygonToBBox(points: LonLat[], bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number }): LonLat[] {
  if (points.length < 3) return points;
  let out = points.slice();
  const edges: [((p: LonLat) => number), number][] = [
    [(p) => p[0], bbox.minLon],
    [(p) => -p[0], -bbox.maxLon],
    [(p) => p[1], bbox.minLat],
    [(p) => -p[1], -bbox.maxLat],
  ];
  for (const [axis, val] of edges) {
    if (out.length < 3) return out;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const cInside = axis(cur) >= val;
      const pInside = axis(prev) >= val;
      if (cInside) {
        if (!pInside) {
          const denom = axis(cur) - axis(prev);
          if (denom !== 0) {
            const t = (val - axis(prev)) / denom;
            out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
          }
        }
        out.push(cur);
      } else if (pInside) {
        const denom = axis(cur) - axis(prev);
        if (denom !== 0) {
          const t = (val - axis(prev)) / denom;
          out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
        }
      }
    }
  }
  return out;
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
  resolvedTheme?: "light" | "dark";
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
        bundle={bundle}
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
          resolvedTheme={resolvedTheme}
          waterPolygons={bundle.water.polygons}
          surface={bundle.surface}
          trackCoordinates={trackCoordinates}
        />
      )}
      <LandusePolygons
        polygons={bundle.landuse.polygons}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        terrainSampler={terrainSampler}
        drapeY={LAYER_Y_DRAPE.landuse}
        flatY={LAYER_Y_FLAT.landuse}
        bbox={manifest.bbox}
      />
      <WaterPolygons
        polygons={bundle.water.polygons}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        terrainSampler={terrainSampler}
        drapeY={LAYER_Y_DRAPE.water}
        flatY={LAYER_Y_FLAT.water}
        bbox={manifest.bbox}
      />
      <RoadLinesMesh
        roads={bundle.roads.roads}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        terrainSampler={terrainSampler}
        drapeY={LAYER_Y_DRAPE.roads}
        flatY={LAYER_Y_FLAT.roads}
        bbox={manifest.bbox}
      />
      <BuildingExtrusions
        buildings={bundle.buildings.buildings}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        terrainSampler={terrainSampler}
        drapeY={LAYER_Y_DRAPE.buildings}
        flatY={LAYER_Y_FLAT.buildings}
        bbox={hasTerrain ? manifest.bbox : null}
        resolvedTheme={resolvedTheme}
      />
    </group>
  );
}

// ─── DioramaBase ────────────────────────────────────────────────────────────

function DioramaBase({
  bundle,
  originLon,
  originLat,
  baseY,
  hasTerrain,
  resolvedTheme,
}: {
  bundle: EnvironmentBundle;
  originLon: number;
  originLat: number;
  baseY: number;
  hasTerrain: boolean;
  resolvedTheme: "light" | "dark";
}) {
  const { manifest } = bundle;
  const center = lonLatToXZ(
    manifest.center.lon,
    manifest.center.lat,
    originLon,
    originLat,
  );
  const halfW =
    ((manifest.bbox.maxLon - manifest.bbox.minLon) *
      111_320 *
      Math.cos((manifest.center.lat * Math.PI) / 180)) /
    2;
  const halfH =
    ((manifest.bbox.maxLat - manifest.bbox.minLat) * 111_320) / 2;

  const isDark = resolvedTheme === "dark";

  // Grid texture drawn procedurally on a canvas — keeps the look of the
  // reference image: dark base, thin lighter grid lines.
  const gridTexture = useMemo(() => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = isDark ? "#1a1e24" : DIORAMA_COLORS.base;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = isDark ? "#2a2e36" : DIORAMA_COLORS.grid;
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
  }, [isDark]);

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
      color={hasTerrain ? (isDark ? "#111111" : "#C8CDD6") : DIORAMA_COLORS.base}
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
  resolvedTheme,
  waterPolygons,
  surface,
  trackCoordinates,
}: {
  terrain: TerrainFile;
  manifest: EnvironmentManifest;
  originLon: number;
  originLat: number;
  baseY: number;
  resolvedTheme: "light" | "dark";
  waterPolygons: WaterPolygon[];
  surface: SurfaceFile | null;
  trackCoordinates: [number, number][];
}) {
  const geometry = useMemo(() => {
    const n = terrain.gridSize;
    if (n < 2) return null;
    const minLon = manifest.bbox.minLon;
    const minLat = manifest.bbox.minLat;
    const maxLat = manifest.bbox.maxLat;
    const maxLon = manifest.bbox.maxLon;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];

    const terrainTop = new THREE.Color(resolvedTheme === "dark" ? "#565656" : "#F3F5F9");
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

    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
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
        const rawY = isWater ? 0 : Math.max(0, h) * TERRAIN_VERTICAL_SCALE;
        const y = isInsideTrackCarve(shapePoint)
          ? Math.max(0, rawY - TERRAIN_TRACK_CARVE_DEPTH_M)
          : rawY;
        positions.push(x, y, z);
        uvs.push(col / (n - 1), row / (n - 1));

        colors.push(terrainTop.r, terrainTop.g, terrainTop.b);
      }
    }

    for (let row = 0; row < n - 1; row++) {
      for (let col = 0; col < n - 1; col++) {
        const a = row * n + col;
        const b = row * n + col + 1;
        const c = (row + 1) * n + col;
        const d = (row + 1) * n + col + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    const sideTop = new THREE.Color(resolvedTheme === "dark" ? "#444444" : "#C7CDD8");
    const sideBottom = new THREE.Color(resolvedTheme === "dark" ? "#202020" : "#6F7784");

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

    for (let col = 0; col < n - 1; col++) {
      appendSkirtSegment(col, col + 1);
      appendSkirtSegment((n - 1) * n + col + 1, (n - 1) * n + col);
    }
    for (let row = 0; row < n - 1; row++) {
      appendSkirtSegment((row + 1) * n, row * n);
      appendSkirtSegment(row * n + n - 1, (row + 1) * n + n - 1);
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
    resolvedTheme,
    waterPolygons,
    surface,
    trackCoordinates,
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

// ─── Draped polygon builder ─────────────────────────────────────────────────
//
// When terrain is on, polygons (water, landuse) are triangulated as a 2D
// ShapeGeometry, then each vertex is displaced vertically by the terrain
// height at its [x, z]. This drapes the polygon onto the terrain.

function drapeShapeGeometry(
  shapes: THREE.Shape[],
  originLon: number,
  originLat: number,
  terrainSampler: TerrainSampler | null,
  baseY: number,
  drapeY: number,
  flatY: number,
): THREE.BufferGeometry | null {
  if (!shapes.length) return null;
  const geo = new THREE.ShapeGeometry(shapes);
  if (!terrainSampler) {
    // Flat mode — just lift the whole geometry to flatY.
    geo.translate(0, 0, 0);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, baseY + flatY, 0);
    return geo;
  }
  // Drape mode: rotate to XZ plane first, then for each vertex compute the
  // [lon, lat] back from [x, z] and sample terrain height.
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const metersPerDegLat = 111_320;
  const metersPerDegLon = 111_320 * Math.cos((originLat * Math.PI) / 180);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const lon = originLon + x / metersPerDegLon;
    const lat = originLat - z / metersPerDegLat;
    const h = terrainSampler.heightAt(lon, lat);
    pos.setY(i, baseY + h + drapeY);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// ─── WaterPolygons ──────────────────────────────────────────────────────────

function WaterPolygons({
  polygons,
  originLon,
  originLat,
  baseY,
  terrainSampler,
  drapeY,
  flatY,
  bbox,
}: {
  polygons: WaterPolygon[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
  bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null;
}) {
  const geometry = useMemo(() => {
    const shapes: THREE.Shape[] = [];
    for (const poly of polygons) {
      if (poly.points.length < 3) continue;
      const pts = bbox ? clipPolygonToBBox(poly.points, bbox) : poly.points;
      if (pts.length < 3) continue;
      const projected = pts.map(([lon, lat]) =>
        lonLatToShapeXY(lon, lat, originLon, originLat),
      );
      if (polygonArea2D(projected) < MIN_WATER_AREA_SQ_M) continue;
      const shape = new THREE.Shape();
      projected.forEach(({ x, y }, i) => {
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      });
      shape.closePath();
      shapes.push(shape);
    }
    if (!shapes.length) return null;
    const geo = new THREE.ShapeGeometry(shapes);
    geo.rotateX(-Math.PI / 2);
    if (terrainSampler) {
      const pos = geo.getAttribute("position") as THREE.BufferAttribute;
      const waterY = baseY + 0.1;
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, waterY);
      }
      pos.needsUpdate = true;
    } else {
      geo.translate(0, baseY + flatY, 0);
    }
    return geo;
  }, [polygons, originLon, originLat, terrainSampler, baseY, drapeY, flatY, bbox]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  // When terrain is on, WaterPolygons is already rotated+positioned inside
  // drapeShapeGeometry. When off, ditto. So no extra rotation here.
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={DIORAMA_COLORS.water}
        roughness={0.4}
        metalness={0.2}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}

// ─── LandusePolygons ────────────────────────────────────────────────────────

function LandusePolygons({
  polygons,
  originLon,
  originLat,
  baseY,
  terrainSampler,
  drapeY,
  flatY,
  bbox,
}: {
  polygons: LandusePolygon[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
  bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null;
}) {
  const groups = useMemo(() => {
    if (terrainSampler) return [];
    const map = new Map<string, LandusePolygon[]>();
    for (const p of polygons) {
      if (!VISIBLE_LANDUSE_KINDS.has(p.kind)) continue;
      if (bbox && p.points.length >= 3) {
        let sumLon = 0, sumLat = 0;
        for (const [lon, lat] of p.points) { sumLon += lon; sumLat += lat; }
        const cLon = sumLon / p.points.length;
        const cLat = sumLat / p.points.length;
        if (cLon < bbox.minLon || cLon > bbox.maxLon || cLat < bbox.minLat || cLat > bbox.maxLat) continue;
      }
      const color = landuseColor(p.kind);
      if (!map.has(color)) map.set(color, []);
      map.get(color)!.push(p);
    }
    return Array.from(map.entries());
  }, [polygons, terrainSampler, bbox]);

  if (!groups.length) return null;

  return (
    <group>
      {groups.map(([color, group]) => (
        <LanduseGroup
          key={color}
          color={color}
          polygons={group}
          originLon={originLon}
          originLat={originLat}
          baseY={baseY}
          terrainSampler={terrainSampler}
          drapeY={drapeY}
          flatY={flatY}
          bbox={bbox}
        />
      ))}
    </group>
  );
}

function LanduseGroup({
  color,
  polygons,
  originLon,
  originLat,
  baseY,
  terrainSampler,
  drapeY,
  flatY,
  bbox,
}: {
  color: string;
  polygons: LandusePolygon[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
  bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null;
}) {
  const geometry = useMemo(() => {
    const shapes: THREE.Shape[] = [];
    for (const poly of polygons) {
      if (poly.points.length < 3) continue;
      const pts = bbox ? clipPolygonToBBox(poly.points, bbox) : poly.points;
      if (pts.length < 3) continue;
      const shape = new THREE.Shape();
      pts.forEach(([lon, lat], i) => {
        const { x, y } = lonLatToShapeXY(lon, lat, originLon, originLat);
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      });
      shape.closePath();
      shapes.push(shape);
    }
    return drapeShapeGeometry(shapes, originLon, originLat, terrainSampler, baseY, drapeY, flatY);
  }, [polygons, originLon, originLat, terrainSampler, baseY, drapeY, flatY, bbox]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={color}
        roughness={1}
        metalness={0}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={-3}
        polygonOffsetUnits={-3}
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
}: {
  roads: RoadLine[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
  bbox?: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null;
}) {
  const geometry = useMemo(() => {
    if (terrainSampler) return null;
    const positions: number[] = [];
    for (const road of roads) {
      if (road.points.length < 2) continue;
      for (let i = 0; i < road.points.length - 1; i++) {
        const [aLon, aLat] = road.points[i];
        const [bLon, bLat] = road.points[i + 1];
        if (bbox) {
          const aIn = aLon >= bbox.minLon && aLon <= bbox.maxLon && aLat >= bbox.minLat && aLat <= bbox.maxLat;
          const bIn = bLon >= bbox.minLon && bLon <= bbox.maxLon && bLat >= bbox.minLat && bLat <= bbox.maxLat;
          if (!aIn && !bIn) continue;
        }
        const a = lonLatToXZ(aLon, aLat, originLon, originLat);
        const b = lonLatToXZ(bLon, bLat, originLon, originLat);
        positions.push(a.x, baseY + flatY, a.z, b.x, baseY + flatY, b.z);
      }
    }
    if (!positions.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [roads, originLon, originLat, terrainSampler, baseY, flatY, bbox]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <lineSegments geometry={geometry} renderOrder={10}>
      <lineBasicMaterial
        color={DIORAMA_COLORS.road}
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
  resolvedTheme: "light" | "dark";
}) {
  const capped = useMemo(() => {
    let filtered = buildings.slice(0, 800);
    if (bbox) {
      filtered = filtered.filter((b) => {
        if (b.footprint.length < 3) return false;
        let sumLon = 0, sumLat = 0;
        for (const [lon, lat] of b.footprint) {
          sumLon += lon;
          sumLat += lat;
        }
        const cLon = sumLon / b.footprint.length;
        const cLat = sumLat / b.footprint.length;
        return (
          cLon >= bbox.minLon &&
          cLon <= bbox.maxLon &&
          cLat >= bbox.minLat &&
          cLat <= bbox.maxLat
        );
      });
    }
    return filtered;
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
      const height = Math.min(rawHeight, 50);
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
        color={resolvedTheme === "dark" ? "#B6B6B6" : DIORAMA_COLORS.building}
        roughness={0.85}
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
