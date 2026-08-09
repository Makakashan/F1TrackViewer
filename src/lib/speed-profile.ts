import * as THREE from "three";
import { sampleCurvature } from "./track-curvature";

/**
 * How fast a car can be at every point of a circuit: a cornering limit from
 * the local radius, then a backward pass that brakes into every corner and a
 * forward pass that accelerates out of it.
 *
 * Not telemetry, on purpose — a recorded lap is one driver on one day, twenty
 * cars would need it scaled by an invented factor, and half the circuits here
 * predate telemetry entirely.
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
 * Limits of a modern F1 car, in g — the whole model. Conservative ends of the
 * real ranges, since the geometry is a GeoJSON trace rather than a survey.
 *
 * `LATERAL_G` came from measurement: at 4.0 the ideal lap sits 2% under a real
 * pole lap averaged over the 23 current-calendar circuits, worst case 8%
 * (scripts/audit-lap-times.ts).
 */
export const LATERAL_G = 4.0;
export const BRAKING_G = 5;
export const ACCEL_G = 1.5;
/** Top speed in m/s (~340 km/h). */
export const MAX_SPEED_MS = 94.4;
/**
 * Slowest a car is ever allowed to be, in m/s (~68 km/h). A traced centerline
 * can kink hard enough that one bad vertex stops the whole field dead.
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

  // A car cannot arrive at a corner faster than it can brake from. Two laps of
  // it, because the start of the array depends on the end of it.
  const brakeStep = 2 * BRAKING_G * G * ds;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = speeds[(i + 1) % n];
      const reachable = Math.sqrt(next * next + brakeStep);
      if (reachable < speeds[i]) speeds[i] = reachable;
    }
  }

  // Nor leave one faster than it can accelerate to.
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
 * Time to drive one lap at the profile's own limits — the check on the whole
 * model, comparable to a real lap time without opening a browser.
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
