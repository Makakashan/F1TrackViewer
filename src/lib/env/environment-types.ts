/** Static environment layer schema for generated circuit dioramas. */

export interface EnvironmentManifest {
  schemaVersion: 1;
  circuitId: string;
  style: "low-poly-diorama";
  sources: {
    buildings: "openstreetmap";
    water: "openstreetmap";
    roads: "openstreetmap";
    landuse: "openstreetmap";
    terrain: "open-meteo-elevation";
  };
  attribution: string;
  center: { lon: number; lat: number };
  bbox: {
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
  };
  paddingMeters: number;
  generatedAt: string;
}

export interface BuildingFeature {
  id: string;
  kind: "building" | "grandstand" | "garage" | "shed";
  height: number;
  footprint: [number, number][];
}

export interface BuildingsFile {
  schemaVersion: 1;
  circuitId: string;
  buildings: BuildingFeature[];
}

export interface WaterPolygon {
  id: string;
  kind: "water";
  points: [number, number][];
}

export interface WaterFile {
  schemaVersion: 1;
  circuitId: string;
  polygons: WaterPolygon[];
}

export interface RoadLine {
  id: string;
  kind: "road";
  highway: string;
  points: [number, number][];
}

export interface RoadsFile {
  schemaVersion: 1;
  circuitId: string;
  roads: RoadLine[];
}

export interface LandusePolygon {
  id: string;
  kind: "park" | "wood" | "grass" | "residential" | "commercial" | "industrial" | "other";
  landuse?: string;
  points: [number, number][];
}

export interface LanduseFile {
  schemaVersion: 1;
  circuitId: string;
  polygons: LandusePolygon[];
}

export interface TerrainFile {
  schemaVersion: 1;
  circuitId: string;
  gridSize: number;
  widthMeters: number;
  heightMeters: number;
  minElevation: number;
  maxElevation: number;
  /** Row-major heights (length = gridSize gridSize). */
  heights: number[];
}

export interface SurfaceFile {
  schemaVersion: 1;
  circuitId: string;
  gridSize: number;
  seaLevelMeters: number;
  floodThresholdMeters: number;
  /** Row-major mask matching terrain.json. */
  waterMask: number[];
}

export interface EnvironmentBundle {
  manifest: EnvironmentManifest;
  buildings: BuildingsFile;
  water: WaterFile;
  roads: RoadsFile;
  landuse: LanduseFile;
  terrain: TerrainFile;
  surface: SurfaceFile | null;
}

export interface EnvironmentIndex {
  schemaVersion: 1;
  circuitIds: string[];
}

export const ENVIRONMENT_ATTRIBUTION = "© OpenStreetMap contributors";
