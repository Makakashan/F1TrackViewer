/**
 * Generate static real-track-width profiles from the TUMFTM racetrack-database.
 * Source: https://github.com/TUMFTM/racetrack-database (LGPL-3.0)
 *
 * Each TUMFTM track CSV is a centerline of `x_m,y_m,w_tr_right_m,w_tr_left_m`
 * rows. The full track width at a point is `w_tr_right_m + w_tr_left_m`.
 *
 * The TUMFTM centerline lives in its own arbitrary local metric frame, so it
 * cannot be matched to bacinger/f1-circuits by coordinates. Instead we align
 * the two loops by *shape*: both are resampled uniformly by arc length, their
 * per-vertex turning angles (a rotation/translation/scale-invariant proxy for
 * curvature) are cross-correlated to recover the circular offset + traversal
 * direction, and the TUMFTM width profile is then mapped onto bacinger's
 * normalized arc length starting from bacinger coordinate[0].
 *
 * Output: public/track-widths/<id>.json
 *
 * Usage:
 *   bun run widths:generate                  # all mapped circuits
 *   bun run widths:generate -- it-1922 gb-1948
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CircuitGeoJSON } from "../src/lib/f1-circuits";

const BACINGER_BASE =
  "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
const TUMFTM_BASE =
  "https://raw.githubusercontent.com/TUMFTM/racetrack-database/master/tracks";

const WIDTH_VERSION = 1;
/** Number of samples per profile (uniform along normalized arc length). */
const SAMPLES = 600;
/** Resolution used for the curvature cross-correlation alignment. */
const ALIGN_RES = 720;

/**
 * Map bacinger circuit id → TUMFTM track CSV stem. Only current/modern layouts
 * that exist in both datasets are mapped.
 */
const CIRCUIT_TO_TUMFTM: Record<string, string> = {
  "ae-2009": "YasMarina", // Abu Dhabi
  "at-1969": "Spielberg", // Red Bull Ring
  "au-1953": "Melbourne",
  "be-1925": "Spa", // Spa-Francorchamps
  "bh-2002": "Sakhir", // Bahrain
  "br-1940": "SaoPaulo", // Interlagos
  "ca-1978": "Montreal", // Gilles Villeneuve
  "cn-2004": "Shanghai",
  "de-1927": "Nuerburgring", // Nürburgring
  "de-1932": "Hockenheim",
  "es-1991": "Catalunya", // Barcelona
  "gb-1948": "Silverstone",
  "hu-1986": "Budapest", // Hungaroring
  "it-1922": "Monza",
  "mx-1962": "MexicoCity",
  "my-1999": "Sepang",
  "nl-1948": "Zandvoort",
  "ru-2014": "Sochi",
  "jp-1962": "Suzuka",
  "us-2012": "Austin", // Circuit of the Americas
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage:
  bun run widths:generate
  bun run widths:generate -- it-1922 gb-1948

Generates static real-track-width profiles in public/track-widths/*.json
from the TUMFTM racetrack-database. Pass circuit ids to limit generation.`);
  process.exit(0);
}
const requestedIds = new Set(
  args.filter((arg) => !arg.startsWith("-") && arg.trim().length > 0),
);

interface Vec2 {
  x: number;
  y: number;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Parse a TUMFTM track CSV into centerline points + full widths. */
function parseTumftm(csv: string): { center: Vec2[]; width: number[] } {
  const center: Vec2[] = [];
  const width: number[] = [];
  for (const raw of csv.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [x, y, wr, wl] = line.split(",").map(Number);
    if (![x, y, wr, wl].every(Number.isFinite)) continue;
    center.push({ x, y });
    width.push(wr + wl);
  }
  return { center, width };
}

/** Local equirectangular projection of [lon,lat] → metric XY around a center. */
function projectLonLat(coords: [number, number][]): Vec2[] {
  // Drop the closing duplicate vertex if present.
  let pts = coords;
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) pts = pts.slice(0, -1);
  }
  let sumLat = 0;
  for (const [, lat] of pts) sumLat += lat;
  const centerLat = sumLat / pts.length;
  const mPerLat = 111_320;
  const mPerLon = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  return pts.map(([lon, lat]) => ({ x: lon * mPerLon, y: lat * mPerLat }));
}

/** Cumulative arc length of a closed polyline (wraps last→first). */
function closedArcLengths(pts: Vec2[]): { cum: number[]; total: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  }
  const total = cum[cum.length - 1] + dist(pts[pts.length - 1], pts[0]);
  return { cum, total };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Resample a closed polyline to `n` points uniformly spaced by arc length.
 * `values` (optional, parallel to pts) are linearly interpolated alongside.
 */
function resampleClosed(
  pts: Vec2[],
  n: number,
  values?: number[],
): { points: Vec2[]; values: number[] } {
  const { cum, total } = closedArcLengths(pts);
  const ext = [...cum, total]; // arc length of the wrap-around closing point
  const points: Vec2[] = [];
  const out: number[] = [];
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / n) * total;
    while (seg < ext.length - 1 && ext[seg + 1] <= target) seg++;
    const a = pts[seg % pts.length];
    const b = pts[(seg + 1) % pts.length];
    const segLen = ext[seg + 1] - ext[seg];
    const f = segLen > 1e-9 ? (target - ext[seg]) / segLen : 0;
    points.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    if (values) {
      const va = values[seg % values.length];
      const vb = values[(seg + 1) % values.length];
      out.push(va + (vb - va) * f);
    }
  }
  return { points, values: out };
}

/** Per-vertex turning angle (signed) of a closed, uniformly sampled polyline. */
function turningAngles(pts: Vec2[]): number[] {
  const n = pts.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const ax = cur.x - prev.x;
    const ay = cur.y - prev.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    out.push(Math.atan2(cross, dot));
  }
  return out;
}

function zNormalize(a: number[]): number[] {
  const n = a.length;
  let mean = 0;
  for (const v of a) mean += v;
  mean /= n;
  let varSum = 0;
  for (const v of a) varSum += (v - mean) * (v - mean);
  const std = Math.sqrt(varSum / n) || 1;
  return a.map((v) => (v - mean) / std);
}

/**
 * Find the circular offset + direction that best aligns TUMFTM curvature to
 * bacinger curvature. Returns the mapping bacinger index j → tumftm index, plus
 * a normalized correlation score in [-1, 1].
 */
function alignByCurvature(
  baseCurv: number[],
  tumCurv: number[],
): { sign: 1 | -1; offset: number; score: number } {
  const n = baseCurv.length;
  const base = zNormalize(baseCurv);
  const forward = zNormalize(tumCurv);
  const reversed = zNormalize([...tumCurv].reverse());

  let best = { sign: 1 as 1 | -1, offset: 0, score: -Infinity };
  for (const [sign, cand] of [
    [1, forward],
    [-1, reversed],
  ] as [1 | -1, number[]][]) {
    for (let d = 0; d < n; d++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += base[j] * cand[(j + d) % n];
      s /= n;
      if (s > best.score) best = { sign, offset: d, score: s };
    }
  }
  return best;
}

async function generate(id: string, tumName: string) {
  const [csv, geojson] = await Promise.all([
    fetchText(`${TUMFTM_BASE}/${tumName}.csv`),
    fetchJson<CircuitGeoJSON>(`${BACINGER_BASE}/circuits/${id}.geojson`),
  ]);

  const tum = parseTumftm(csv);
  if (tum.center.length < 8) throw new Error(`${id}: TUMFTM data too short`);

  const coords = geojson.features[0]?.geometry.coordinates ?? [];
  const baseProjected = projectLonLat(coords);

  // Resample both loops uniformly for a curvature-correlation alignment.
  const baseAlign = resampleClosed(baseProjected, ALIGN_RES);
  const tumAlign = resampleClosed(tum.center, ALIGN_RES, tum.width);
  const { sign, offset, score } = alignByCurvature(
    turningAngles(baseAlign.points),
    turningAngles(tumAlign.points),
  );

  // Build the aligned, normalized-arc-length width profile in bacinger order.
  // tumAlign.values is forward-ordered; reversed direction reads it backwards.
  const tw = tumAlign.values;
  const m = tw.length;
  const aligned: number[] = [];
  for (let j = 0; j < ALIGN_RES; j++) {
    const k =
      sign === 1
        ? (j + offset) % m
        : (((m - 1 - j + offset) % m) + m) % m;
    aligned.push(tw[k]);
  }

  // Downsample the aligned profile to the stored sample count.
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const idx = Math.round((i / SAMPLES) * ALIGN_RES) % ALIGN_RES;
    samples.push(Number(aligned[idx].toFixed(3)));
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const w of samples) {
    if (w < min) min = w;
    if (w > max) max = w;
    sum += w;
  }

  const out = {
    version: WIDTH_VERSION,
    source: "TUMFTM/racetrack-database",
    license: "LGPL-3.0",
    generatedAt: new Date().toISOString(),
    circuitId: id,
    tumftmTrack: tumName,
    alignment: {
      directionSign: sign,
      offsetFraction: Number((offset / ALIGN_RES).toFixed(4)),
      curvatureScore: Number(score.toFixed(3)),
    },
    meanWidthMeters: Number((sum / samples.length).toFixed(2)),
    minWidthMeters: Number(min.toFixed(2)),
    maxWidthMeters: Number(max.toFixed(2)),
    samples,
  };

  const outDir = join(process.cwd(), "public", "track-widths");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, `${id}.json`),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  console.log(
    `wrote ${id} ← ${tumName}: mean ${out.meanWidthMeters}m ` +
      `[${out.minWidthMeters}–${out.maxWidthMeters}m] ` +
      `align ${sign > 0 ? "+" : "-"} score ${out.alignment.curvatureScore}`,
  );
}

async function main() {
  const entries = Object.entries(CIRCUIT_TO_TUMFTM).filter(
    ([id]) => requestedIds.size === 0 || requestedIds.has(id),
  );
  for (const [id, tumName] of entries) {
    try {
      await generate(id, tumName);
    } catch (err) {
      console.warn(`skip ${id}: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
