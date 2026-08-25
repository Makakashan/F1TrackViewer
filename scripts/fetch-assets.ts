/**
 * Downloads the model packs the bake merges from, and writes their credits.
 *
 * The packs are not committed — a city kit is four megabytes of things the
 * bake never places — so `assets/assets.json` records where each one came
 * from, under what licence, and which folder inside the archive is wanted.
 * Running this fills `assets/models/<pack>/` and rewrites `assets/CREDITS.md`.
 *
 * A CC-BY pack is allowed here as long as its line lands in CREDITS.md, which
 * is the whole reason the licence and author are part of the manifest rather
 * than something remembered.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";

const ROOT = join(import.meta.dir, "..");
const MANIFEST = join(ROOT, "assets", "assets.json");
const MODELS = join(ROOT, "assets", "models");

interface Pack {
  id: string;
  title: string;
  author: string;
  license: string;
  source: string;
  url: string;
  /**
   * Which prefixes inside the archive to keep, and where they land under the
   * pack's folder. A `.glb` from a kit names its texture by a relative path, so
   * the texture folder has to keep its place beside the models.
   */
  take: { from: string; to: string }[];
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
    schemaVersion: number;
    packs: Pack[];
  };
  if (manifest.schemaVersion !== 1) throw new Error("assets.json: unknown schemaVersion");

  const only = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith("--")));
  const refresh = process.argv.includes("--refresh");

  for (const pack of manifest.packs) {
    if (only.size && !only.has(pack.id)) continue;
    const dir = join(MODELS, pack.id);
    if (refresh) await rm(dir, { recursive: true, force: true });

    const response = await fetch(pack.url);
    if (!response.ok) throw new Error(`${pack.id}: ${response.status} ${response.statusText}`);
    const archive = new Uint8Array(await response.arrayBuffer());
    const digest = createHash("sha256").update(archive).digest("hex").slice(0, 16);

    const files = unzipSync(archive, {
      filter: (file) =>
        !file.name.endsWith("/") && pack.take.some((rule) => file.name.startsWith(rule.from)),
    });
    let written = 0;
    let models = 0;
    for (const [name, bytes] of Object.entries(files)) {
      const rule = pack.take.find((candidate) => name.startsWith(candidate.from))!;
      const out = join(dir, rule.to, name.slice(rule.from.length));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, bytes);
      written++;
      if (name.endsWith(".glb")) models++;
    }
    if (!models) throw new Error(`${pack.id}: no models matched`);
    console.log(`${pack.id}: ${models} models, ${written - models} other files, sha256 ${digest}`);
  }

  const lines = [
    "# Model credits",
    "",
    "Third-party models merged into the baked environments by `scripts/env/props.ts`.",
    "Written by `bun run assets:fetch` from `assets/assets.json` — edit the manifest,",
    "not this file.",
    "",
  ];
  for (const pack of manifest.packs) {
    lines.push(`- **${pack.title}** by ${pack.author} — ${pack.license} — <${pack.source}>`);
  }
  await writeFile(join(ROOT, "assets", "CREDITS.md"), `${lines.join("\n")}\n`);
}

await main();
