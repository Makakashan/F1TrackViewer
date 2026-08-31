/// <reference types="bun-types" />
/**
 * The fixed cameras of `docs/scene-goals.md` §4, and the runner that takes them.
 *
 * Some judgements about a bake stay visual — a hillside reads as a smear or it
 * does not — and a judgement made from a different angle every time is not a
 * comparison. These are the same eight frames every bake, written to `images/`
 * for a person to look at. No pixel diff: every bake moves every vertex a
 * little, so a strict comparison would fail always and be switched off within a
 * week.
 *
 * The cameras are polar around a scene-space target, which is what
 * `preview.html` already takes; this file is the list and the driver.
 */

import { chromium } from "playwright-core";

export interface Shot {
  name: string;
  /** What the frame is for. Printed beside the file it writes. */
  watch: string;
  /** Where the camera looks, in scene metres. */
  target: { x: number; z: number; y?: number };
  /** Compass bearing of the camera from the target, in degrees. */
  azimuthDeg: number;
  /** How far above the horizon the camera sits, in degrees. */
  elevationDeg: number;
  distanceM: number;
  /** Belts to load. All three unless a shot is about one of them. */
  belts?: string[];
  /** `ao` shows the baked vertex colour with no light in the way. */
  shading?: "ao";
}

/**
 * Monaco's eight. The targets are scene metres from the circuit's own centre,
 * which is the middle of the harbour; X runs east and Z runs south.
 */
export const SHOTS: Record<string, Shot[]> = {
  "mc-1929": [
    {
      name: "overview",
      watch: "silhouette, budget, the whole thing at once",
      target: { x: 0, z: 0 },
      azimuthDeg: 135,
      elevationDeg: 38,
      distanceM: 2400,
    },
    {
      name: "harbour",
      watch: "quay line, berthed hulls, water meeting the wall",
      target: { x: 100, z: 200, y: 5 },
      azimuthDeg: 45,
      elevationDeg: 16,
      distanceM: 560,
    },
    {
      name: "hillside",
      watch: "slope shading, terraces, the smear that started this",
      target: { x: -150, z: -250, y: 80 },
      azimuthDeg: 20,
      elevationDeg: 20,
      distanceM: 1100,
    },
    {
      name: "ravine",
      watch: "buildings standing on steep ground",
      // The valley west of the port: 75 m of fall inside 120 m, built on both
      // sides. Found by walking the drawn ground rather than by eye.
      target: { x: -460, z: -40, y: 40 },
      azimuthDeg: 45,
      elevationDeg: 15,
      distanceM: 380,
    },
    {
      name: "tunnel-mouth",
      watch: "bore, portal, the buried span",
      // The seaward portal, from the road's own line: the bore runs from
      // (370, -391) to (181, -111), and the ring stands 5 m out of the cutting.
      target: { x: 368, z: -389, y: 11 },
      azimuthDeg: 146,
      elevationDeg: 2,
      distanceM: 65,
    },
    {
      name: "rocher",
      watch: "cliff kept vertical by the filter",
      // From the sea, low: the face has to read as a face, and from above it
      // reads as a plateau whatever the filter did to it.
      target: { x: -180, z: 590, y: 40 },
      azimuthDeg: 315,
      elevationDeg: 6,
      distanceM: 600,
    },
    {
      name: "seam-core-city",
      watch: "I3 by eye — the 150 m boundary, where 4 m meets 8 m",
      // Raking, from outside the boundary looking in: a tear shows against the
      // slope, and this is the steepest ground the boundary crosses.
      target: { x: -460, z: -120, y: 30 },
      azimuthDeg: 250,
      elevationDeg: 40,
      distanceM: 600,
    },
    {
      name: "seam-city-far",
      watch: "the same, where 8 m meets 16 m at 600 m",
      target: { x: -850, z: 660, y: 40 },
      azimuthDeg: 250,
      elevationDeg: 35,
      distanceM: 800,
    },
  ],
};

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const PORT = Number(process.env.PREVIEW_PORT ?? 4010);

function urlFor(circuitId: string, shot: Shot): string {
  const params = new URLSearchParams({
    circuit: circuitId,
    az: String(shot.azimuthDeg),
    el: String(shot.elevationDeg),
    dist: String(shot.distanceM),
    tx: String(shot.target.x),
    tz: String(shot.target.z),
    y: String(shot.target.y ?? 0),
    shot: `${circuitId}-${shot.name}`,
  });
  if (shot.belts) params.set("belts", shot.belts.join(","));
  if (shot.shading) params.set("shading", shot.shading);
  return `http://localhost:${PORT}/?${params}`;
}

async function serverIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const circuitId = args.find((arg) => !arg.startsWith("--")) ?? "mc-1929";
  const only = args.find((arg) => arg.startsWith("--only="))?.slice(7);
  const width = Number(args.find((arg) => arg.startsWith("--width="))?.slice(8) ?? 1600);
  const height = Number(args.find((arg) => arg.startsWith("--height="))?.slice(9) ?? 900);

  const shots = (SHOTS[circuitId] ?? []).filter((shot) => !only || shot.name === only);
  if (!shots.length) throw new Error(`no shots for ${circuitId}${only ? ` named ${only}` : ""}`);

  // A preview already running is the user's own; only a port nobody answers on
  // gets a server of ours, and that one is stopped again at the end.
  const borrowed = await serverIsUp();
  const server = borrowed
    ? null
    : Bun.spawn(["bun", "scripts/env/preview.ts"], { cwd: REPO_ROOT, stdout: "ignore", stderr: "ignore" });
  try {
    if (server) {
      const deadline = Date.now() + 10_000;
      while (!(await serverIsUp())) {
        if (Date.now() > deadline) throw new Error(`preview did not come up on ${PORT}`);
        await Bun.sleep(100);
      }
    }

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height } });
      for (const shot of shots) {
        await page.goto(urlFor(circuitId, shot), { waitUntil: "load" });
        // The page renders, posts the canvas back, and only then says ready.
        await page.waitForFunction(() => document.title === "ready", null, { timeout: 60_000 });
        console.log(`  images/${circuitId}-${shot.name}.png — ${shot.watch}`);
      }
    } finally {
      await browser.close();
    }
  } finally {
    server?.kill();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
