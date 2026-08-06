import { driversWithTeams, type DriverWithTeam } from "./f1-drivers";

/**
 * The parts of a race that exist before there is a simulation: who lines up
 * where, and how many laps the thing would run.
 */

/**
 * A grand prix runs the smallest number of laps exceeding 305 km. That single
 * rule reproduces the real number on almost every circuit from the lap length
 * the viewer already knows, so there is no table to keep in sync.
 */
const RACE_DISTANCE_M = 305_000;

/**
 * The circuits the rule does not describe. Monaco is the standing exception in
 * the regulations themselves — it runs to 260 km because it is slower than
 * anywhere else on the calendar.
 */
const LAP_COUNT_OVERRIDES: Record<string, number> = {
  "mc-1929": 78,
};

export function raceLapCount(circuitId: string, lapLengthMeters: number): number {
  const override = LAP_COUNT_OVERRIDES[circuitId];
  if (override) return override;
  if (!(lapLengthMeters > 0)) return 0;
  return Math.ceil(RACE_DISTANCE_M / lapLengthMeters);
}

/** xmur3 — string to a 32-bit seed. */
export function seedFrom(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 — small, fast, and identical across runs for a given seed. */
export function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The starting order.
 *
 * Random, because until a qualifying session exists any fixed order is a claim
 * the project cannot support — but seeded by circuit, so the same track always
 * shows the same grid. That keeps a shared link, a screenshot and a bug report
 * describing the same scene. `nonce` re-rolls it on demand.
 */
export function raceGridOrder(
  circuitId: string,
  nonce = 0,
): DriverWithTeam[] {
  const drivers = driversWithTeams();
  const random = randomFrom(seedFrom(`${circuitId}:${nonce}`));
  for (let i = drivers.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [drivers[i], drivers[j]] = [drivers[j], drivers[i]];
  }
  return drivers;
}

/** How a race progresses. The simulation will drive this; the HUD reads it. */
export type RacePhase =
  | "standby"
  | "formation"
  | "lights"
  | "racing"
  | "finished";
