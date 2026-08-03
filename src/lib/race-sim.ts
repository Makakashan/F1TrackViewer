import { speedAt, ACCEL_G, BRAKING_G, type SpeedProfile } from "./speed-profile";
import { racingLineOffsetAt, type RacingLine } from "./racing-line";
import { seedFrom, randomFrom } from "./race-session";
import { gridSetbackMeters, type GridSlot } from "./start-grid";

/**
 * Twenty cars driving a lap.
 *
 * Pure and deterministic: the same seed and the same sequence of steps always
 * produce the same race. That is why the stepper takes a fixed `dt` from its
 * caller instead of a frame delta — a dropped frame must not change who wins,
 * and a phone must not race differently from a desktop.
 *
 * The model is longitudinal with a lateral escape. Cars follow the racing line
 * at their own pace; a car that catches another either finds room beside it
 * and goes by, or queues up behind it. There is no wheel-to-wheel fight and no
 * contact — a car never occupies the same space as another, it just runs out
 * of room and lifts.
 */

const G = 9.81;
/** Car body, in meters. */
const CAR_LENGTH_M = 5.6;
const CAR_WIDTH_M = 2;
/** Standing gap a car keeps to the one ahead, in meters. */
const MIN_GAP_M = 6;
/** Extra gap per unit of speed — a time headway, in seconds. */
const HEADWAY_S = 0.35;
/**
 * Share of the braking limit a car plans to use when closing on another.
 *
 * Below 1 so the gap opens before the physics runs out: planning to brake at
 * exactly the limit leaves nothing for the case where the car ahead is also
 * braking, which is the case every time they arrive at a corner together.
 */
const CLOSING_BRAKE_MARGIN = 0.45;
/** Sideways travel rate when moving off the line, in meters per second. */
const LATERAL_RATE_MS = 2.4;
/**
 * Cap on sideways travel as a share of forward travel — roughly the tangent
 * of the steering angle the move implies. Without it a car pulling away from
 * the grid drifts to the racing line faster than it drives forward, which
 * reads as the car sliding sideways off its box.
 */
const MAX_LATERAL_SLOPE = 0.2;
/** Clear space a car needs beside another before it will pull alongside. */
const SIDE_CLEARANCE_M = CAR_WIDTH_M + 0.6;
/**
 * How far back a car looks for the one ahead, in meters. Anything further
 * cannot affect this step, and skipping it keeps the pass over the field
 * cheap.
 */
const LOOKAHEAD_M = 120;
/**
 * How many cars up the order to look. Five covers a queue into a slow corner;
 * anything ahead of that is separated by cars that are themselves blocking.
 */
const LOOKAHEAD_CARS = 5;
/** Reaction to the lights going out, in seconds. */
const REACTION_MIN_S = 0.2;
const REACTION_MAX_S = 0.5;
/** Spread of per-car pace, as a fraction of the speed limit. */
const PACE_SPREAD = 0.015;
/**
 * How far a car's pace may wander over a race distance, as a fraction.
 *
 * The stand-in for everything a race actually varies — tyres, fuel, a driver
 * losing their rhythm. Without it the order settles by lap three and the
 * remaining distance is a procession; with it, who is quick changes slowly
 * across the afternoon. Deterministic like everything else: drawn from the
 * seed, applied linearly.
 */
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
  /**
   * Position along the track measured from the start line, in meters.
   * Negative on the grid, since every box is behind the line.
   */
  distance: number;
  /** Meters per second. */
  speed: number;
  /** Lateral offset from the centerline, in meters. */
  lateral: number;
  /**
   * Where the car was before the most recent step. The renderer draws between
   * the two — a 30 Hz simulation shown raw on a 144 Hz screen is a slideshow.
   */
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
}

export interface RaceSimState {
  cars: RaceCar[];
  /** Seconds since the lights went out. */
  time: number;
  /**
   * True once the leader has covered the race distance. From then on every
   * car finishes at its next line crossing, however many laps it has done —
   * the flag falls once, not once per car.
   */
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
  // Drift is budgeted over the whole race, so a sprint and a grand prix see
  // the same total wander rather than the same per-second rate.
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
    // Pace is drawn per car rather than derived from grid position: a grid is
    // an order, not a ranking of speed, and a field where P20 is always the
    // slowest car never changes shape.
    pace: 1 + (random() * 2 - 1) * PACE_SPREAD,
    driftRate: ((random() * 2 - 1) * PACE_DRIFT_SPREAD) / Math.max(raceSeconds, 1),
    reaction: REACTION_MIN_S + random() * (REACTION_MAX_S - REACTION_MIN_S),
    laps: 0,
    lapStartTime: 0,
    bestLap: null,
    finishTime: null,
    finished: false,
    stopped: false,
  }));
  return { cars, time: 0, flagged: false, fastestLap: null, complete: false };
}

/**
 * Advance the race by exactly `dt` seconds.
 *
 * Mutates in place — this runs tens of times a second on twenty cars, and
 * allocating a new field each step is the one thing that would make it show
 * up in a profile.
 */
export function stepRace(
  state: RaceSimState,
  setup: RaceSimSetup,
  dt: number,
): void {
  if (state.complete) return;
  state.time += dt;

  // Snapshot before anything moves: after the last step of a frame these are
  // the "from" of the render interpolation.
  for (const car of state.cars) {
    car.prevS = car.s;
    car.prevLateral = car.lateral;
  }

  const { speedProfile, racingLine, lapLengthMeters, halfWidthAtS } = setup;
  const lapTarget = setup.laps;

  // Leader first. Everything below asks "what is directly in front of me",
  // which is only answerable once the field is in track order.
  const order = state.cars.slice().sort((a, b) => b.distance - a.distance);

  for (let i = 0; i < order.length; i++) {
    const car = order[i];

    if (car.stopped) continue;

    // Past the flag a car rolls to a stop rather than braking on the line:
    // twenty cars stopping dead where they cross would pile into each other,
    // and a slowing-down lap is what actually happens. It still watches the
    // car in front — the queue does not stop being a queue after the flag.
    const coolingDown = car.finished;
    if (!coolingDown && state.time < car.reaction) continue;

    if (!coolingDown) {
      car.pace = clamp(car.pace + car.driftRate * dt, PACE_MIN, PACE_MAX);
    }
    let target = coolingDown ? 0 : speedAt(speedProfile, car.s) * car.pace;

    // The blocker is the nearest car ahead that shares this car's lane, not
    // simply the next one in the running order: a car already passed sits
    // beside, not in front, and braking for it would undo the pass.
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
      // The gap that matters is the one needed to shed the *closing* speed.
      // A time headway alone is a following distance, not a braking one: at
      // 300 km/h behind a car doing 80, thirty-five meters is a third of what
      // it takes to avoid arriving inside it.
      const closingSpeed = Math.max(0, car.speed - blocker.speed);
      const closingDistance =
        (closingSpeed * closingSpeed) /
        (2 * BRAKING_G * G * CLOSING_BRAKE_MARGIN);
      const desiredGap = MIN_GAP_M + car.speed * HEADWAY_S + closingDistance;
      if (blockerGap < desiredGap) {
        blocked = true;
        // Slowing down happens whether or not there is room beside. Moving
        // over takes about a second; closing on the car ahead takes rather
        // less than that, so a car that only steers ends up inside the one it
        // meant to pass.
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

    // Return to the racing line whenever nothing is in the way. Cars merge
    // off the grid by exactly this rule — a grid slot is just a lateral
    // offset the line does not have. The neighbour check matters as much here
    // as when passing: two cars side by side are both drawn to the same line,
    // and without it they converge into each other on the way back to it.
    const lineOffset = racingLineOffsetAt(racingLine, car.s);
    if (!blocked) {
      const drift = lateralStep(car.speed, dt);
      const delta = clamp(lineOffset - car.lateral, -drift, drift);
      if (!alongsideOccupied(car, car.lateral + delta, order)) {
        car.lateral += delta;
      }
    }

    // Gentle deceleration belongs to the slowing-down lap alone; a car
    // closing on traffic brakes properly whether or not it has finished.
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

  // Distance is measured from the line, so a car that has covered a full lap
  // length has crossed it once — the crossing seconds after the lights go out
  // happens at distance zero and correctly counts for nothing.
  while (!car.finished && car.distance >= (car.laps + 1) * lapLengthMeters) {
    car.laps += 1;

    // Lap 1 includes the launch from the box; that is how the sport times it
    // too. Cooling-down travel never sets a lap time — the loop stops at the
    // flag below.
    const lapTime = state.time - car.lapStartTime;
    car.lapStartTime = state.time;
    if (car.bestLap == null || lapTime < car.bestLap) car.bestLap = lapTime;
    if (state.fastestLap == null || lapTime < state.fastestLap.time) {
      state.fastestLap = { index: car.index, time: lapTime };
    }

    // The flag falls when the leader completes the distance; everyone else
    // finishes at their next crossing, on whatever lap they are on. The
    // leader is processed first each step, so a lapped car crossing in the
    // same step already sees the flag.
    if (car.laps >= lapTarget) state.flagged = true;
    if (state.flagged) {
      car.finished = true;
      car.finishTime = state.time;
    }
  }
}

/**
 * Which side has room to pull alongside, or 0 for neither.
 *
 * Returns a signed direction rather than a boolean because the answer is
 * "which way", and the caller has no better information to pick with.
 */
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

/**
 * The pose to draw, `alpha` of the way from the previous step to the current
 * one. `alpha` is the unconsumed remainder of the frame's time over the step
 * size — exactly how far into the next step the screen already is.
 */
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

/**
 * The field in running order, with the gaps a timing tower shows.
 *
 * Computed on demand rather than kept in the state: it is only needed at the
 * rate the HUD refreshes, which is a fraction of the simulation rate.
 */
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

export function raceStandings(
  state: RaceSimState,
  lapLengthMeters: number,
): RaceStanding[] {
  const order = state.cars.slice().sort((a, b) => b.distance - a.distance);
  const leader = order[0];
  return order.map((car, i) => {
    const ahead = i > 0 ? order[i - 1] : car;
    // Finished cars have stopped moving, so a distance-over-speed gap is
    // meaningless — the frozen finishing gap is the result.
    const gapToLeader =
      car.finished && leader.finished && car.finishTime != null && leader.finishTime != null
        ? car.finishTime - leader.finishTime
        : (leader.distance - car.distance) / Math.max(car.speed, 1);
    const gapToAhead =
      car.finished && ahead.finished && car.finishTime != null && ahead.finishTime != null
        ? car.finishTime - ahead.finishTime
        : (ahead.distance - car.distance) / Math.max(car.speed, 1);
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
