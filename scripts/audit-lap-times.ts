/**
 * Does the speed model produce plausible lap times?
 *
 * Builds each circuit's curve exactly as the scene does, runs the speed
 * profile over it, and prints the ideal lap time next to a real qualifying
 * lap. The four constants in speed-profile.ts are the entire model, so this
 * is the only check that tells us they are wrong before a user sees a car
 * take Eau Rouge at 40 km/h.
 *
 * Reference times are pole laps from recent races, in seconds. They live here
 * rather than in public/track-markers because the marker files only record
 * which session a lap came from, not how long it took.
 *
 * Historic layouts (Reims, Riverside, the 1909 Brickyard…) have no reference:
 * the geometry is real but no F1 car of this era ever drove it, so there is
 * nothing to compare against and they are reported without a verdict.
 *
 *   bun scripts/audit-lap-times.ts
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildTrackCurve, computeBounds } from "../src/lib/geo-utils";
import { buildSpeedProfile, idealLapTime } from "../src/lib/speed-profile";

const RAW_BASE = "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
const CACHE_DIR = ".cache/circuit-geojson";
/** Beyond this the model is wrong, not merely imprecise. */
const TOLERANCE = 0.15;

/** Pole laps, in seconds. */
const REFERENCE_LAP_S: Record<string, number> = {
  "ae-2009": 83.5, // Abu Dhabi
  "at-1969": 64.3, // Red Bull Ring
  "au-1953": 75.9, // Melbourne
  "az-2016": 101.4, // Baku
  "be-1925": 104.0, // Spa
  "bh-2002": 89.2, // Bahrain
  "br-1977": 69.5, // Interlagos
  "ca-1978": 72.0, // Montreal
  "cn-2004": 93.6, // Shanghai
  "es-1991": 71.4, // Barcelona
  "gb-1948": 85.8, // Silverstone
  "hu-1986": 75.2, // Hungaroring
  "it-1922": 79.8, // Monza
  "it-1953": 74.7, // Imola
  "jp-1962": 88.2, // Suzuka
  "mc-1929": 70.3, // Monaco
  "mx-1962": 76.0, // Mexico City
  "nl-1948": 70.6, // Zandvoort
  "qa-2004": 80.5, // Losail
  "sa-2021": 87.5, // Jeddah
  "sg-2008": 89.5, // Singapore
  "us-2012": 92.5, // COTA
  "us-2022": 87.4, // Miami
  "us-2023": 92.7, // Las Vegas
};

interface CircuitIndexEntry {
  id: string;
  name: string;
}

async function fetchGeoJson(id: string) {
  const path = `${CACHE_DIR}/${id}.geojson`;
  if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  const res = await fetch(`${RAW_BASE}/circuits/${id}.geojson`);
  if (!res.ok) return null;
  const json = await res.json();
  await writeFile(path, JSON.stringify(json));
  return json;
}

function formatLap(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

await mkdir(CACHE_DIR, { recursive: true });

const index = JSON.parse(
  await readFile("public/circuits-index.json", "utf8"),
) as { circuits: CircuitIndexEntry[] };

let checked = 0;
let failed = 0;
const unreferenced: string[] = [];

for (const circuit of index.circuits) {
  const geojson = await fetchGeoJson(circuit.id);
  if (!geojson) {
    console.log(`${circuit.id.padEnd(9)} no geojson`);
    continue;
  }
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates as [number, number][];
  const bounds = computeBounds(coords);
  const curve = buildTrackCurve(coords, bounds);
  const length = feature.properties.length ?? curve.getLength();
  const samples = Math.max(400, Math.min(2000, Math.round(length / 4)));

  const profile = buildSpeedProfile(curve, samples);
  if (!profile) {
    console.log(`${circuit.id.padEnd(9)} no profile`);
    continue;
  }

  const lap = idealLapTime(profile);
  const maxKmh = Math.max(...profile.speeds) * 3.6;
  const minKmh = Math.min(...profile.speeds) * 3.6;
  const reference = REFERENCE_LAP_S[circuit.id];

  if (reference == null) {
    unreferenced.push(circuit.id);
    console.log(
      `${circuit.id.padEnd(9)} ${formatLap(lap).padStart(6)}  ` +
        `${Math.round(minKmh)}-${Math.round(maxKmh)} km/h  (no reference)`,
    );
    continue;
  }

  checked++;
  const error = (lap - reference) / reference;
  const bad = Math.abs(error) > TOLERANCE;
  if (bad) failed++;
  console.log(
    `${circuit.id.padEnd(9)} ${formatLap(lap).padStart(6)}  vs ${formatLap(reference)}  ` +
      `${(error * 100).toFixed(1).padStart(6)}%  ` +
      `${Math.round(minKmh)}-${Math.round(maxKmh)} km/h  ${bad ? "FAIL" : "ok"}`,
  );
}

console.log(
  `\n${checked - failed}/${checked} within ${TOLERANCE * 100}% ` +
    `(${unreferenced.length} historic layouts without a reference)`,
);
