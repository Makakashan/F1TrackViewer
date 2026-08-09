import { speedAt, ACCEL_G, BRAKING_G, type SpeedProfile } from "@/lib/race/speed-profile";
import { racingLineOffsetAt, type RacingLine } from "@/lib/track/racing-line";
import { seedFrom, randomFrom } from "@/lib/race/race-session";
import { gridSetbackMeters, type GridSlot } from "@/lib/race/start-grid";

/** Twenty cars driving a lap. */

const G = 9.81;
/** Car body, in meters. */
const CAR_LENGTH_M = 5.6;
const CAR_WIDTH_M = 2;
/** Standing gap a car keeps to the one ahead, in meters. */
const MIN_GAP_M = 6;
/** Extra gap per unit of speed — a time headway, in seconds. */
const HEADWAY_S = 0.35;
/** Share of the braking limit a car plans to use when closing on another. */
const CLOSING_BRAKE_MARGIN = 0.45;
/** Sideways travel rate when moving off the line, in meters per second. */
const LATERAL_RATE_MS = 2.4;
/** Cap on sideways travel as a share of forward travel. */
const MAX_LATERAL_SLOPE = 0.2;
/** Clear space a car needs beside another before it will pull alongside. */
const SIDE_CLEARANCE_M = CAR_WIDTH_M + 0.6;
/** How far back, and how many places up, a car looks for the one ahead. */
const LOOKAHEAD_M = 120;
const LOOKAHEAD_CARS = 5;
/** Reaction to the lights going out, in seconds. */
const REACTION_MIN_S = 0.2;
const REACTION_MAX_S = 0.5;
/** Spread of per-car pace, as a fraction of the speed limit. */
const PACE_SPREAD = 0.015;
/** How far a car's pace may wander over a race distance — the stand-in for tyres, fuel and rhythm. */
const PACE_DRIFT_SPREAD = 0.008;
/** Hard bounds on drifted pace, so no car becomes comically fast or slow. */
const PACE_MIN = 0.975;
const PACE_MAX = 1.025;
/** Used to estimate race duration for scaling the drift rate, in m/s. */
const TYPICAL_RACE_SPEED_MS = 55;
/** Gentle braking after the finish line, in g. */
const COOLDOWN_G = 0.35;

export interface RaceCar {
  /** Index into the running order the caller supplied. */
  index: number;
  /** Normalized arc position on the curve. */
  s: number;
  /** Position along the track measured from the start line, in meters. */
  distance: number;
  /** Meters per second. */
  speed: number;
  /** Lateral offset from the centerline, in meters. */
  lateral: number;
  /** Where the car was before the most recent step; the renderer tweens. */
  prevS: number;
  prevLateral: number;
  /** Multiplier on the speed limit — this car's pace. */
  pace: number;
  /** How the pace wanders, per second of race time. */
  driftRate: number;
  /** Seconds after lights out before this car moves. */
  reaction: number;
  /** Laps completed. */
  laps: number;
  /** When the current lap started, in race seconds. */
  lapStartTime: number;
  /** Best lap so far, in seconds. */
  bestLap: number | null;
  /** Set when the car takes the flag, in race seconds. */
  finishTime: number | null;
  /** True once the car has taken the flag. */
  finished: boolean;
  /** True once the car has finished and rolled to a stop. */
  stopped: boolean;
  /** Where this car has been, so gaps can be timed rather than estimated. */
  trace: CarTrace;
}

/** A car's recent history as a ring of (distance, time) samples. */
export interface CarTrace {
  distance: Float64Array;
  time: Float64Array;
  /** Index of the newest sample; -1 while empty. */
  head: number;
  count: number;
  /** Race time the next sample is due. */
  nextAt: number;
}

/** How often the trace records a car's position, in simulated seconds. */
const TRACE_INTERVAL_S = 0.25;
/** How far back the trace remembers. Gaps wider than this fall back. */
const TRACE_WINDOW_S = 150;
const TRACE_CAPACITY = Math.ceil(TRACE_WINDOW_S / TRACE_INTERVAL_S);

function createTrace(): CarTrace {
  return {
    distance: new Float64Array(TRACE_CAPACITY),
    time: new Float64Array(TRACE_CAPACITY),
    head: -1,
    count: 0,
    nextAt: 0,
  };
}

function pushTrace(trace: CarTrace, distance: number, time: number): void {
  trace.head = (trace.head + 1) % TRACE_CAPACITY;
  trace.distance[trace.head] = distance;
  trace.time[trace.head] = time;
  if (trace.count < TRACE_CAPACITY) trace.count++;
}

/** When the traced car was at `distance`, or null if outside the window. */
function timeAtDistance(trace: CarTrace, distance: number): number | null {
  if (trace.count < 2) return null;
  const at = (i: number) =>
    (trace.head - trace.count + 1 + i + TRACE_CAPACITY * 2) % TRACE_CAPACITY;
  if (distance <= trace.distance[at(0)]) return null;
  const newest = at(trace.count - 1);
  if (distance >= trace.distance[newest]) return trace.time[newest];

  let low = 0;
  let high = trace.count - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (trace.distance[at(mid)] <= distance) low = mid;
    else high = mid;
  }
  const a = at(low);
  const b = at(high);
  const span = trace.distance[b] - trace.distance[a];
  if (!(span > 0)) return trace.time[b];
  const f = (distance - trace.distance[a]) / span;
  return trace.time[a] + (trace.time[b] - trace.time[a]) * f;
}

export interface RaceSimState {
  cars: RaceCar[];
  /** Seconds since the lights went out. */
  time: number;
  /** True once the leader has covered the race distance. */
  flagged: boolean;
  /** Fastest lap of the race so far. */
  fastestLap: { index: number; time: number } | null;
  /** True once every car has finished and stopped. */
  complete: boolean;
}

export interface RaceSimSetup {
  slots: GridSlot[];
  speedProfile: SpeedProfile;
  racingLine: RacingLine;
  /** Half width of the track at s, for deciding whether a car fits beside. */
  halfWidthAtS: (s: number) => number;
  lapLengthMeters: number;
  /** Seeds the pace spread and reaction times — same seed, same race. */
  seed: string;
  /** Race distance in laps. The flag falls when the leader completes them. */
  laps: number;
}

export function createRaceSim(setup: RaceSimSetup): RaceSimState {
  const random = randomFrom(seedFrom(setup.seed));
  // Drift is budgeted over the whole race, not per second.
  const raceSeconds =
    (setup.laps * setup.lapLengthMeters) / TYPICAL_RACE_SPEED_MS;
  const cars: RaceCar[] = setup.slots.map((slot, index) => ({
    index,
    s: slot.s,
    prevS: slot.s,
    distance: -gridSetbackMeters(slot.place),
    speed: 0,
    lateral: slot.lateralOffset,
    prevLateral: slot.lateralOffset,
    // Drawn per car, not from grid position, so the field changes shape.
    pace: 1 + (random() * 2 - 1) * PACE_SPREAD,
    driftRate: ((random() * 2 - 1) * PACE_DRIFT_SPREAD) / Math.max(raceSeconds, 1),
    reaction: REACTION_MIN_S + random() * (REACTION_MAX_S - REACTION_MIN_S),
    laps: 0,
    lapStartTime: 0,
    bestLap: null,
    finishTime: null,
    finished: false,
    stopped: false,
    trace: createTrace(),
  }));
  return { cars, time: 0, flagged: false, fastestLap: null, complete: false };
}

/** Advance the race by exactly `dt` seconds. Mutates in place. */
export function stepRace(
  state: RaceSimState,
  setup: RaceSimSetup,
  dt: number,
): void {
  if (state.complete) return;
  state.time += dt;

  // The "from" of the render interpolation.
  for (const car of state.cars) {
    car.prevS = car.s;
    car.prevLateral = car.lateral;
  }

  const { speedProfile, racingLine, lapLengthMeters, halfWidthAtS } = setup;
  const lapTarget = setup.laps;

  // Leader first: "what is in front of me" needs the field in track order.
  const order = state.cars.slice().sort((a, b) => b.distance - a.distance);

  for (let i = 0; i < order.length; i++) {
    const car = order[i];

    if (car.stopped) continue;

    // Past the flag a car rolls to a stop rather than braking on the line.
    const coolingDown = car.finished;
    if (!coolingDown && state.time < car.reaction) continue;

    if (!coolingDown) {
      car.pace = clamp(car.pace + car.driftRate * dt, PACE_MIN, PACE_MAX);
    }
    let target = coolingDown ? 0 : speedAt(speedProfile, car.s) * car.pace;

    // Nearest car ahead sharing this lane, not simply the next in the order.
    let blocker: RaceCar | null = null;
    let blockerGap = Infinity;
    for (let j = i - 1; j >= 0 && j >= i - LOOKAHEAD_CARS; j--) {
      const candidate = order[j];
      const candidateGap = candidate.distance - car.distance - CAR_LENGTH_M;
      if (candidateGap > LOOKAHEAD_M) break;
      if (Math.abs(candidate.lateral - car.lateral) >= SIDE_CLEARANCE_M) continue;
      if (candidateGap < blockerGap) {
        blocker = candidate;
        blockerGap = candidateGap;
      }
    }

    let blocked = false;
    if (blocker) {
      // The gap needed to shed the closing speed.
      const closingSpeed = Math.max(0, car.speed - blocker.speed);
      const closingDistance =
        (closingSpeed * closingSpeed) /
        (2 * BRAKING_G * G * CLOSING_BRAKE_MARGIN);
      const desiredGap = MIN_GAP_M + car.speed * HEADWAY_S + closingDistance;
      if (blockerGap < desiredGap) {
        blocked = true;
        // Slowing happens whether or not there is room beside.
        const closeness = clamp(blockerGap / Math.max(desiredGap, 0.001), 0, 1);
        target = Math.min(target, blocker.speed * closeness);

        const room = sideRoom(car, blocker, order, halfWidthAtS);
        if (room !== 0) {
          const bound = Math.max(0, halfWidthAtS(car.s) - CAR_WIDTH_M / 2 - 0.5);
          const drift = lateralStep(car.speed, dt);
          const moved = clamp(car.lateral + room * drift, -bound, bound);
          if (!alongsideOccupied(car, moved, order)) car.lateral = moved;
        }
      }
    }

    // Back to the racing line whenever nothing is in the way — which is also how cars merge off the grid.
    const lineOffset = racingLineOffsetAt(racingLine, car.s);
    if (!blocked) {
      const drift = lateralStep(car.speed, dt);
      const delta = clamp(lineOffset - car.lateral, -drift, drift);
      if (!alongsideOccupied(car, car.lateral + delta, order)) {
        car.lateral += delta;
      }
    }

    // Gentle deceleration is for the slowing-down lap alone.
    const decel = coolingDown && !blocked ? COOLDOWN_G : BRAKING_G;
    const accelLimit = (target > car.speed ? ACCEL_G : decel) * G * dt;
    car.speed += clamp(target - car.speed, -accelLimit, accelLimit);
    if (car.speed < 0) car.speed = 0;
    if (coolingDown && car.speed < 0.5) {
      car.speed = 0;
      car.stopped = true;
    }

    advance(car, dt, lapLengthMeters, lapTarget, state);
  }

  // Fixed spacing in simulated time, so a race timed at 1x and at 16x reads identically.
  for (const car of state.cars) {
    if (state.time < car.trace.nextAt) continue;
    pushTrace(car.trace, car.distance, state.time);
    car.trace.nextAt =
      state.time - car.trace.nextAt > TRACE_INTERVAL_S
        ? state.time + TRACE_INTERVAL_S
        : car.trace.nextAt + TRACE_INTERVAL_S;
  }

  state.complete = state.cars.every((car) => car.stopped);
}

function advance(
  car: RaceCar,
  dt: number,
  lapLengthMeters: number,
  lapTarget: number,
  state: RaceSimState,
): void {
  if (car.speed <= 0) return;
  const step = car.speed * dt;
  car.distance += step;
  car.s = wrap01(car.s + step / lapLengthMeters);

  // Distance is measured from the line, so a full lap length is one crossing.
  while (!car.finished && car.distance >= (car.laps + 1) * lapLengthMeters) {
    car.laps += 1;

    // Lap 1 includes the launch from the box, as the sport times it.
    const lapTime = state.time - car.lapStartTime;
    car.lapStartTime = state.time;
    if (car.bestLap == null || lapTime < car.bestLap) car.bestLap = lapTime;
    if (state.fastestLap == null || lapTime < state.fastestLap.time) {
      state.fastestLap = { index: car.index, time: lapTime };
    }

    // The leader is stepped first, so a lapped car crossing in the same step already sees the flag.
    if (car.laps >= lapTarget) state.flagged = true;
    if (state.flagged) {
      car.finished = true;
      car.finishTime = state.time;
    }
  }
}

/** Which side has room to pull alongside, or 0 for neither. */
function sideRoom(
  car: RaceCar,
  ahead: RaceCar,
  order: RaceCar[],
  halfWidthAtS: (s: number) => number,
): number {
  const bound = Math.max(0, halfWidthAtS(car.s) - CAR_WIDTH_M / 2 - 0.5);
  if (bound <= 0) return 0;

  for (const side of [1, -1]) {
    const candidate = clamp(
      car.lateral + side * SIDE_CLEARANCE_M,
      -bound,
      bound,
    );
    // Clamped back onto itself: the edge of the track is there.
    if (Math.abs(candidate - car.lateral) < SIDE_CLEARANCE_M * 0.5) continue;
    if (Math.abs(candidate - ahead.lateral) < SIDE_CLEARANCE_M) continue;
    if (alongsideOccupied(car, candidate, order, ahead)) continue;
    return side;
  }
  return 0;
}

/** Is another car already in the space this one wants to move into? */
function alongsideOccupied(
  car: RaceCar,
  lateral: number,
  order: RaceCar[],
  ignore?: RaceCar,
): boolean {
  for (const other of order) {
    if (other === car || other === ignore) continue;
    if (Math.abs(other.distance - car.distance) > CAR_LENGTH_M * 1.5) continue;
    if (Math.abs(other.lateral - lateral) < SIDE_CLEARANCE_M) return true;
  }
  return false;
}

/** How far sideways a car may move this step, given how fast it is going. */
function lateralStep(speed: number, dt: number): number {
  return Math.min(LATERAL_RATE_MS, speed * MAX_LATERAL_SLOPE) * dt;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function wrap01(s: number): number {
  const r = s % 1;
  return r < 0 ? r + 1 : r;
}

/** The pose to draw, `alpha` of the way from the previous step to the current one. */
export function interpolateCarPose(
  car: RaceCar,
  alpha: number,
): { s: number; lateral: number } {
  let ds = car.s - car.prevS;
  // The seam: a car crossing s=1 has prevS near one and s near zero.
  if (ds < -0.5) ds += 1;
  else if (ds > 0.5) ds -= 1;
  return {
    s: wrap01(car.prevS + ds * alpha),
    lateral: car.prevLateral + (car.lateral - car.prevLateral) * alpha,
  };
}

/** The field in running order, with the gaps a timing tower shows. */
export interface RaceStanding {
  /** Index into the caller's running order. */
  index: number;
  place: number;
  /** Seconds behind the leader, or behind the car ahead. */
  gapToLeader: number;
  gapToAhead: number;
  /** Whole laps behind the leader. When > 0 the tower shows laps, not time. */
  lapsDown: number;
  laps: number;
  speedKmh: number;
  bestLap: number | null;
  finished: boolean;
}

/** How far `car` is behind `ahead`, in seconds: how long ago `ahead` stood where `car` stands now. */
function gapSeconds(state: RaceSimState, car: RaceCar, ahead: RaceCar): number {
  if (ahead === car) return 0;
  const when = timeAtDistance(ahead.trace, car.distance);
  if (when != null) return Math.max(0, state.time - when);
  return (ahead.distance - car.distance) / Math.max(car.speed, 1);
}

export function raceStandings(
  state: RaceSimState,
  lapLengthMeters: number,
): RaceStanding[] {
  const order = state.cars.slice().sort((a, b) => b.distance - a.distance);
  const leader = order[0];
  return order.map((car, i) => {
    const ahead = i > 0 ? order[i - 1] : car;
    // Finished cars have stopped: the frozen finishing gap is the result.
    const gapToLeader =
      car.finished && leader.finished && car.finishTime != null && leader.finishTime != null
        ? car.finishTime - leader.finishTime
        : gapSeconds(state, car, leader);
    const gapToAhead =
      car.finished && ahead.finished && car.finishTime != null && ahead.finishTime != null
        ? car.finishTime - ahead.finishTime
        : gapSeconds(state, car, ahead);
    return {
      index: car.index,
      place: i + 1,
      gapToLeader,
      gapToAhead,
      lapsDown: Math.max(
        0,
        Math.floor((leader.distance - car.distance) / lapLengthMeters),
      ),
      laps: car.laps,
      speedKmh: car.speed * 3.6,
      bestLap: car.bestLap,
      finished: car.finished,
    };
  });
}
