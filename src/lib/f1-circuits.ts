/**
 * Helpers for the bacinger/f1-circuits GeoJSON dataset.
 * Source: https://github.com/bacinger/f1-circuits (MIT)
 *
 * Each circuit is a closed LineString of [lon, lat] coordinates.
 * Files are stored under circuits/{country}-{openedYear}.geojson
 */

const RAW_BASE =
  "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
const LOCATIONS_URL = `${RAW_BASE}/f1-locations.json`;

export interface CircuitLocation {
  /** Circuit id, e.g. "mc-1929" — matches the file stem under circuits/*.geojson */
  id: string;
  name: string;
  location: string;
  lat: number;
  lon: number;
  zoom: number;
}

export interface CircuitProperties {
  id: string;
  Location: string;
  Name: string;
  opened: number;
  firstgp: number;
  length: number; // meters
  altitude: number; // meters
}

export interface CircuitFeature {
  type: "Feature";
  properties: CircuitProperties;
  bbox: [number, number, number, number];
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
}

export interface CircuitGeoJSON {
  type: "FeatureCollection";
  name: string;
  bbox: [number, number, number, number];
  features: CircuitFeature[];
}

/**
 * Fetch the lightweight circuit index (~5KB JSON) — id, name, location, lat/lon, zoom
 * for every circuit in the dataset.
 */
export async function fetchCircuitIndex(): Promise<CircuitLocation[]> {
  const res = await fetch(LOCATIONS_URL, { next: { revalidate: 86400 } });
  if (!res.ok) throw new Error(`Failed to fetch circuit index: ${res.status}`);
  return res.json();
}

/**
 * Build the raw GitHub URL for a single circuit's GeoJSON file.
 */
export function circuitGeoJsonUrl(id: string): string {
  return `${RAW_BASE}/circuits/${id}.geojson`;
}

/**
 * Fetch a single circuit's GeoJSON by id.
 */
export async function fetchCircuitGeoJson(
  id: string,
): Promise<CircuitGeoJSON> {
  const res = await fetch(circuitGeoJsonUrl(id), {
    next: { revalidate: 86400 },
  });
  if (!res.ok)
    throw new Error(`Failed to fetch circuit ${id}: ${res.status}`);
  return res.json();
}

/**
 * ISO-3166-1 alpha-2 → flag emoji. Used in the sidebar list.
 */
export function countryFlag(iso2: string): string {
  if (!iso2 || iso2.length !== 2) return "🏳️";
  const codePoints = iso2
    .toUpperCase()
    .split("")
    .map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

/**
 * Parse the country code from a circuit id like "mc-1929" → "mc".
 */
export function countryFromId(id: string): string {
  return id.split("-")[0].toLowerCase();
}
