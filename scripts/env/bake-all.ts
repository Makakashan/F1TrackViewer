/**
 * Bakes every circuit the app lists (docs/city-generation.md P4.4).
 *
 * The migration is thirty-one circuits and the failures are the point. A bake
 * touches two networks and a dozen assumptions that Monaco happened to satisfy,
 * so this runs them all, keeps going past a failure, and prints one table at the
 * end saying what came out and what did not. A run that stops at the first
 * broken circuit tells you about one circuit; this tells you about the pipeline.
 *
 * Results are written as they are produced, so an interrupted run is resumable:
 * `--only` takes ids, `--skip-baked` leaves alone anything already on disk.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { bakeCircuit, type BakeReport } from "./bake";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

interface Row {
  id: string;
  ok: boolean;
  bytes?: number;
  triangles?: number;
  trees?: number;
  props?: number;
  provider?: string;
  seconds: number;
  error?: string;
}

async function circuitIds(): Promise<string[]> {
  const raw = await readFile(join(REPO_ROOT, "public", "circuits", "index.json"), "utf8");
  const parsed = JSON.parse(raw) as { id: string }[] | { circuits: { id: string }[] };
  const list = Array.isArray(parsed) ? parsed : parsed.circuits;
  return list.map((circuit) => circuit.id);
}

async function alreadyBaked(id: string): Promise<boolean> {
  try {
    await readFile(join(REPO_ROOT, "public", "environments", id, "city-manifest.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Did this circuit ever get a complete answer about its greenery?
 *
 * The cache is only written when every query came back (see `fetchGreenWays`),
 * so its absence is exactly the question "were the trees missed". Overpass hands
 * out query slots per address and a sweep of thirty-one circuits spends part of
 * its time locked out, so a first pass can bake a correct circuit with no trees
 * on it and nothing else records that.
 */
async function hasGreenery(id: string): Promise<boolean> {
  try {
    await readFile(join(REPO_ROOT, "data", "cache", "overpass-structures", `${id}-green.json`));
    return true;
  } catch {
    return false;
  }
}

function summarise(id: string, report: BakeReport, seconds: number): Row {
  const belts = Object.values(report.belts);
  return {
    id,
    ok: true,
    bytes: belts.reduce((sum, belt) => sum + belt.bytes, 0),
    triangles: belts.reduce((sum, belt) => sum + belt.triangles, 0),
    trees: report.greenery.planted,
    props: report.props.placed,
    seconds,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const only = new Set(
    args.filter((arg) => !arg.startsWith("--")),
  );
  const skipBaked = args.includes("--skip-baked");
  const refresh = args.includes("--refresh");
  // Re-bakes only what came out treeless because Overpass was busy.
  const greeneryOnly = args.includes("--missing-greenery");

  let ids = (await circuitIds()).filter((id) => only.size === 0 || only.has(id));
  if (greeneryOnly) {
    const missing: string[] = [];
    for (const id of ids) if (!(await hasGreenery(id))) missing.push(id);
    console.log(`${missing.length} of ${ids.length} circuits have no greenery cached`);
    ids = missing;
  }
  const rows: Row[] = [];

  for (const id of ids) {
    if (skipBaked && (await alreadyBaked(id))) {
      console.log(`skip ${id} — already baked`);
      continue;
    }
    const started = Date.now();
    try {
      const report = await bakeCircuit(id, refresh);
      const row = summarise(id, report, (Date.now() - started) / 1000);
      rows.push(row);
      console.log(
        `ok   ${id} — ${(row.bytes! / 1_000_000).toFixed(2)} MB, ` +
          `${row.triangles!.toLocaleString()} tris, ${row.trees} trees, ` +
          `${row.props} props, ${row.seconds.toFixed(0)} s`,
      );
    } catch (error) {
      const row: Row = {
        id,
        ok: false,
        seconds: (Date.now() - started) / 1000,
        error: error instanceof Error ? error.message : String(error),
      };
      rows.push(row);
      console.log(`FAIL ${id} — ${row.error}`);
    }
  }

  console.log("\nbake:all");
  const done = rows.filter((row) => row.ok);
  const failed = rows.filter((row) => !row.ok);
  console.log(`  ${done.length} baked, ${failed.length} failed`);
  if (done.length) {
    const bytes = done.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
    const worst = done.reduce((a, b) => ((a.bytes ?? 0) > (b.bytes ?? 0) ? a : b));
    console.log(
      `  ${(bytes / 1_000_000).toFixed(1)} MB over ${done.length} circuits, ` +
        `heaviest ${worst.id} at ${((worst.bytes ?? 0) / 1_000_000).toFixed(2)} MB`,
    );
  }
  for (const row of failed) console.log(`  ${row.id}: ${row.error}`);
  if (failed.length) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
