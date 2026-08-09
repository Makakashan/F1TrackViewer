/**
 * Do the intervals hold still when the cars do?
 *
 * A gap of "distance between us over my speed" is a function of where on the
 * lap a pair happens to be: hold station through a hairpin and the number
 * triples, then falls back on the straight without either car gaining a meter.
 * This measures that directly — for every pair of cars whose separation in
 * meters barely changes over a window, how much the reported gap in seconds
 * moves, timed against the estimate it replaced.
 *
 *   bun scripts/audit-gaps.ts [circuitId]
 */
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildTrackCurve, computeBounds } from "../src/lib/geo-utils";
import { buildSpeedProfile } from "../src/lib/race/speed-profile";
import { buildRacingLine } from "../src/lib/track/racing-line";
import { startGridSlots } from "../src/lib/race/start-grid";
import { createRaceSim, stepRace, raceStandings } from "../src/lib/race/race-sim";

const CACHE_DIR = ".cache/circuit-geojson";
const RAW_BASE = "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
const STEP_HZ = 30;
const SAMPLE_S = 0.5;
/**
 * How much a pair's separation may drift and still count as holding station,
 * as a share of the separation itself. A relative bound is the only fair one:
 * cars a hundred meters apart breathe more than cars in a train.
 */
const HOLDING_STATION_SHARE = 0.12;
/** Pairs closer than this are nose-to-tail, where both formulas agree anyway. */
const MIN_SEPARATION_M = 20;

async function fetchGeoJson(id: string) {
  const path = `${CACHE_DIR}/${id}.geojson`;
  if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  const res = await fetch(`${RAW_BASE}/circuits/${id}.geojson`);
  if (!res.ok) return null;
  return await res.json();
}

async function readMarkers(id: string) {
  const path = `public/track-markers/${id}.json`;
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

await mkdir(CACHE_DIR, { recursive: true });

const only = process.argv[2];
const index = JSON.parse(await readFile("public/circuits-index.json", "utf8")) as {
  circuits: { id: string; name: string }[];
};

let worstTimed = 0;
let worstEstimate = 0;

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
  const halfWidth = 7;
  const speedProfile = buildSpeedProfile(curve, samples);
  const racingLine = buildRacingLine(curve, samples, halfWidth);
  if (!speedProfile || !racingLine) continue;

  const slots = startGridSlots(
    curve,
    markers?.startFinish?.s ?? 0,
    halfWidth,
    (markers?.directionSign ?? 1) as 1 | -1,
  );
  const setup = {
    slots,
    speedProfile,
    racingLine,
    halfWidthAtS: () => halfWidth,
    lapLengthMeters: lapLength,
    seed: `${circuit.id}:0`,
    laps: 3,
  };

  const state = createRaceSim(setup);
  const dt = 1 / STEP_HZ;
  // Per pair of adjacent places: the reported gap, the estimate, the meters.
  const timed = new Map<string, number[]>();
  const estimate = new Map<string, number[]>();
  const meters = new Map<string, number[]>();
  let steps = 0;
  let nextSample = 20;

  while (!state.complete && steps * dt < 900) {
    stepRace(state, setup, dt);
    steps++;
    if (state.time < nextSample) continue;
    nextSample += SAMPLE_S;

    const standings = raceStandings(state, lapLength);
    const byIndex = new Map(state.cars.map((car) => [car.index, car]));
    for (let i = 1; i < standings.length; i++) {
      const row = standings[i];
      const aheadRow = standings[i - 1];
      const car = byIndex.get(row.index)!;
      const ahead = byIndex.get(aheadRow.index)!;
      if (car.finished || ahead.finished) continue;
      const key = `${aheadRow.index}>${row.index}`;
      const metersGap = ahead.distance - car.distance;
      if (metersGap > 120) continue;
      timed.set(key, [...(timed.get(key) ?? []), row.gapToAhead]);
      estimate.set(key, [
        ...(estimate.get(key) ?? []),
        metersGap / Math.max(car.speed, 1),
      ]);
      meters.set(key, [...(meters.get(key) ?? []), metersGap]);
    }
  }

  // Windows, not whole runs: a pair drifts over four minutes no matter what,
  // and the question is what the number does over the few seconds it takes to
  // go from a straight into a corner and back.
  const WINDOW = 12;
  let timedWorst = 0;
  let estimateWorst = 0;
  let pairs = 0;
  for (const [key, metresSeries] of meters) {
    const timedSeries = timed.get(key)!;
    const estimateSeries = estimate.get(key)!;
    for (let start = 0; start + WINDOW <= metresSeries.length; start++) {
      const window = metresSeries.slice(start, start + WINDOW);
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      if (mean < MIN_SEPARATION_M) continue;
      if (spread(window) > mean * HOLDING_STATION_SHARE) continue;
      pairs++;
      timedWorst = Math.max(
        timedWorst,
        spread(timedSeries.slice(start, start + WINDOW)),
      );
      estimateWorst = Math.max(
        estimateWorst,
        spread(estimateSeries.slice(start, start + WINDOW)),
      );
    }
  }

  worstTimed = Math.max(worstTimed, timedWorst);
  worstEstimate = Math.max(worstEstimate, estimateWorst);
  console.log(
    `${circuit.id.padEnd(9)} windows ${String(pairs).padStart(4)}  ` +
      `timed swing ${timedWorst.toFixed(2)}s  estimate swing ${estimateWorst.toFixed(2)}s`,
  );
}

console.log(
  `\nworst timed swing ${worstTimed.toFixed(2)}s, ` +
    `worst estimate swing ${worstEstimate.toFixed(2)}s`,
);
