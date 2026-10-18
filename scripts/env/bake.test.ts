/**
 * A committed slice of Monaco through the real pipeline: quay, cliff, tunnel mouth,
 * steep ground. Reads the GLB back with the audit's own reader.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkRelief,
  checkSeams,
  checkStanding,
  FLOATING_LIMIT_M,
  RELIEF_KINK_M,
  RELIEF_SLOPE_DEG,
  RELIEF_STEP_KEPT,
  SEAM_TOLERANCE_M,
  type Standing,
} from "../audit-environment";
import { bakeFrom, buildCircuitGround } from "./bake";
import { buildGroundIndex, readBakedCircuit } from "./baked-scene";
import { BELT_BUDGET, BELT_ORDER } from "./belts";
import { buildBreaklines } from "./breaklines";
import { loadFixture } from "./fixture";
import { buildGround } from "./ground";
import { buildStreetGround } from "./streets";

/** The AO floor: `COLOR_0` below it is a hole, not a shadow (I11). */
const SHADE_FLOOR = 0.278;

const inputs = await loadFixture("monaco-harbour");
const outRoot = await mkdtemp(join(tmpdir(), "f1-fixture-"));
const report = await bakeFrom(inputs, { outDir: join(outRoot, inputs.circuitId) });
const baked = await readBakedCircuit(outRoot, inputs.circuitId);

afterAll(async () => {
  await rm(outRoot, { recursive: true, force: true });
});

describe("the slice bakes", () => {
  test("into the belts the window reaches", () => {
    const named = new Map(baked.map((belt) => [belt.belt, belt.meshes.map((mesh) => mesh.name)]));
    expect(named.get("core")).toContain("terrain");
    expect(named.get("core")).toContain("building");
    expect(named.get("city")).toContain("terrain");
    // The harbour is in frame, so the water is too.
    expect(named.get("far")).toContain("water");
  });

  test("with real buildings on it", () => {
    expect(report.buildings.built).toBeGreaterThan(20);
    expect(report.buildings.droppedTooLow).toBe(0);
  });

  test("inside every belt's budget", () => {
    for (const belt of baked) {
      const budget = BELT_BUDGET[belt.belt];
      const triangles = belt.meshes.reduce((sum, mesh) => sum + mesh.triangles, 0);
      expect(belt.bytes).toBeLessThanOrEqual(budget.bytes);
      expect(triangles).toBeLessThanOrEqual(budget.triangles);
    }
  });
});

describe("what the shipped GLB has to hold", () => {
  test("no building floats, and none is buried whole", () => {
    const standing: Standing = {
      pieces: 0,
      overWater: 0,
      floating: 0,
      worstFloatM: 0,
      buried: 0,
      deepestDigM: 0,
    };
    const ground = buildGroundIndex(baked);
    for (const belt of baked) checkStanding(belt.meshes, ["building", "model"], ground, standing);
    expect(standing.pieces).toBeGreaterThan(10);
    expect(standing.floating).toBe(0);
    expect(standing.buried).toBe(0);
    // Walls dig as deep as the ground under them: a cost, not a fault. On this
    // hillside the deepest is about 22 m, and a jump would mean the terrace
    // handling moved.
    expect(standing.deepestDigM).toBeLessThan(30);
  });

  test("the belts agree where they meet", () => {
    const seam = checkSeams(baked, SEAM_TOLERANCE_M);
    expect(seam.points).toBeGreaterThan(100);
    // Monaco whole still carries 28 points over the limit; this window carries
    // none, so the fixture holds the invariant rather than the parked residue.
    expect(seam.overToleranceM).toBe(0);
    expect(seam.worstM).toBeLessThan(SEAM_TOLERANCE_M);
  });

  test("vertex colour stays in range (I11)", () => {
    let lowest = 1;
    let highest = 0;
    for (const belt of baked) {
      for (const mesh of belt.meshes) {
        if (!mesh.colors) continue;
        for (const channel of mesh.colors) {
          if (channel < lowest) lowest = channel;
          if (channel > highest) highest = channel;
        }
      }
    }
    expect(lowest).toBeGreaterThanOrEqual(SHADE_FLOOR);
    expect(highest).toBeLessThanOrEqual(1);
  });
});

describe("the filter, on ground that was surveyed rather than written", () => {
  const { field, plane } = buildCircuitGround(inputs);
  const breaklines = buildBreaklines(field, inputs.breaklineWays, inputs.shoreWays);
  // The filter on its own: this window is all town, and the street levels laid
  // over it (`streets.ts`) are a different thing to measure — the surface they
  // make is the town's, not the filter's.
  const streets = buildStreetGround([], [], field, plane, breaklines);
  const surface = buildGround(field, plane, breaklines, streets);
  const relief = checkRelief(surface, field, plane, breaklines, "city", streets);

  test("takes the ripple out and leaves the relief in", () => {
    expect(relief.kinkM).toBeLessThanOrEqual(RELIEF_KINK_M);
    expect(relief.kinkM).toBeLessThan(relief.rawKinkM);
    expect(Math.abs(relief.meanSlopeDeg - relief.rawSlopeDeg)).toBeLessThanOrEqual(RELIEF_SLOPE_DEG);
  });

  test("and keeps the step across a surveyed wall", () => {
    // Nine breaklines run through this window — a real cliff and real quay
    // walls, not a line drawn to be found.
    expect(relief.stepEdges).toBeGreaterThan(5);
    expect(relief.stepKept).toBeGreaterThanOrEqual(RELIEF_STEP_KEPT);
  });
});

describe("the bake is reproducible (I12)", () => {
  test("the same inputs write the same bytes", async () => {
    const again = await mkdtemp(join(tmpdir(), "f1-fixture-"));
    await bakeFrom(await loadFixture("monaco-harbour"), { outDir: join(again, inputs.circuitId) });
    for (const belt of BELT_ORDER) {
      const first = await readFile(join(outRoot, inputs.circuitId, `${belt}.glb`));
      const second = await readFile(join(again, inputs.circuitId, `${belt}.glb`));
      expect(second.equals(first)).toBe(true);
    }
    await rm(again, { recursive: true, force: true });
  }, 20_000);
});
