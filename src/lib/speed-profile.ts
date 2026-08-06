import * as THREE from "three";
import { sampleCurvature } from "./track-curvature";

/**
 * How fast a car can be at every point of a circuit.
 *
 * The model is the classic three-pass one: a cornering limit from the local
 * radius, then a backward pass that brakes into every corner and a forward
 * pass that accelerates out of it. Everything a lap needs is in the table, so
 * a running car does one array lookup per step instead of integrating.
 *
 * Deliberately not telemetry. A recorded lap is one driver on one day, and
 * twenty cars would need it scaled by an invented factor anyway — at which
 * point the realism it was chosen for is gone, and half the circuits in the
 * app predate telemetry entirely.
 */
export interface SpeedProfile {
  /** Speed limit in m/s at sample i, which sits at s = i / samples. */
  speeds: number[];
  samples: number;
  /** Arc length between samples, in meters. */
  ds: number;
  totalLength: number;
  /** Corner radius in meters at each sample, capped at STRAIGHT_RADIUS_M. */
  radii: number[];
  /** Signed curvature, kept so the racing line can lean the right way. */
  curvature: number[];
}

const G = 9.81;

/**
 * Limits of a modern F1 car, in g.
 *
 * These four numbers are the whole model, so they are worth stating plainly:
 * a 2020s car pulls 4-6 g in medium-speed corners, brakes at 5-6 g, and puts
 * down about 1.5 g on corner exit. The conservative end of each range is used
 * — the numbers have to hold on circuits whose geometry comes from a GeoJSON
 * trace rather than a survey, and an optimistic model produces lap times no
 * real car has ever set.
 *
 * `LATERAL_G` was picked by measurement, not from the range: at 4.0 the ideal
 * lap sits 2% under a real pole lap averaged over the 23 current-calendar
 * circuits, worst case 8% (scripts/audit-lap-times.ts). Higher values make
 * the model quick everywhere, because a traced centerline rounds off the
 * tightest corners and hands the car radius it does not have.
 */
export const LATERAL_G = 4.0;
export const BRAKING_G = 5;
export const ACCEL_G = 1.5;
/** Top speed in m/s (~340 km/h). */
export const MAX_SPEED_MS = 94.4;
/**
 * Slowest a car is ever allowed to be, in m/s (~68 km/h).
 *
 * A GeoJSON trace can kink hard enough to imply a radius no real corner has,
 * usually where two survey points nearly double back. Without a floor one bad
 * vertex stops the whole field dead.
 */
export const MIN_SPEED_MS = 19;
/** Radius above which a sample counts as straight, in meters. */
const STRAIGHT_RADIUS_M = 4000;

export function buildSpeedProfile(
  curve: THREE.CatmullRomCurve3,
  samples: number,
): SpeedProfile | null {
  const profile = sampleCurvature(curve, samples);
  if (!profile) return null;

  const { ds, totalLength, curvature } = profile;
  const n = profile.samples;

  const radii = new Array<number>(n);
  const speeds = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(curvature[i]);
    const radius = k > 1 / STRAIGHT_RADIUS_M ? 1 / k : STRAIGHT_RADIUS_M;
    radii[i] = radius;
    speeds[i] = clampSpeed(Math.sqrt(LATERAL_G * G * radius));
  }

  // Backward pass: a car cannot arrive at a corner faster than it can brake
  // from. Two laps of it, because the limit at the start of the array depends
  // on the end of it — the track is a loop, not a line.
  const brakeStep = 2 * BRAKING_G * G * ds;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = speeds[(i + 1) % n];
      const reachable = Math.sqrt(next * next + brakeStep);
      if (reachable < speeds[i]) speeds[i] = reachable;
    }
  }

  // Forward pass: nor can it leave one faster than it can accelerate to.
  const accelStep = 2 * ACCEL_G * G * ds;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const previous = speeds[(i - 1 + n) % n];
      const reachable = Math.sqrt(previous * previous + accelStep);
      if (reachable < speeds[i]) speeds[i] = reachable;
    }
  }

  return { speeds, samples: n, ds, totalLength, radii, curvature };
}

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return MIN_SPEED_MS;
  return Math.min(MAX_SPEED_MS, Math.max(MIN_SPEED_MS, value));
}

/** Speed limit at normalized arc position s, interpolated between samples. */
export function speedAt(profile: SpeedProfile, s: number): number {
  const { speeds, samples } = profile;
  const x = wrap01(s) * samples;
  const i = Math.floor(x);
  const t = x - i;
  const a = speeds[i % samples];
  const b = speeds[(i + 1) % samples];
  return a + (b - a) * t;
}

/**
 * Time to drive one lap at the profile's own limits, in seconds.
 *
 * The check on the whole model: a number that can be put next to a real lap
 * time without opening a browser.
 */
export function idealLapTime(profile: SpeedProfile): number {
  let time = 0;
  for (let i = 0; i < profile.samples; i++) {
    const a = profile.speeds[i];
    const b = profile.speeds[(i + 1) % profile.samples];
    // Trapezoidal in slowness, which is what integrates to time.
    time += profile.ds * 0.5 * (1 / a + 1 / b);
  }
  return time;
}

export function wrap01(s: number): number {
  const r = s % 1;
  return r < 0 ? r + 1 : r;
}
