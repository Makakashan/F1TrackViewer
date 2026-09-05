/// <reference types="bun-types" />
/**
 * One building, on flat ground, through the real bake.
 *
 * A facade is judged by looking at it, and a full bake is forty seconds and
 * four thousand buildings between a change and the look at it. This puts a
 * single footprint through `bakeBuildings` — the same walls, the same tiles,
 * the same paint the city gets — and writes it where `env:preview` already
 * looks, so the loop is one command.
 *
 *   bun run env:one block 24        # facade class, height in metres
 *   bun run env:preview             # then ?circuit=one&belts=core
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium } from "playwright-core";
import { PNG } from "pngjs";

import { bakeBuildings, emptyBuildingResult, writeGlb, type PreparedBuilding } from "./bake";
import { FACADES, type Facade } from "./facades";
import { createMesh, triangleCount, addFlatQuad, type Mesh } from "./mesh";
import { applyAmbientOcclusion, applyPaint, buildOccluders } from "./ao";
import { planeFor, syntheticField } from "./synthetic";
import type { Corridor } from "./belts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const OUT_DIR = join(REPO_ROOT, "public", "environments", "one");

/** Nothing here is near a track, so every reach is allowed. */
const NO_CORRIDOR: Corridor = {
  distance: () => 1e6,
  measure: (x, z) => ({ distanceM: 1e6, footX: x, footZ: z }),
  samples: [],
};

/**
 * A footprint centred on the origin, wound so the walls face outwards.
 *
 * Four corners by default; more makes the curved plan Monaco is full of, where
 * consecutive walls turn a few degrees at a time. A defect that only shows on a
 * curve — a slot at a shared vertex, a reveal wound the wrong way — is invisible
 * on a rectangle, which is what the harness could build until now.
 */
function plot(halfX: number, halfZ: number, sides: number): { x: number; z: number }[] {
  if (sides <= 4) {
    return [
      { x: -halfX, z: -halfZ },
      { x: halfX, z: -halfZ },
      { x: halfX, z: halfZ },
      { x: -halfX, z: halfZ },
    ];
  }
  return Array.from({ length: sides }, (_, i) => {
    const angle = (2 * Math.PI * i) / sides;
    return { x: Math.cos(angle) * halfX, z: Math.sin(angle) * halfZ };
  });
}

function prepare(
  facade: Facade,
  heightM: number,
  halfX: number,
  halfZ: number,
  /** The bake rolls off the centre, so this is what varies paint and roof. */
  seed: number,
  sides: number,
): PreparedBuilding {
  const ring = plot(halfX, halfZ, sides);
  return {
    id: `one/${facade}`,
    ring,
    wallRing: ring,
    footAt: ring.map(() => 0),
    base: 0,
    heightM,
    centreX: seed * 13.7,
    centreZ: seed * 7.3,
    belt: "core",
    facade,
  };
}

/** Something to stand on, so the building is not a box in fog. */
function apron(halfX: number, halfZ: number) {
  const mesh = createMesh();
  mesh.tone = [0.62, 0.63, 0.6];
  const x = halfX + 14;
  const z = halfZ + 14;
  addFlatQuad(mesh, -x, -0.05, z, x, -0.05, z, x, -0.05, -z, -x, -0.05, -z);
  return mesh;
}

const facade = (process.argv[2] ?? "block") as Facade;
if (!FACADES.includes(facade)) {
  console.error(`unknown facade ${facade} — one of ${FACADES.join(", ")}`);
  process.exit(1);
}
const heightM = Number(process.argv[3] ?? 24);
const halfX = Number(process.argv[4] ?? 11);
const halfZ = Number(process.argv[5] ?? 8);
const seed = Number(process.argv[6] ?? 1);
const sides = Number(process.argv[7] ?? 4);

const result = emptyBuildingResult();
bakeBuildings(
  [prepare(facade, heightM, halfX, halfZ, seed, sides)],
  new Map(),
  NO_CORRIDOR,
  result,
  new Set(),
);

/**
 * The same two passes the bake runs, over flat ground of our own.
 *
 * Filling the occlusion channel with ones instead was a mistake worth naming:
 * it showed the facade as pure albedo, with no shading at all, which is the one
 * view in which a projecting band and a painted stripe look identical. The
 * ground is synthetic and level, so what comes out is the building shading
 * itself — its own soffits and reveals — which is the thing under review.
 */
const FLAT_GROUND = syntheticField({ cols: 96, rows: 96, cellM: 4, at: () => 0 });

function shade(meshes: Mesh[]): Mesh[] {
  const occluders = buildOccluders(FLAT_GROUND, planeFor(FLAT_GROUND), meshes);
  for (const mesh of meshes) {
    applyAmbientOcclusion(mesh, occluders);
    applyPaint(mesh);
  }
  return meshes;
}

const ground = process.env.ENV_ONE_NO_GROUND ? createMesh() : apron(halfX, halfZ);
shade([
  ground,
  result.plain.core,
  result.deck.core,
  ...FACADES.flatMap((f) => [result.walls.core[f], result.shops.core[f]]),
]);

const parts = [
  { kind: "terrain" as const, mesh: ground },
  { kind: "building" as const, mesh: result.plain.core },
  { kind: "roof" as const, mesh: result.deck.core },
  ...FACADES.flatMap((f) => [
    { kind: "building" as const, mesh: result.walls.core[f], facade: f, zone: "storey" as const },
    { kind: "building" as const, mesh: result.shops.core[f], facade: f, zone: "shop" as const },
  ]),
];

await mkdir(OUT_DIR, { recursive: true });
// The core belt builds its balconies, so its tiles must not carry one too.
const bytes = await writeGlb(join(OUT_DIR, "core.glb"), parts, false);
const triangles = parts.reduce((sum, part) => sum + triangleCount(part.mesh), 0);
console.log(
  `${facade} ${heightM} m on ${halfX * 2}×${halfZ * 2} m, ${sides} sides — ${triangles} triangles, ${(bytes / 1024).toFixed(0)} kB`,
);

const PORT = Number(process.env.PREVIEW_PORT ?? 4010);
const view = `circuit=one&belts=core&dist=${Math.max(46, heightM * 2.4)}&y=${heightM * 0.45}`;
const SHOT_SIZE = (process.env.ENV_ONE_SIZE ?? "900x1000").split("x").map(Number);
console.log(`  preview: http://localhost:${PORT}/?${view}`);

/**
 * Every face of a building is one-sided, so a face wound the wrong way is not a
 * dark patch — it is a hole, and what shows through it is whatever is behind
 * the building. Rendering the same frame twice, once with every material
 * double-sided, and differencing the two names exactly those pixels: a correct
 * model is identical in both, up to the antialiasing seam along an edge.
 *
 * Two shelves and two reveals shipped wound inside out before this existed, and
 * neither was visible until somebody put the camera against the wall.
 */
async function holePixels(a: string, b: string): Promise<number> {
  const [left, right] = await Promise.all([readFile(a), readFile(b)].map((p) => p.then((bytes) => PNG.sync.read(bytes))));
  // A hole is where the single-sided render shows the sky and the double-sided
  // one shows the model: the eye went through the surface and out the back.
  // Comparing the two frames outright flags more than that — over a parapet the
  // inside of the far wall legitimately appears only when back faces are drawn —
  // and those are not holes.
  const sky = [0xae, 0xbd, 0xc8];
  const mask = new Uint8Array(left.width * left.height);
  for (let i = 0; i < mask.length; i++) {
    const at = i * 4;
    const through =
      Math.abs(left.data[at] - sky[0]) +
      Math.abs(left.data[at + 1] - sky[1]) +
      Math.abs(left.data[at + 2] - sky[2]);
    const covered =
      Math.abs(right.data[at] - sky[0]) +
      Math.abs(right.data[at + 1] - sky[1]) +
      Math.abs(right.data[at + 2] - sky[2]);
    mask[i] = through < 12 && covered > 24 ? 1 : 0;
  }
  // Eroded by one pixel in each direction: a seam along an edge does not
  // survive it, a face that is missing does.
  let holes = 0;
  for (let y = 1; y < left.height - 1; y++) {
    for (let x = 1; x < left.width - 1; x++) {
      const i = y * left.width + x;
      if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - left.width] && mask[i + left.width]) holes++;
    }
  }
  return holes;
}

if (!process.argv.includes("--shot") && !process.argv.includes("--holes")) process.exit(0);

/**
 * Two bearings, because a corner tells more about a facade than a face does,
 * plus the roof and a plan. `ENV_ONE_ANGLES` replaces the list with
 * `name:az:el[:dist]` entries, which is what fitting a reference camera needs.
 */
const ANGLES = (process.env.ENV_ONE_ANGLES ?? "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [name, az, el, dist] = entry.split(":");
    return { name, az: Number(az), el: Number(el), dist: dist ? Number(dist) : undefined };
  });
if (!ANGLES.length) {
  ANGLES.push(
    { name: "face", az: 135, el: 16, dist: undefined },
    { name: "corner", az: 205, el: 16, dist: undefined },
    { name: "roof", az: 205, el: 44, dist: undefined },
    { name: "plan", az: 180, el: 84, dist: undefined },
  );
}

async function serverIsUp(): Promise<boolean> {
  try {
    return (await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

// A preview already running is the user's own; ours is stopped again at the end.
const borrowed = await serverIsUp();
const server = borrowed
  ? null
  : Bun.spawn(["bun", "scripts/env/preview.ts"], { cwd: REPO_ROOT, stdout: "ignore", stderr: "ignore" });
try {
  const deadline = Date.now() + 10_000;
  while (!(await serverIsUp())) {
    if (Date.now() > deadline) throw new Error(`preview did not come up on ${PORT}`);
    await Bun.sleep(100);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: SHOT_SIZE[0], height: SHOT_SIZE[1] } });
    const holes = process.argv.includes("--holes");
    let worst = 0;
    for (const angle of ANGLES) {
      const shot = `one-${facade}-${angle.name}`;
      // Replaced, not appended: a second `dist` in the query is ignored, and a
      // camera override that silently does nothing is worse than none.
      const framing = angle.dist ? view.replace(/dist=[^&]*/, `dist=${angle.dist}`) : view;
      const shading = process.env.ENV_ONE_SHADING ? `&shading=${process.env.ENV_ONE_SHADING}` : "";
      const extra = process.env.ENV_ONE_EXTRA ? `&${process.env.ENV_ONE_EXTRA}` : "";
      await page.goto(`http://localhost:${PORT}/?${framing}&az=${angle.az}&el=${angle.el}${shading}${extra}&shot=${shot}`, {
        waitUntil: "load",
      });
      await page.waitForFunction(() => document.title === "ready", null, { timeout: 60_000 });
      if (!holes) {
        console.log(`  images/${shot}.png`);
        continue;
      }
      const single = join(REPO_ROOT, "images", `${shot}.png`);
      const both = join(REPO_ROOT, "images", `${shot}-double.png`);
      await page.goto(
        `http://localhost:${PORT}/?${framing}&az=${angle.az}&el=${angle.el}${shading}${extra}&sides=double&shot=${shot}-double`,
        { waitUntil: "load" },
      );
      await page.waitForFunction(() => document.title === "ready", null, { timeout: 60_000 });
      const count = await holePixels(single, both);
      worst = Math.max(worst, count);
      console.log(`  ${angle.name.padEnd(8)} ${count === 0 ? "watertight" : `${count} pixels see through`}`);
    }
    if (holes && worst > 8) process.exitCode = 1;
  } finally {
    await browser.close();
  }
} finally {
  server?.kill();
}
