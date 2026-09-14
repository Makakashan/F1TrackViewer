/** Where do the kerbs actually land? */
import * as THREE from "three";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildTrackCurve, computeBounds } from "../src/lib/geo-utils";
import { sampleCurvature } from "../src/lib/track/track-curvature";
import { sampleApronRoom, apronRoomAt } from "../src/lib/track/track-apron";
import { barrierOffsetAt } from "../src/lib/track/track-barriers";
import { limitHalfWidth, sampleReachLimit } from "../src/lib/track/track-reach-limit";
import { halfWidthAt, type HalfWidth } from "../src/lib/track/track-geometry";
import { sampleWidthAt, type TrackWidthProfile } from "../src/lib/track/track-width";

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
/** The viewer's default half width, for a circuit with no real-width profile. */
const HALF_WIDTH_M = 7;

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

/** The half width the race view draws: the real profile where one ships, the default otherwise. */
async function halfWidthOf(id: string): Promise<HalfWidth> {
  const path = `public/track-widths/${id}.json`;
  if (!existsSync(path)) return HALF_WIDTH_M;
  const profile = JSON.parse(await readFile(path, "utf8")) as TrackWidthProfile;
  return (s: number) => sampleWidthAt(profile, s) / 2;
}

/** The race view's own sample count for a lap, so a fold is judged on the mesh it would build. */
function rendererSamples(length: number): number {
  return Math.max(400, Math.min(2000, Math.round(length / 4)));
}

/**
 * Samples where a line offset from the centreline runs backwards: the edge has
 * folded over itself, which is a fan of spokes on a ribbon and a wall across the
 * road for a barrier.
 */
function foldedSamples(
  curve: THREE.CatmullRomCurve3,
  samples: number,
  offsetAt: (s: number, sign: number) => number,
): number {
  const up = new THREE.Vector3(0, 1, 0);
  const points: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  const sides: THREE.Vector3[] = [];
  for (let i = 0; i < samples; i++) {
    const s = i / samples;
    points.push(curve.getPointAt(s));
    const t = curve.getTangentAt(s);
    tangents.push(t);
    sides.push(new THREE.Vector3().crossVectors(t, up).normalize());
  }
  let folded = 0;
  for (const sign of [1, -1]) {
    for (let i = 0; i < samples; i++) {
      const j = (i + 1) % samples;
      const a = offsetAt(i / samples, sign) * sign;
      const b = offsetAt(j / samples, sign) * sign;
      const dx = points[j].x + sides[j].x * b - (points[i].x + sides[i].x * a);
      const dz = points[j].z + sides[j].z * b - (points[i].z + sides[i].z * a);
      if (dx * tangents[i].x + dz * tangents[i].z <= 0) folded++;
    }
  }
  return folded;
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
    "circuit          laps  corners  kerbed  kerbed%  tightest-R  bare  mean-kerb-m  folds ribbon/apron/barrier",
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

    // The tightest radius any kept run reaches, against the apron under it.
    const halfWidth = await halfWidthOf(id);
    const room = sampleApronRoom(curve, halfWidth, SAMPLES, null);

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

      // What the kerb actually gets to be, once the corner's own geometry has had its say.
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

    const drawn = rendererSamples(total);
    const reach = sampleReachLimit(curve, drawn);
    const drawnHalfWidth = limitHalfWidth(halfWidth, reach);
    const drawnRoom = sampleApronRoom(curve, drawnHalfWidth, drawn, null);
    const folds = [
      foldedSamples(curve, drawn, (s) => halfWidthAt(drawnHalfWidth, s)),
      foldedSamples(
        curve,
        drawn,
        (s, sign) => halfWidthAt(drawnHalfWidth, s) + apronRoomAt(drawnRoom, s, sign),
      ),
      foldedSamples(
        curve,
        drawn,
        (s, sign) => barrierOffsetAt(drawnHalfWidth, drawnRoom, s, sign, reach),
      ),
    ];

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
        .padStart(11)}  ${folds.join("/").padStart(26)}`,
    );
  }
}

main();
