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

/**
 * Y offsets between diorama layers, in meters.
 *
 * These are deliberately SPREAD OUT (5–10 m apart) to eliminate z-fighting
 * flicker when the camera orbits. The reference look is a flat architectural
 * model, so we don't try to drape layers on terrain — we stack them with
 * clear vertical separation and let the track ribbon sit on top.
 */
const LAYER_Y = {
  base: 0, // dark grid plane
  landuse: 0.5, // parks/woods/grass
  water: 1.0, // harbour / coastline
  roads: 1.5, // street grid
  buildings: 2.0, // building footprints start here
  trackOverlay: 60, // track ribbon floats above the city
} as const;

export interface EnvironmentLayerProps {
  bundle: EnvironmentBundle;
  /**
   * Vertical offset of the diorama base plane, in meters. The track mesh
   * already centers itself around y=0 with its lowest point at
   * `groundY = -peakY - trackWidth * 2 - 1`, so we want the diorama base to
   * sit at the same y so buildings rise from the track's ground level.
   */
  baseY?: number;
  /**
   * Show terrain elevation mesh. Defaults to false — the reference diorama
   * style is a flat architectural model, and a 3D terrain mesh z-fights
   * with the grid base and hides the track. Enable only if the circuit
   * has dramatic elevation that benefits from a 3D hill.
   */
  showTerrain?: boolean;
}

export default function EnvironmentLayer({
  bundle,
  baseY = 0,
  showTerrain = false,
}: EnvironmentLayerProps) {
  const { manifest } = bundle;
  const originLon = manifest.center.lon;
  const originLat = manifest.center.lat;

  return (
    <group>
      <DioramaBase bundle={bundle} baseY={baseY} />
      {showTerrain && bundle.terrain.gridSize > 0 && (
        <TerrainMesh terrain={bundle.terrain} manifest={manifest} baseY={baseY} />
      )}
      <LandusePolygons
        polygons={bundle.landuse.polygons}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY + LAYER_Y.landuse}
      />
      <WaterPolygons
        polygons={bundle.water.polygons}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY + LAYER_Y.water}
      />
      <RoadLinesMesh
        roads={bundle.roads.roads}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY + LAYER_Y.roads}
      />
      <BuildingExtrusions
        buildings={bundle.buildings.buildings}
        originLon={originLon}
        originLat={originLat}
        baseY={baseY + LAYER_Y.buildings}
      />
    </group>
  );
}

// ─── DioramaBase ────────────────────────────────────────────────────────────

function DioramaBase({
  bundle,
  baseY,
}: {
  bundle: EnvironmentBundle;
  baseY: number;
}) {
  const { manifest } = bundle;
  const halfW = manifest
    ? Math.max(
        bundle.terrain.widthMeters / 2,
        ((manifest.bbox.maxLon - manifest.bbox.minLon) *
          111_320 *
          Math.cos((manifest.center.lat * Math.PI) / 180)) /
          2,
        ((manifest.bbox.maxLat - manifest.bbox.minLat) * 111_320) / 2,
      )
    : 500;

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

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, baseY + LAYER_Y.base, 0]}
      receiveShadow
    >
      <planeGeometry args={[halfW * 2, halfW * 2, 1, 1]} />
      <meshStandardMaterial
        map={gridTexture}
        color={DIORAMA_COLORS.base}
        roughness={1}
        metalness={0}
      />
    </mesh>
  );
}

// ─── TerrainMesh ────────────────────────────────────────────────────────────
//
// Only rendered when showTerrain=true. Subtle vertical scale (15 m max) so
// the city still reads as a flat diorama but hills are hinted at.

function TerrainMesh({
  terrain,
  manifest,
  baseY,
}: {
  terrain: TerrainFile;
  manifest: EnvironmentManifest;
  baseY: number;
}) {
  const geometry = useMemo(() => {
    const n = terrain.gridSize;
    if (n < 2) return null;
    const minLon = manifest.bbox.minLon;
    const minLat = manifest.bbox.minLat;
    const maxLat = manifest.bbox.maxLat;
    const maxLon = manifest.bbox.maxLon;
    const originLon = manifest.center.lon;
    const originLat = manifest.center.lat;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    let minH = Infinity;
    let maxH = -Infinity;
    for (const h of terrain.heights) {
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    const range = Math.max(1, maxH - minH);
    const verticalScale = 15; // subtle elevation hint, not a real hill

    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const idx = row * n + col;
        const lon = minLon + ((maxLon - minLon) * col) / (n - 1);
        const lat = minLat + ((maxLat - minLat) * row) / (n - 1);
        const { x, z } = lonLatToXZ(lon, lat, originLon, originLat);
        const h = terrain.heights[idx] ?? minH;
        const y = ((h - minH) / range) * verticalScale;
        positions.push(x, y, z);
        uvs.push(col / (n - 1), row / (n - 1));
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
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [terrain, manifest]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} position={[0, baseY, 0]} receiveShadow>
      <meshStandardMaterial
        color={DIORAMA_COLORS.terrain}
        roughness={0.92}
        metalness={0}
        flatShading
      />
    </mesh>
  );
}

// ─── WaterPolygons ──────────────────────────────────────────────────────────

function WaterPolygons({
  polygons,
  originLon,
  originLat,
  baseY,
}: {
  polygons: WaterPolygon[];
  originLon: number;
  originLat: number;
  baseY: number;
}) {
  const geometry = useMemo(() => {
    const shapes: THREE.Shape[] = [];
    for (const poly of polygons) {
      if (poly.points.length < 3) continue;
      const shape = new THREE.Shape();
      poly.points.forEach(([lon, lat], i) => {
        const { x, z } = lonLatToXZ(lon, lat, originLon, originLat);
        if (i === 0) shape.moveTo(x, z);
        else shape.lineTo(x, z);
      });
      shape.closePath();
      shapes.push(shape);
    }
    if (!shapes.length) return null;
    const geo = new THREE.ShapeGeometry(shapes);
    return geo;
  }, [polygons, originLon, originLat]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh
      geometry={geometry}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, baseY, 0]}
    >
      <meshStandardMaterial
        color={DIORAMA_COLORS.water}
        roughness={0.4}
        metalness={0.2}
        side={THREE.DoubleSide}
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
}: {
  polygons: LandusePolygon[];
  originLon: number;
  originLat: number;
  baseY: number;
}) {
  // Group polygons by color so we can build one merged geometry per color
  // (cuts draw calls from 200+ down to ~7).
  const groups = useMemo(() => {
    const map = new Map<string, LandusePolygon[]>();
    for (const p of polygons) {
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
}: {
  color: string;
  polygons: LandusePolygon[];
  originLon: number;
  originLat: number;
  baseY: number;
}) {
  const geometry = useMemo(() => {
    const shapes: THREE.Shape[] = [];
    for (const poly of polygons) {
      if (poly.points.length < 3) continue;
      const shape = new THREE.Shape();
      poly.points.forEach(([lon, lat], i) => {
        const { x, z } = lonLatToXZ(lon, lat, originLon, originLat);
        if (i === 0) shape.moveTo(x, z);
        else shape.lineTo(x, z);
      });
      shape.closePath();
      shapes.push(shape);
    }
    if (!shapes.length) return null;
    return new THREE.ShapeGeometry(shapes);
  }, [polygons, originLon, originLat]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh
      geometry={geometry}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, baseY, 0]}
    >
      <meshStandardMaterial
        color={color}
        roughness={1}
        metalness={0}
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
}: {
  roads: RoadLine[];
  originLon: number;
  originLat: number;
  baseY: number;
}) {
  const geometry = useMemo(() => {
    const positions: number[] = [];
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
        positions.push(a.x, 0, a.z, b.x, 0, b.z);
      }
    }
    if (!positions.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [roads, originLon, originLat]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <lineSegments geometry={geometry} position={[0, baseY, 0]}>
      <lineBasicMaterial color={DIORAMA_COLORS.road} />
    </lineSegments>
  );
}

// ─── BuildingExtrusions ─────────────────────────────────────────────────────

function BuildingExtrusions({
  buildings,
  originLon,
  originLat,
  baseY,
}: {
  buildings: BuildingFeature[];
  originLon: number;
  originLat: number;
  baseY: number;
}) {
  // Cap to keep the vertex count browser-friendly. Generator already caps
  // at 800 but we double-check here for safety with hand-edited files.
  const capped = useMemo(() => buildings.slice(0, 800), [buildings]);

  // Build a single merged geometry for all buildings. Each footprint becomes
  // an ExtrudeGeometry that we rotate so the extrusion axis maps to +Y.
  const geometry = useMemo(() => {
    const geos: THREE.BufferGeometry[] = [];
    for (const b of capped) {
      if (b.footprint.length < 3) continue;
      const shape = new THREE.Shape();
      b.footprint.forEach(([lon, lat], i) => {
        const { x, z } = lonLatToXZ(lon, lat, originLon, originLat);
        if (i === 0) shape.moveTo(x, z);
        else shape.lineTo(x, z);
      });
      shape.closePath();
      // Clamp building height so no single tower pokes through the track
      // ribbon (which floats at LAYER_Y.trackOverlay = 60 m above baseY).
      const rawHeight = Math.max(2, b.height);
      const height = Math.min(rawHeight, 50);
      const extrude = new THREE.ExtrudeGeometry(shape, {
        depth: height,
        bevelEnabled: false,
        steps: 1,
      });
      // ExtrudeGeometry extrudes along +Z. Rotate so depth maps to -Y, then
      // translate down so footprints sit on y=0 and roofs point upward.
      extrude.rotateX(-Math.PI / 2);
      extrude.translate(0, -height, 0);
      geos.push(extrude);
    }
    if (!geos.length) return null;
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    return merged;
  }, [capped, originLon, originLat]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} position={[0, baseY, 0]} castShadow receiveShadow>
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
