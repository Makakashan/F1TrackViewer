import * as THREE from "three";
import { refineArcLengths } from "@/lib/geo-utils";
import { type ApronRoom } from "@/lib/track/track-apron";
import { BARRIER_SETBACK_M } from "@/lib/track/track-barriers";
import { halfWidthAt, type HalfWidth } from "@/lib/track/track-geometry";
import { reachLimitAt, type ReachLimit } from "@/lib/track/track-reach-limit";

/**
 * Hand corrections to a circuit, placed along the lap in the track editor: road
 * width, how far the barrier stands from the road, and kerb width, per side. A
 * point holds its values over a stretch and hands back to the automatic ones over
 * a taper, so an edit never starts with a step.
 */

export const TRACK_OVERRIDES_VERSION = 1;
/** Distance over which a point fades back to the automatic values. */
export const OVERRIDE_TAPER_M = 15;
/** Kept between a pushed-back barrier and the reach limit. */
const REACH_MARGIN_M = 0.5;

export type OverrideKey =
  | "widthM"
  | "smoothM"
  | "barrierPlusM"
  | "barrierMinusM"
  | "kerbPlusM"
  | "kerbMinusM";

export interface TrackOverridePoint {
  id: string;
  /** Normalized arc position of the stretch's middle. */
  s: number;
  /** Length held at full strength, in metres. */
  lengthM: number;
  /** Full road width. */
  widthM?: number;
  /** Length the centreline is averaged over, to take the wobble out of the survey. */
  smoothM?: number;
  /** Road edge to the barrier's face, on the +side and the −side. */
  barrierPlusM?: number;
  barrierMinusM?: number;
  /** Kerb width on each side; 0 takes the kerb away. */
  kerbPlusM?: number;
  kerbMinusM?: number;
}

export interface TrackOverrides {
  version: number;
  circuitId: string;
  points: TrackOverridePoint[];
}

export interface OverrideWeight {
  value: number;
  /** 1 inside the stretch, falling to 0 across the taper. */
  weight: number;
}

export function emptyOverrides(circuitId: string): TrackOverrides {
  return { version: TRACK_OVERRIDES_VERSION, circuitId, points: [] };
}

export function sideKey(kind: "barrier" | "kerb", sign: number): OverrideKey {
  if (kind === "barrier") return sign > 0 ? "barrierPlusM" : "barrierMinusM";
  return sign > 0 ? "kerbPlusM" : "kerbMinusM";
}

/** The nearest point that sets `key` at `s`, with how strongly it holds there. */
export function overrideAt(
  overrides: TrackOverrides | null | undefined,
  key: OverrideKey,
  s: number,
  lapLengthM: number,
): OverrideWeight | null {
  if (!overrides) return null;
  let best: OverrideWeight | null = null;
  for (const point of overrides.points) {
    const value = point[key];
    if (value === undefined) continue;
    const apart = Math.abs((((s - point.s) % 1) + 1) % 1);
    const past = Math.min(apart, 1 - apart) * lapLengthM - point.lengthM / 2;
    const weight = past <= 0 ? 1 : Math.max(0, 1 - past / OVERRIDE_TAPER_M);
    if (weight > 0 && (!best || weight > best.weight)) best = { value, weight };
  }
  return best;
}

export function blendOverride(auto: number, override: OverrideWeight | null): number {
  return override ? auto + (override.value - auto) * override.weight : auto;
}

function sets(overrides: TrackOverrides | null | undefined, keys: OverrideKey[]): boolean {
  return !!overrides?.points.some((point) => keys.some((key) => point[key] !== undefined));
}

/** The road's half width with the editor's widths laid over it. */
export function withWidthOverrides(
  halfWidth: HalfWidth,
  overrides: TrackOverrides | null | undefined,
  lapLengthM: number,
): HalfWidth {
  if (!sets(overrides, ["widthM"])) return halfWidth;
  return (s: number) => {
    const override = overrideAt(overrides, "widthM", s, lapLengthM);
    const half = override ? { value: override.value / 2, weight: override.weight } : null;
    return blendOverride(halfWidthAt(halfWidth, s), half);
  };
}

/**
 * Moves the paving's edge to where the editor put the barrier; the barrier stands
 * on that edge, so it moves with it. Still bounded by the reach limit.
 */
export function withBarrierOverrides(
  room: ApronRoom,
  overrides: TrackOverrides | null | undefined,
  lapLengthM: number,
  halfWidth: HalfWidth,
  reach: ReachLimit | null,
): ApronRoom {
  if (!sets(overrides, ["barrierPlusM", "barrierMinusM"])) return room;
  const n = room.plus.length;
  const plus = Float32Array.from(room.plus);
  const minus = Float32Array.from(room.minus);
  for (let i = 0; i < n; i++) {
    const s = i / n;
    for (const sign of [1, -1]) {
      const override = overrideAt(overrides, sideKey("barrier", sign), s, lapLengthM);
      if (!override) continue;
      const target = sign > 0 ? plus : minus;
      const paving = { value: Math.max(0, override.value - BARRIER_SETBACK_M), weight: override.weight };
      let width = blendOverride(target[i] * room.widthMeters, paving);
      if (reach) {
        const fits = reachLimitAt(reach, s, sign) - halfWidthAt(halfWidth, s) - REACH_MARGIN_M;
        width = Math.min(width, Math.max(0, fits));
      }
      target[i] = width / room.widthMeters;
    }
  }
  return { widthMeters: room.widthMeters, plus, minus };
}

/**
 * Averages the centreline's own points where the editor asked for it. The survey's
 * wobble shows as kinked edges on a straight, and every edge is built off this line,
 * so smoothing it is the only place the kink can be taken out. Points outside the
 * edited stretch are handed back untouched: rebuilding the whole line from fresh
 * samples moved it by up to 6 cm everywhere, which is more than a kerb's tolerance.
 */
export function withCentrelineOverrides(
  curve: THREE.CatmullRomCurve3,
  overrides: TrackOverrides | null | undefined,
): THREE.CatmullRomCurve3 {
  if (!sets(overrides, ["smoothM"])) return curve;
  const points = curve.points;
  const n = points.length;
  if (n < 8) return curve;

  // The survey's points are not evenly spaced, so each one's place along the lap
  // is measured rather than taken from its index.
  const along: number[] = [];
  let lapLengthM = 0;
  for (let i = 0; i < n; i++) {
    along.push(lapLengthM);
    lapLengthM += points[i].distanceTo(points[(i + 1) % n]);
  }
  if (!(lapLengthM > 0)) return curve;

  const mean = new THREE.Vector3();
  let touched = false;
  const smoothed = points.map((point, i) => {
    const override = overrideAt(overrides, "smoothM", along[i] / lapLengthM, lapLengthM);
    if (!override || override.value <= 0) return point.clone();
    // Every point within half the window, each way round the lap.
    const reach = override.value / 2;
    mean.copy(point);
    let count = 1;
    for (const step of [1, -1]) {
      for (let k = 1; k < n; k++) {
        const j = (i + step * k + n * 2) % n;
        const apart = Math.abs(along[j] - along[i]);
        if (Math.min(apart, lapLengthM - apart) > reach) break;
        mean.add(points[j]);
        count++;
      }
    }
    if (count < 3) {
      // A window narrower than the survey's own spacing still has to do something.
      mean.copy(point).add(points[(i + 1) % n]).add(points[(i - 1 + n) % n]);
      count = 3;
    }
    mean.divideScalar(count);
    touched = true;
    return point.clone().lerp(mean, override.weight);
  });
  if (!touched) return curve;

  const next = new THREE.CatmullRomCurve3(smoothed, true, "centripetal", 0.5);
  refineArcLengths(next);
  return next;
}

/** The editor's kerb width at `s` on one side, for the kerb builder to blend in. */
export function kerbOverrides(
  overrides: TrackOverrides | null | undefined,
  lapLengthM: number,
): ((s: number, sign: number) => OverrideWeight | null) | undefined {
  if (!sets(overrides, ["kerbPlusM", "kerbMinusM"])) return undefined;
  return (s, sign) => overrideAt(overrides, sideKey("kerb", sign), s, lapLengthM);
}
