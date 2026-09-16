import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TRACK_OVERRIDES_VERSION,
  type TrackOverridePoint,
  type TrackOverrides,
} from "@/lib/track/track-overrides";

/**
 * The track editor's save. Only `next dev` sees this file (`pageExtensions` in
 * next.config): it writes into the source tree, which no deployed build may do.
 */

const DIR = join(process.cwd(), "src", "data", "track-overrides");
const CIRCUIT_ID = /^[a-z]{2}-\d{4}$/;

function numberIn(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number from ${min} to ${max}`);
  }
  return Number(value.toFixed(4));
}

function clean(body: unknown, circuitId: string): TrackOverrides {
  const points = (body as { points?: unknown } | null)?.points;
  if (!Array.isArray(points)) throw new Error("points missing");
  const cleaned = points.map((raw, index) => {
    const p = raw as Record<string, unknown>;
    const label = `point ${index + 1}`;
    const point: TrackOverridePoint = {
      id: typeof p.id === "string" && p.id ? p.id : `p${index + 1}`,
      s: numberIn(p.s, `${label} s`, 0, 1),
      lengthM: numberIn(p.lengthM, `${label} length`, 1, 1000),
    };
    if (p.widthM !== undefined) point.widthM = numberIn(p.widthM, `${label} width`, 3, 30);
    if (p.smoothM !== undefined) point.smoothM = numberIn(p.smoothM, `${label} smoothing`, 0, 200);
    for (const key of ["barrierPlusM", "barrierMinusM"] as const) {
      if (p[key] !== undefined) point[key] = numberIn(p[key], `${label} ${key}`, 0, 60);
    }
    for (const key of ["kerbPlusM", "kerbMinusM"] as const) {
      if (p[key] !== undefined) point[key] = numberIn(p[key], `${label} ${key}`, 0, 5);
    }
    return point;
  });
  cleaned.sort((a, b) => a.s - b.s);
  return { version: TRACK_OVERRIDES_VERSION, circuitId, points: cleaned };
}

/** One import per saved circuit, so a deployed build carries the corrections without a fetch. */
async function writeIndex() {
  const ids = (await readdir(DIR))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
  const name = (id: string) => `c${id.replace(/-/g, "_")}`;
  const lines = [
    'import type { TrackOverrides } from "@/lib/track/track-overrides";',
    ...ids.map((id) => `import ${name(id)} from "./${id}.json";`),
    "",
    "/** Written by the track editor's development endpoint: one import per circuit with corrections. */",
    "export const TRACK_OVERRIDES: Record<string, TrackOverrides> = {",
    ...ids.map((id) => `  "${id}": ${name(id)} as TrackOverrides,`),
    "};",
    "",
  ];
  await writeFile(join(DIR, "index.ts"), lines.join("\n"));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!CIRCUIT_ID.test(id)) return new Response("unknown circuit id", { status: 400 });

  let overrides: TrackOverrides;
  try {
    overrides = clean(await request.json(), id);
  } catch (err) {
    return new Response(String(err), { status: 400 });
  }

  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${id}.json`), `${JSON.stringify(overrides, null, 2)}\n`);
  await writeIndex();
  return Response.json({ points: overrides.points.length });
}
