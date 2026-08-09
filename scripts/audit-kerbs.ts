/**
 * Where do the kerbs actually land?
 *
 * The layout is derived from curvature rather than read from data, so the
 * question "which corners got one" has no answer until something counts them.
 * This walks every circuit, finds the corners the way the renderer does, and
 * reports how many of them ended up with a kerb, how much of the lap is kerbed,
 * and — the failure this was written for — how tight the tightest kerbed corner
 * is against the apron the strip has to lie on.
 *
 *   bun scripts/audit-kerbs.ts [circuitId]
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildTrackCurve, computeBounds } from "../src/lib/geo-utils";
import { sampleCurvature } from "../src/lib/track/track-curvature";
import { sampleApronRoom, apronRoomAt } from "../src/lib/track/track-apron";

const CACHE_DIR = ".cache/circuit-geojson";
const RAW_BASE = "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
const SAMPLES = 1200;

/** Mirrors the renderer's thresholds — see track-kerbs.ts. */
const ENTER_RADIUS_M = 170;
const EXIT_RADIUS_M = 420;
const MIN_RUN_M = Number(process.env.MIN_RUN_M ?? 12);
/** The renderer's kerb width, and the width below which a strip is a thread. */
const KERB_WIDTH_M = 1.9;
const KERB_MIN_VISIBLE_M = 0.4;
/** Half width used for the audit — the viewer's default ribbon. */
const HALF_WIDTH_M = 7.5;

async function fetchGeoJson(id: string) {
  const path = `${CACHE_DIR}/${id}.geojson`;
  if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  const res = await fetch(`${RAW_BASE}/circuits/${id}.geojson`);
  if (!res.ok) return null;
  const json = await res.json();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(json));
  return json;
}

function runsOf(sides: number[]): Array<{ start: number; count: number; sign: number }> {
  const n = sides.length;
  const runs: Array<{ start: number; count: number; sign: number }> = [];
  let start = -1;
  let current = 0;
  for (let step = 0; step <= n; step++) {
    const i = step % n;
    const value = step < n ? sides[i] : 0;
    if (value !== current && start >= 0) {
      runs.push({ start, count: (i - start + n) % n, sign: current });
      start = -1;
    }
    if (value !== 0 && start < 0) start = i;
    current = value;
  }
  return runs;
}

function resolve(curvature: number[], enter: number, exit: number): number[] {
  const n = curvature.length;
  const sides = new Array<number>(n).fill(0);
  let origin = 0;
  for (let i = 1; i < n; i++) {
    if (Math.abs(curvature[i]) < Math.abs(curvature[origin])) origin = i;
  }
  let active = 0;
  for (let step = 0; step < n; step++) {
    const i = (origin + step) % n;
    const magnitude = Math.abs(curvature[i]);
    const sign = Math.sign(curvature[i]);
    if (active === 0) {
      if (magnitude > enter) active = sign;
    } else if (sign !== active && magnitude > enter) {
      active = sign;
    } else if (magnitude < exit) {
      active = 0;
    }
    sides[i] = active;
  }
  return sides;
}

async function main() {
  const only = process.argv[2];
  const index = JSON.parse(await readFile("public/circuits-index.json", "utf8"));
  const ids: string[] = (index.circuits ?? index).map(
    (c: { id: string }) => c.id,
  );

  console.log(
    "circuit          laps  corners  kerbed  kerbed%  tightest-R  bare  mean-kerb-m",
  );
  for (const id of ids) {
    if (only && id !== only) continue;
    const geo = await fetchGeoJson(id);
    if (!geo) continue;
    const coords: [number, number][] = geo.features[0].geometry.coordinates;
    const bounds = computeBounds(coords);
    const curve = buildTrackCurve(coords, bounds);
    const total = curve.getLength();
    const ds = total / SAMPLES;

    const profile = sampleCurvature(curve, SAMPLES);
    if (!profile) continue;

    const sides = resolve(
      profile.curvature,
      1 / ENTER_RADIUS_M,
      1 / EXIT_RADIUS_M,
    );
    const runs = runsOf(sides);
    const kept = runs.filter((run) => run.count * ds >= MIN_RUN_M);

    // The tightest radius any kept run reaches, and whether that radius is
    // smaller than the apron the kerb has to sit on — where it is, offsetting
    // the inner edge outward folds the strip through itself.
    const room = sampleApronRoom(curve, HALF_WIDTH_M, SAMPLES, null);

    let tightest = Infinity;
    let bare = 0;
    let widthSum = 0;
    let widthCount = 0;
    for (const run of kept) {
      let localTightest = Infinity;
      for (let k = 0; k < run.count; k++) {
        const i = (run.start + k) % SAMPLES;
        const radius = 1 / Math.max(Math.abs(profile.curvature[i]), 1e-9);
        if (radius < localTightest) localTightest = radius;
      }
      if (localTightest < tightest) tightest = localTightest;

      // What the kerb actually gets to be, once the corner's own geometry has
      // had its say: the strip can never reach past the turn's centre.
      let widest = 0;
      for (let k = 0; k < run.count; k++) {
        const i = (run.start + k) % SAMPLES;
        const reach = Math.min(
          KERB_WIDTH_M,
          apronRoomAt(room, i / SAMPLES, run.sign),
        );
        widthSum += reach;
        widthCount += 1;
        if (reach > widest) widest = reach;
      }
      if (widest < KERB_MIN_VISIBLE_M) bare += 1;
    }

    const kerbedMeters = kept.reduce((sum, run) => sum + run.count * ds, 0);
    console.log(
      `${id.padEnd(16)} ${Math.round(total).toString().padStart(5)}  ${runs.length
        .toString()
        .padStart(7)}  ${kept.length.toString().padStart(6)}  ${(
        (kerbedMeters / total) *
        100
      )
        .toFixed(1)
        .padStart(6)}%  ${(Number.isFinite(tightest) ? tightest : 0)
        .toFixed(1)
        .padStart(10)}  ${bare.toString().padStart(4)}  ${(
        widthSum / Math.max(widthCount, 1)
      )
        .toFixed(2)
        .padStart(11)}`,
    );
  }
}

main();
