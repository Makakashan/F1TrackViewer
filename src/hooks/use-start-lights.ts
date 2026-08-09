import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { START_LIGHT_COLUMNS } from "@/lib/race/start-lights";
import type { RacePhase } from "@/lib/race/race-session";

const COLUMN_INTERVAL_MS = 1000;
/** The hold before the lights go out is deliberately unpredictable, as in a real start. */
const HOLD_MIN_MS = 1200;
const HOLD_MAX_MS = 3000;

export interface StartLightSequence {
  /** Columns currently lit, 0–5. */
  lit: number;
  phase: RacePhase;
  running: boolean;
  run: () => void;
  reset: () => void;
}

/** The start sequence: five columns come up a second apart, hold, then all go out at once. */
export function useStartLightSequence(): StartLightSequence {
  const [lit, setLit] = useState(0);
  const [phase, setPhase] = useState<RacePhase>("standby");
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    setLit(0);
    setPhase("standby");
  }, [clearTimers]);

  const run = useCallback(() => {
    clearTimers();
    setLit(0);
    setPhase("lights");

    for (let column = 1; column <= START_LIGHT_COLUMNS; column++) {
      timers.current.push(
        window.setTimeout(() => setLit(column), column * COLUMN_INTERVAL_MS),
      );
    }

    const hold =
      HOLD_MIN_MS + Math.random() * (HOLD_MAX_MS - HOLD_MIN_MS);
    const lightsOutAt = START_LIGHT_COLUMNS * COLUMN_INTERVAL_MS + hold;

    timers.current.push(
      window.setTimeout(() => {
        setLit(0);
        setPhase("racing");
      }, lightsOutAt),
    );
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  // Memoized: callers put these callbacks in effect dependency lists.
  return useMemo(
    () => ({ lit, phase, running: phase === "lights", run, reset }),
    [lit, phase, run, reset],
  );
}
