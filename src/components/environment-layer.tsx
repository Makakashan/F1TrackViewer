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
} from "@/lib/environment-types";
import { DIORAMA_COLORS, landuseColor } from "@/lib/diorama-palette";

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

const TERRAIN_VERTICAL_SCALE = 0.4;

const VISIBLE_LANDUSE_KINDS = new Set<LandusePolygon["kind"]>([
  "park",
  "wood",
  "grass",
]);
const BOARD_MARGIN = 1.35;
const MIN_WATER_AREA_SQ_M = 2_500;

function polygonArea2D(points: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export interface EnvironmentLayerProps {
  bundle: EnvironmentBundle;
  originLon: number;
  originLat: number;
  /**
   * Vertical offset of the diorama base plane, in meters. The track mesh
   * already centers itself around y=0 with its lowest point at
   * `groundY = -peakY - trackWidth * 2 - 1`, so we want the diorama base to
   * sit at the same y so buildings rise from the track's ground level.
   */
  baseY?: number;
  /**
   * Show 3D terrain elevation mesh. Defaults to true.
   * When ON: terrain mesh is rendered with hills/valleys, and buildings/
   * water/roads are draped on the terrain heights.
   * When OFF: flat diorama — layers stacked with clear vertical separation.
   */
  showTerrain?: boolean;
}

export default function EnvironmentLayer({
  bundle,
  originLon,
  originLat,
  baseY = 0,
  showTerrain = true,
}: EnvironmentLayerProps) {
  const { manifest } = bundle;
  const hasTerrain = showTerrain && bundle.terrain.gridSize > 0;

  // Build a terrain sampler once — used by all draped layers to query the
  // elevation at any [lon, lat] point.
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
      />
      {hasTerrain && (
        <TerrainMesh
          terrain={bundle.terrain}
          manifest={manifest}
          originLon={originLon}
          originLat={originLat}
          baseY={baseY}
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
      />
      <WaterPolygons
        polygons={bundle.water.polygons}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        terrainSampler={terrainSampler}
        drapeY={LAYER_Y_DRAPE.water}
        flatY={LAYER_Y_FLAT.water}
      />
      <RoadLinesMesh
        roads={bundle.roads.roads}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        terrainSampler={terrainSampler}
        drapeY={LAYER_Y_DRAPE.roads}
        flatY={LAYER_Y_FLAT.roads}
      />
      <BuildingExtrusions
        buildings={bundle.buildings.buildings}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY}
        terrainSampler={terrainSampler}
        drapeY={LAYER_Y_DRAPE.buildings}
        flatY={LAYER_Y_FLAT.buildings}
      />
    </group>
  );
}

// ─── Terrain sampler ────────────────────────────────────────────────────────

interface TerrainSampler {
  /** Query terrain height (in local meters, before baseY offset) at [lon, lat]. */
  heightAt(lon: number, lat: number): number;
  /** Min/max terrain height across the grid, in local meters. */
  minHeight: number;
  maxHeight: number;
}

function buildTerrainSampler(
  terrain: TerrainFile,
  manifest: EnvironmentManifest,
): TerrainSampler {
  const n = terrain.gridSize;
  const minLon = manifest.bbox.minLon;
  const minLat = manifest.bbox.minLat;
  const maxLat = manifest.bbox.maxLat;
  const maxLon = manifest.bbox.maxLon;

  let minH = Infinity;
  let maxH = -Infinity;
  for (const h of terrain.heights) {
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const range = Math.max(1, maxH - minH);

  // Precompute local-meters height for each grid cell.
  const localHeights = new Float32Array(terrain.heights.length);
  for (let i = 0; i < terrain.heights.length; i++) {
    localHeights[i] = ((terrain.heights[i] - minH) / range) * TERRAIN_VERTICAL_SCALE * 100;
    // ×100 because range is in absolute meters (e.g. 454m) and we want the
    // terrain to occupy ~TERRAIN_VERTICAL_SCALE × range meters in the scene.
  }

  // Inverse: terrain heights are stored row-major, row 0 = minLat (south),
  // col 0 = minLon (west).
  function heightAt(lon: number, lat: number): number {
    if (n < 2) return 0;
    const u = (lon - minLon) / (maxLon - minLon); // 0..1 west→east
    const v = (lat - minLat) / (maxLat - minLat); // 0..1 south→north
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const fx = u * (n - 1);
    const fy = v * (n - 1);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const ix1 = Math.min(ix + 1, n - 1);
    const iy1 = Math.min(iy + 1, n - 1);
    const tx = fx - ix;
    const ty = fy - iy;
    const h00 = localHeights[iy * n + ix];
    const h10 = localHeights[iy * n + ix1];
    const h01 = localHeights[iy1 * n + ix];
    const h11 = localHeights[iy1 * n + ix1];
    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    return h0 * (1 - ty) + h1 * ty;
  }

  return {
    heightAt,
    minHeight: 0,
    maxHeight: TERRAIN_VERTICAL_SCALE * 100,
  };
}

// ─── DioramaBase ────────────────────────────────────────────────────────────

function DioramaBase({
  bundle,
  originLon,
  originLat,
  baseY,
  hasTerrain,
}: {
  bundle: EnvironmentBundle;
  originLon: number;
  originLat: number;
  baseY: number;
  hasTerrain: boolean;
}) {
  const { manifest } = bundle;
  const center = lonLatToXZ(
    manifest.center.lon,
    manifest.center.lat,
    originLon,
    originLat,
  );
  const halfW =
    (manifest
    ? Math.max(
        bundle.terrain.widthMeters / 2,
        ((manifest.bbox.maxLon - manifest.bbox.minLon) *
          111_320 *
          Math.cos((manifest.center.lat * Math.PI) / 180)) /
          2,
        ((manifest.bbox.maxLat - manifest.bbox.minLat) * 111_320) / 2,
      )
    : 500) * BOARD_MARGIN;

  // Grid texture drawn procedurally on a canvas — keeps the look of the
  // reference image: dark base, thin lighter grid lines.
  const gridTexture = useMemo(() => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = DIORAMA_COLORS.base;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = DIORAMA_COLORS.grid;
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
  }, []);

  useEffect(() => {
    return () => {
      gridTexture?.dispose();
    };
  }, [gridTexture]);

  // When terrain is on, lower the base plane so the terrain mesh sits above
  // it and forms the "ground" of the diorama.
  const yPos = baseY + (hasTerrain ? -2 : 0);

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[center.x, yPos, center.z]}
      receiveShadow
    >
      <planeGeometry args={[halfW * 2, halfW * 2, 1, 1]} />
      <meshStandardMaterial
        map={gridTexture}
        color={DIORAMA_COLORS.base}
        roughness={1}
        metalness={0}
        polygonOffset
        polygonOffsetFactor={3}
        polygonOffsetUnits={3}
      />
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
}: {
  terrain: TerrainFile;
  manifest: EnvironmentManifest;
  originLon: number;
  originLat: number;
  baseY: number;
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

    let minH = Infinity;
    let maxH = -Infinity;
    for (const h of terrain.heights) {
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    const range = Math.max(1, maxH - minH);
    // Same scale as the sampler so draped layers align with the mesh.
    const verticalScale = TERRAIN_VERTICAL_SCALE * 100;

    // Two-tone gradient: low elevations = darker (closer to base color),
    // high elevations = lighter. Matches the white-on-dark diorama style.
    const colorLow = new THREE.Color("#2A2D33");
    const colorMid = new THREE.Color("#7A7D82");
    const colorHigh = new THREE.Color("#E8E8E8");
    const tmp = new THREE.Color();

    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const idx = row * n + col;
        const lon = minLon + ((maxLon - minLon) * col) / (n - 1);
        const lat = minLat + ((maxLat - minLat) * row) / (n - 1);
        const { x, z } = lonLatToXZ(lon, lat, originLon, originLat);
        const h = terrain.heights[idx] ?? minH;
        const t = (h - minH) / range; // 0..1
        const y = t * verticalScale;
        positions.push(x, y, z);
        uvs.push(col / (n - 1), row / (n - 1));

        // Three-stop gradient: dark → mid → light
        if (t < 0.5) {
          tmp.copy(colorLow).lerp(colorMid, t * 2);
        } else {
          tmp.copy(colorMid).lerp(colorHigh, (t - 0.5) * 2);
        }
        colors.push(tmp.r, tmp.g, tmp.b);
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

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [terrain, manifest, originLon, originLat]);

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
}: {
  polygons: WaterPolygon[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
}) {
  const geometry = useMemo(() => {
    const shapes: THREE.Shape[] = [];
    for (const poly of polygons) {
      if (poly.points.length < 3) continue;
      const projected = poly.points.map(([lon, lat]) =>
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
    return drapeShapeGeometry(shapes, originLon, originLat, terrainSampler, baseY, drapeY, flatY);
  }, [polygons, originLon, originLat, terrainSampler, baseY, drapeY, flatY]);

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
}: {
  polygons: LandusePolygon[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
}) {
  // Group only visible green-space polygons by color. Neutral landuse
  // polygons overlap heavily in OSM and cause z-fighting, so the base board
  // represents the generic city floor instead.
  const groups = useMemo(() => {
    const map = new Map<string, LandusePolygon[]>();
    for (const p of polygons) {
      if (!VISIBLE_LANDUSE_KINDS.has(p.kind)) continue;
      const color = landuseColor(p.kind);
      if (!map.has(color)) map.set(color, []);
      map.get(color)!.push(p);
    }
    return Array.from(map.entries());
  }, [polygons]);

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
}: {
  color: string;
  polygons: LandusePolygon[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
}) {
  const geometry = useMemo(() => {
    const shapes: THREE.Shape[] = [];
    for (const poly of polygons) {
      if (poly.points.length < 3) continue;
      const shape = new THREE.Shape();
      poly.points.forEach(([lon, lat], i) => {
        const { x, y } = lonLatToShapeXY(lon, lat, originLon, originLat);
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      });
      shape.closePath();
      shapes.push(shape);
    }
    return drapeShapeGeometry(shapes, originLon, originLat, terrainSampler, baseY, drapeY, flatY);
  }, [polygons, originLon, originLat, terrainSampler, baseY, drapeY, flatY]);

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
}: {
  roads: RoadLine[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
}) {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const yOffset = terrainSampler ? drapeY : flatY;
    for (const road of roads) {
      if (road.points.length < 2) continue;
      for (let i = 0; i < road.points.length - 1; i++) {
        const a = lonLatToXZ(road.points[i][0], road.points[i][1], originLon, originLat);
        const b = lonLatToXZ(
          road.points[i + 1][0],
          road.points[i + 1][1],
          originLon,
          originLat,
        );
        const ha = terrainSampler
          ? terrainSampler.heightAt(road.points[i][0], road.points[i][1])
          : 0;
        const hb = terrainSampler
          ? terrainSampler.heightAt(road.points[i + 1][0], road.points[i + 1][1])
          : 0;
        positions.push(a.x, baseY + ha + yOffset, a.z, b.x, baseY + hb + yOffset, b.z);
      }
    }
    if (!positions.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [roads, originLon, originLat, terrainSampler, baseY, drapeY, flatY]);

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
}: {
  buildings: BuildingFeature[];
  originLon: number;
  originLat: number;
  baseY: number;
  terrainSampler: TerrainSampler | null;
  drapeY: number;
  flatY: number;
}) {
  const capped = useMemo(() => buildings.slice(0, 800), [buildings]);

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
        color={DIORAMA_COLORS.building}
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
