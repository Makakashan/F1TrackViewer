/**
 * Does the race simulation behave?
 *
 * Runs a full lap of twenty cars headless on every circuit and reports what
 * would otherwise take a browser and a careful eye: whether anyone finished,
 * how long it took, whether cars ended up inside each other, whether they
 * stayed on the asphalt, and whether the order changed at all.
 *
 *   bun scripts/audit-race-sim.ts [circuitId]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildTrackCurve, computeBounds } from "../src/lib/geo-utils";
import { buildSpeedProfile } from "../src/lib/race/speed-profile";
import { buildRacingLine } from "../src/lib/track/racing-line";
import { startGridSlots } from "../src/lib/race/start-grid";
import { createRaceSim, stepRace, raceStandings } from "../src/lib/race/race-sim";
import { fetchTrackMarkers } from "../src/lib/track/track-markers";

const RAW_BASE = "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
const CACHE_DIR = ".cache/circuit-geojson";
const STEP_HZ = 30;
const MAX_SIM_SECONDS = 400;
/** Two cars closer than this, side by side, are inside each other. */
const CAR_LENGTH_M = 5.6;
const CAR_WIDTH_M = 2;

async function fetchGeoJson(id: string) {
  const path = `${CACHE_DIR}/${id}.geojson`;
  if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  const res = await fetch(`${RAW_BASE}/circuits/${id}.geojson`);
  if (!res.ok) return null;
  const json = await res.json();
  await writeFile(path, JSON.stringify(json));
  return json;
}

async function readMarkers(id: string) {
  const path = `public/track-markers/${id}.json`;
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

await mkdir(CACHE_DIR, { recursive: true });
void fetchTrackMarkers;

const only = process.argv[2];
const index = JSON.parse(await readFile("public/circuits-index.json", "utf8")) as {
  circuits: { id: string; name: string }[];
};

let worstOverlap = 0;
let failures = 0;

for (const circuit of index.circuits) {
  if (only && circuit.id !== only) continue;

  const geojson = await fetchGeoJson(circuit.id);
  if (!geojson) continue;
  const feature = geojson.features[0];
  const coords = feature.geometry.coordinates as [number, number][];
  const bounds = computeBounds(coords);
  const curve = buildTrackCurve(coords, bounds);
  const lapLength = feature.properties.length ?? curve.getLength();
  const samples = Math.max(400, Math.min(2000, Math.round(lapLength / 4)));

  const markers = await readMarkers(circuit.id);
  const startFinishS = markers?.startFinish?.s ?? 0;
  const directionSign = (markers?.directionSign ?? 1) as 1 | -1;

  // The audit runs the flat-width path: the only circuits with a real width
  // profile are the ones whose file happens to exist, and the narrow case is
  // the one worth stressing.
  const halfWidth = 7;
  const speedProfile = buildSpeedProfile(curve, samples);
  const racingLine = buildRacingLine(curve, samples, halfWidth);
  if (!speedProfile || !racingLine) {
    console.log(`${circuit.id.padEnd(9)} no profile`);
    continue;
  }

  const slots = startGridSlots(curve, startFinishS, halfWidth, directionSign);
  const setup = {
    slots,
    speedProfile,
    racingLine,
    halfWidthAtS: () => halfWidth,
    lapLengthMeters: lapLength,
    seed: `${circuit.id}:0`,
    laps: 1,
  };

  const state = createRaceSim(setup);
  const dt = 1 / STEP_HZ;
  let overlap = 0;
  let maxLateral = 0;
  let steps = 0;

  while (!state.complete && steps * dt < MAX_SIM_SECONDS) {
    stepRace(state, setup, dt);
    steps++;
    for (const car of state.cars) {
      maxLateral = Math.max(maxLateral, Math.abs(car.lateral));
    }
    for (let a = 0; a < state.cars.length; a++) {
      for (let b = a + 1; b < state.cars.length; b++) {
        const ca = state.cars[a];
        const cb = state.cars[b];
        const dl = Math.abs(ca.distance - cb.distance);
        const dw = Math.abs(ca.lateral - cb.lateral);
        if (dl < CAR_LENGTH_M && dw < CAR_WIDTH_M) {
          overlap = Math.max(overlap, CAR_LENGTH_M - dl);
        }
      }
    }
  }

  const standings = raceStandings(state, lapLength);
  const winner = standings[0];
  const lapTimes = state.cars
    .map((c) => c.bestLap)
    .filter((t): t is number => t != null);
  const finished = lapTimes.length;
  const positionsChanged = standings.filter(
    (row, i) => row.index !== i,
  ).length;
  const edgeLimit = halfWidth - CAR_WIDTH_M / 2;

  const bad =
    finished !== 20 || overlap > 0.01 || maxLateral > edgeLimit + 0.01;
  if (bad) failures++;
  worstOverlap = Math.max(worstOverlap, overlap);

  console.log(
    `${circuit.id.padEnd(9)} finished ${String(finished).padStart(2)}/20  ` +
      `win ${winner ? winner.index + 1 : "-"}  ` +
      `lap ${lapTimes.length ? Math.min(...lapTimes).toFixed(1) : "-"}-` +
      `${lapTimes.length ? Math.max(...lapTimes).toFixed(1) : "-"}s  ` +
      `moved ${String(positionsChanged).padStart(2)}  ` +
      `lat ${maxLateral.toFixed(2)}/${edgeLimit.toFixed(1)}m  ` +
      `overlap ${overlap.toFixed(2)}m  ` +
      `sim ${(steps * dt).toFixed(0)}s  ${bad ? "FAIL" : "ok"}`,
  );
}

console.log(`\n${failures} failing circuits, worst overlap ${worstOverlap.toFixed(2)} m`);
