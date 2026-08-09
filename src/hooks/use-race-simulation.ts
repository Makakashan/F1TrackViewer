"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createRaceSim,
  raceStandings,
  stepRace,
  type RaceSimSetup,
  type RaceSimState,
  type RaceStanding,
} from "@/lib/race/race-sim";
import type { RacePhase } from "@/lib/race/race-session";
import { useStartLightSequence } from "@/hooks/use-start-lights";

/** The race as the app sees it: a ref for the scene, a snapshot for the HUD. */

/** Simulation steps per second. Fixed, so frame rate cannot change the race. */
const STEP_HZ = 30;
const PERFORMANCE_STEP_HZ = 20;
/** How often the HUD snapshot is refreshed, in seconds. */
const SNAPSHOT_INTERVAL_S = 0.2;
/** Longest span a single frame may advance the race. */
const MAX_FRAME_ADVANCE_S = 0.5;

export const RACE_SPEED_OPTIONS = [1, 2, 4, 8, 16] as const;
export type RaceSpeed = (typeof RACE_SPEED_OPTIONS)[number];

/** The half of the simulation the 3D scene needs. */
export interface RaceController {
  phase: RacePhase;
  racing: boolean;
  stateRef: React.RefObject<RaceSimState | null>;
  /** How far into the next step the frame is — see interpolateCarPose. */
  alphaRef: React.RefObject<number>;
  attach: (setup: RaceSimSetup | null) => void;
  step: (deltaSeconds: number) => void;
}

export interface RaceSimulation {
  /** Columns of the start lights currently lit, 0–5. */
  lit: number;
  phase: RacePhase;
  /** True from lights out until every car has stopped. */
  racing: boolean;
  paused: boolean;
  complete: boolean;
  speed: RaceSpeed;
  /** Seconds of race time elapsed. */
  elapsed: number;
  /** Running order, refreshed a few times a second. */
  standings: RaceStanding[];
  /** Fastest lap so far: whose, and how long. */
  fastestLap: { index: number; time: number } | null;
  /** Run the remaining distance without rendering it. */
  finish: () => void;
  /** Everything the scene needs, and nothing that re-renders it. */
  controller: RaceController;
  start: () => void;
  reset: () => void;
  togglePause: () => void;
  setSpeed: (speed: RaceSpeed) => void;
}

export function useRaceSimulation(lowDetail = false): RaceSimulation {
  const lights = useStartLightSequence();
  // The callbacks, not the object: these land in dependency lists one component up.
  const { run: runLights, reset: resetLights } = lights;
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<RaceSpeed>(1);
  const [standings, setStandings] = useState<RaceStanding[]>([]);
  const [fastestLap, setFastestLap] = useState<{ index: number; time: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [complete, setComplete] = useState(false);

  const setupRef = useRef<RaceSimSetup | null>(null);
  const stateRef = useRef<RaceSimState | null>(null);
  const carryRef = useRef(0);
  const alphaRef = useRef(0);
  const sinceSnapshotRef = useRef(0);

  const racing = lights.phase === "racing" && !complete;

  const snapshot = useCallback(() => {
    const setup = setupRef.current;
    const state = stateRef.current;
    setStandings(
      setup && state ? raceStandings(state, setup.lapLengthMeters) : [],
    );
    setFastestLap(state?.fastestLap ?? null);
    setElapsed(state?.time ?? 0);
  }, []);

  const attach = useCallback(
    (setup: RaceSimSetup | null) => {
      setupRef.current = setup;
      stateRef.current = setup ? createRaceSim(setup) : null;
      carryRef.current = 0;
      setComplete(false);
      snapshot();
    },
    [snapshot],
  );

  const reset = useCallback(() => {
    resetLights();
    const setup = setupRef.current;
    stateRef.current = setup ? createRaceSim(setup) : null;
    carryRef.current = 0;
    sinceSnapshotRef.current = 0;
    setPaused(false);
    setComplete(false);
    snapshot();
  }, [resetLights, snapshot]);

  const start = useCallback(() => {
    const setup = setupRef.current;
    stateRef.current = setup ? createRaceSim(setup) : null;
    carryRef.current = 0;
    setPaused(false);
    setComplete(false);
    setElapsed(0);
    runLights();
  }, [runLights]);

  const togglePause = useCallback(() => setPaused((value) => !value), []);

  const step = useCallback(
    (deltaSeconds: number) => {
      const setup = setupRef.current;
      const state = stateRef.current;
      if (!setup || !state) return;
      if (!racing || paused) return;

      const stepSize = 1 / (lowDetail ? PERFORMANCE_STEP_HZ : STEP_HZ);
      const advance = Math.min(deltaSeconds, MAX_FRAME_ADVANCE_S) * speed;
      carryRef.current += advance;

      let steps = 0;
      while (carryRef.current >= stepSize) {
        stepRace(state, setup, stepSize);
        carryRef.current -= stepSize;
        steps++;
      }
      // The remainder is time the screen has seen but the simulation has not consumed.
      alphaRef.current = carryRef.current / stepSize;
      if (!steps) return;

      sinceSnapshotRef.current += advance;
      if (sinceSnapshotRef.current >= SNAPSHOT_INTERVAL_S || state.complete) {
        sinceSnapshotRef.current = 0;
        snapshot();
        if (state.complete) setComplete(true);
      }
    },
    [lowDetail, paused, racing, snapshot, speed],
  );

  /** To the flag: the same stepper without the renderer between steps. */
  const finish = useCallback(() => {
    const setup = setupRef.current;
    const state = stateRef.current;
    if (!setup || !state || !racing) return;

    const stepSize = 1 / STEP_HZ;
    const maxSteps = STEP_HZ * 60 * 60 * 4;
    for (let i = 0; i < maxSteps && !state.complete; i++) {
      stepRace(state, setup, stepSize);
    }
    carryRef.current = 0;
    alphaRef.current = 0;
    snapshot();
    setComplete(true);
  }, [racing, snapshot]);

  // Unmounting must not leave a race running in a ref that outlives the tree.
  useEffect(() => {
    return () => {
      stateRef.current = null;
      setupRef.current = null;
    };
  }, []);

  const phase: RacePhase = complete ? "finished" : lights.phase;

  const controller = useMemo<RaceController>(
    () => ({ phase, racing, stateRef, alphaRef, attach, step }),
    [attach, phase, racing, step],
  );

  return useMemo(
    () => ({
      lit: lights.lit,
      phase,
      racing,
      paused,
      complete,
      speed,
      elapsed,
      standings,
      fastestLap,
      finish,
      controller,
      start,
      reset,
      togglePause,
      setSpeed,
    }),
    [
      complete,
      controller,
      elapsed,
      fastestLap,
      finish,
      lights.lit,
      paused,
      phase,
      racing,
      reset,
      speed,
      standings,
      start,
      togglePause,
    ],
  );
}
