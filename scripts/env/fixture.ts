/**
 * A committed slice of a real circuit — layer B of `docs/scene-goals.md` §3.
 *
 * Synthetic ground catches the arithmetic; it cannot catch what only real data
 * says. Monaco's harbour holds a quay, a cliff, a tunnel mouth, water inside
 * the frame and buildings on ground that falls 60 m across two streets, and a
 * belt boundary runs through the middle of it. A window of it is small enough
 * to commit and to bake in seconds, and it goes through `bakeFrom` — the same
 * pipeline the circuit does, not a copy of it.
 *
 * The fixture is cut from the caches by `bun run env:fixture`; the test reads
 * it back with `loadFixture` and never touches the network.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadBakeInputs, type BakeInputs } from "./bake";
import type { Raster, RasterBBox, RasterHeader } from "./raster";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const FIXTURE_ROOT = join(REPO_ROOT, "scripts", "env", "fixtures");

export interface FixtureSpec {
  circuitId: string;
  /** Directory under `scripts/env/fixtures`. */
  name: string;
  /** Centre of the window, in degrees. */
  centre: [number, number];
  /** Field nodes across the window, per axis, at the DTM's own cell. */
  nodes: number;
}

/** What the fixture holds beside its two rasters. */
interface FixtureFile {
  circuitId: string;
  cutFrom: string;
  bbox: RasterBBox;
  coords: [number, number][];
  structures: BakeInputs["structures"];
  shoreWays: BakeInputs["shoreWays"];
  buildingWays: BakeInputs["buildingWays"];
  greenWays: BakeInputs["greenWays"];
  breaklineWays: BakeInputs["breaklineWays"];
  overrides: BakeInputs["overrides"];
}

const lonOf = (header: RasterHeader, col: number) =>
  header.bbox.minLon + ((header.bbox.maxLon - header.bbox.minLon) * col) / (header.width - 1);
const latOf = (header: RasterHeader, row: number) =>
  header.bbox.maxLat - ((header.bbox.maxLat - header.bbox.minLat) * row) / (header.height - 1);

/**
 * The nodes of `raster` inside `window`, as a raster of its own.
 *
 * The crop lands on the source's own nodes and takes the bbox from them, so a
 * height is the height that was fetched rather than a resample of it.
 */
export function cropRaster(raster: Raster, window: RasterBBox): Raster {
  const { header, data } = raster;
  const colAt = (lon: number) =>
    ((lon - header.bbox.minLon) / (header.bbox.maxLon - header.bbox.minLon)) * (header.width - 1);
  const rowAt = (lat: number) =>
    ((header.bbox.maxLat - lat) / (header.bbox.maxLat - header.bbox.minLat)) * (header.height - 1);

  const col0 = Math.max(0, Math.round(colAt(window.minLon)));
  const col1 = Math.min(header.width - 1, Math.round(colAt(window.maxLon)));
  const row0 = Math.max(0, Math.round(rowAt(window.maxLat)));
  const row1 = Math.min(header.height - 1, Math.round(rowAt(window.minLat)));
  const width = col1 - col0 + 1;
  const height = row1 - row0 + 1;
  if (width < 2 || height < 2) throw new Error(`${header.kind}: the window falls outside the raster`);

  const out = new Float32Array(width * height);
  let validCount = 0;
  let minValue = Infinity;
  let maxValue = -Infinity;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const value = data[(row0 + row) * header.width + col0 + col];
      out[row * width + col] = value;
      if (Number.isNaN(value)) continue;
      validCount++;
      if (value < minValue) minValue = value;
      if (value > maxValue) maxValue = value;
    }
  }

  return {
    header: {
      ...header,
      width,
      height,
      bbox: {
        minLon: lonOf(header, col0),
        maxLon: lonOf(header, col1),
        minLat: latOf(header, row1),
        maxLat: latOf(header, row0),
      },
      validCount,
      nodataCount: width * height - validCount,
      minValue: validCount ? minValue : 0,
      maxValue: validCount ? maxValue : 0,
    },
    data: out,
  };
}

/** Ways with a point inside the window, whole — the bake does its own clipping. */
function within<T extends { points?: [number, number][]; footprint?: [number, number][] }>(
  ways: T[],
  window: RasterBBox,
): T[] {
  const inside = ([lon, lat]: [number, number]) =>
    lon >= window.minLon && lon <= window.maxLon && lat >= window.minLat && lat <= window.maxLat;
  return ways.filter((way) => (way.points ?? way.footprint ?? []).some(inside));
}

async function writeRaster(dir: string, name: string, raster: Raster): Promise<void> {
  await writeFile(join(dir, `${name}.json`), `${JSON.stringify(raster.header, null, 2)}\n`);
  await writeFile(join(dir, `${name}.f32`), Buffer.from(raster.data.buffer));
}

async function readRaster(dir: string, name: string): Promise<Raster | null> {
  let header: RasterHeader;
  try {
    header = JSON.parse(await readFile(join(dir, `${name}.json`), "utf8")) as RasterHeader;
  } catch {
    return null;
  }
  const bytes = await readFile(join(dir, `${name}.f32`));
  // Copy: a Buffer's offset into its pool is not guaranteed 4-byte aligned.
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { header, data: new Float32Array(copy) };
}

export async function writeFixture(spec: FixtureSpec): Promise<{ dir: string; window: RasterBBox }> {
  const inputs = await loadBakeInputs(spec.circuitId);
  const halfLat =
    ((spec.nodes - 1) / 2) *
    ((inputs.dtm.header.bbox.maxLat - inputs.dtm.header.bbox.minLat) / (inputs.dtm.header.height - 1));
  const halfLon =
    ((spec.nodes - 1) / 2) *
    ((inputs.dtm.header.bbox.maxLon - inputs.dtm.header.bbox.minLon) / (inputs.dtm.header.width - 1));
  const window: RasterBBox = {
    minLon: spec.centre[0] - halfLon,
    maxLon: spec.centre[0] + halfLon,
    minLat: spec.centre[1] - halfLat,
    maxLat: spec.centre[1] + halfLat,
  };

  const dtm = cropRaster(inputs.dtm, window);
  const dir = join(FIXTURE_ROOT, spec.name);
  await mkdir(dir, { recursive: true });
  await writeRaster(dir, "dtm", dtm);
  if (inputs.mnh) await writeRaster(dir, "mnh", cropRaster(inputs.mnh, window));

  const file: FixtureFile = {
    circuitId: spec.circuitId,
    // The window the crop actually landed on, which is the DTM's own nodes.
    cutFrom: `${spec.circuitId} at ${spec.centre[0]}, ${spec.centre[1]} — ${dtm.header.width} x ${dtm.header.height} nodes`,
    bbox: dtm.header.bbox,
    // The centreline stays whole: the corridor is a closed loop, and half a
    // loop would close itself across the window and lay a road through it.
    coords: inputs.coords,
    structures: within(inputs.structures, window),
    shoreWays: within(inputs.shoreWays, window),
    buildingWays: within(inputs.buildingWays, window),
    greenWays: within(inputs.greenWays, window),
    breaklineWays: within(inputs.breaklineWays, window),
    overrides: inputs.overrides,
  };
  // One line per file rather than an indented tree: this is data for a test to
  // read, and the indented form was twice the bytes to commit.
  await writeFile(join(dir, "fixture.json"), `${JSON.stringify(file)}\n`);
  return { dir, window: dtm.header.bbox };
}

/**
 * The fixture as bake inputs. No network, no cache, no asset pack: the kit is
 * empty on purpose, because a checkout without `bun run assets:fetch` has to
 * get the same answer as one with it.
 */
export async function loadFixture(name: string): Promise<BakeInputs> {
  const dir = join(FIXTURE_ROOT, name);
  const file = JSON.parse(await readFile(join(dir, "fixture.json"), "utf8")) as FixtureFile;
  const dtm = await readRaster(dir, "dtm");
  if (!dtm) throw new Error(`fixture ${name}: no dtm — run bun run env:fixture`);
  return {
    circuitId: file.circuitId,
    coords: file.coords,
    bbox: file.bbox,
    dtm,
    mnh: await readRaster(dir, "mnh"),
    structures: file.structures,
    shoreWays: file.shoreWays,
    buildingWays: file.buildingWays,
    greenWays: file.greenWays,
    breaklineWays: file.breaklineWays,
    overrides: file.overrides,
    kitHouses: [],
    kitBoats: [],
    kitTrees: [],
  };
}

/** The fixtures this repository keeps. */
export const FIXTURES: FixtureSpec[] = [
  {
    circuitId: "mc-1929",
    name: "monaco-harbour",
    // Port Hercule: the quay, the water, Sainte-Dévote's ravine to the north
    // and the hill behind it — and the core/city boundary through the middle.
    centre: [7.4262, 43.7364],
    nodes: 200,
  },
];

async function main(): Promise<void> {
  for (const spec of FIXTURES) {
    const { dir, window } = await writeFixture(spec);
    console.log(`${spec.name} — ${dir}`);
    console.log(
      `  ${window.minLon.toFixed(5)}, ${window.minLat.toFixed(5)} to ` +
        `${window.maxLon.toFixed(5)}, ${window.maxLat.toFixed(5)}`,
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
