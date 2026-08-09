/** Publish car models from the drop folder and write the manifest the admin model browser reads. */

import {
  mkdir,
  copyFile,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { gzipSync } from "node:zlib";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SOURCE_DIR = join(REPO_ROOT, "cars");
const OUTPUT_DIR = join(REPO_ROOT, "public", "cars");
const MANIFEST = join(OUTPUT_DIR, "index.json");

/** Only these are served; anything else in the drop folder is ignored. */
const ACCEPTED = new Set([".glb", ".gltf"]);

export interface CarModelEntry {
  /** Stable id derived from the filename — used in URLs and as a React key. */
  id: string;
  /** Filename as served from public/cars/. */
  file: string;
  /** Human-readable name derived from the filename. */
  name: string;
  bytes: number;
  /** Size after gzip. */
  gzipBytes: number;
  modifiedAt: string;
}

/** "ferrari_sf_25.glb" -> "Ferrari SF 25" */
function titleFromFilename(file: string): string {
  return basename(file, extname(file))
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) =>
      // Short all-alpha chunks are nearly always initialisms here (SF, RB, GT).
      word.length <= 2 && /^[a-z]+$/i.test(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

async function main() {
  let sourceFiles: string[];
  try {
    sourceFiles = await readdir(SOURCE_DIR);
  } catch {
    console.error(
      `No drop folder at ${SOURCE_DIR}. Create it and put .glb files there.`,
    );
    process.exit(1);
  }

  const models = sourceFiles
    .filter((file) => ACCEPTED.has(extname(file).toLowerCase()))
    .sort();

  if (models.length === 0) {
    console.warn(`No .glb/.gltf files in ${SOURCE_DIR}.`);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const entries: CarModelEntry[] = [];
  for (const file of models) {
    const source = join(SOURCE_DIR, file);
    const info = await stat(source);
    await copyFile(source, join(OUTPUT_DIR, file));
    const gzipBytes = gzipSync(await readFile(source), { level: 9 }).byteLength;
    entries.push({
      id: basename(file, extname(file)),
      file,
      name: titleFromFilename(file),
      bytes: info.size,
      gzipBytes,
      modifiedAt: info.mtime.toISOString(),
    });
    console.log(
      `published ${file} (${(info.size / 1024 / 1024).toFixed(1)} MB, ` +
        `${(gzipBytes / 1024 / 1024).toFixed(1)} MB gzipped)`,
    );
  }

  await writeFile(
    MANIFEST,
    `${JSON.stringify(
      { version: 1, generatedAt: new Date().toISOString(), models: entries },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${MANIFEST} (${entries.length} model(s))`);
}

main();
