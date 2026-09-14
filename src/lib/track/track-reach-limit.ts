import * as THREE from "three";
import { halfWidthAt, type HalfWidth } from "@/lib/track/track-geometry";

/**
 * How far from the centreline anything may reach on the inside of a bend before
 * its edge folds back over itself. The ribbon, the apron, the kerbs and the
 * barrier all read this one answer, so a hairpin pinches them together.
 */

/** Share of the local radius an edge may use; the rest keeps its line from turning back. */
const RADIUS_SHARE = 0.85;
/** A limit holds this far either side, so an edge eases into a pinch instead of kinking. */
const HOLD_M = 10;
/** Kept between the ribbon's edge and the limit, so a kerb and a barrier still fit. */
export const RIBBON_MARGIN_M = 1.2;
/** The ribbon is never pinched narrower than this half width. */
const MIN_HALF_WIDTH_M = 2.5;

export interface ReachLimit {
  samples: number;
  /** Furthest reach on the +side at sample i, in metres; Infinity where nothing limits it. */
  plus: Float32Array;
  minus: Float32Array;
}

/** Tightest of `values` within `span` samples either side, round the closed lap. */
function holdMinimum(values: Float32Array, span: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let min = Infinity;
    for (let k = -span; k <= span; k++) min = Math.min(min, values[(i + k + n) % n]);
    out[i] = min;
  }
  return out;
}

export function sampleReachLimit(
  curve: THREE.CatmullRomCurve3,
  samples: number,
): ReachLimit {
  const n = samples;
  const plus = new Float32Array(n).fill(Infinity);
  const minus = new Float32Array(n).fill(Infinity);
  const total = curve.getLength();
  if (n < 8 || !(total > 0)) return { samples: n, plus, minus };

  const ds = total / n;
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) tangents.push(curve.getTangentAt(i / n));

  // Unsmoothed on purpose: a smoothed radius is wider than the bend the mesh actually turns.
  for (let i = 0; i < n; i++) {
    const a = tangents[i];
    const b = tangents[(i + 1) % n];
    const turn = Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
    if (Math.abs(turn) < 1e-9) continue;
    const reach = (ds / Math.abs(turn)) * RADIUS_SHARE;
    const side = turn > 0 ? plus : minus;
    side[i] = Math.min(side[i], reach);
    side[(i + 1) % n] = Math.min(side[(i + 1) % n], reach);
  }

  const span = Math.max(1, Math.round(HOLD_M / ds));
  return { samples: n, plus: holdMinimum(plus, span), minus: holdMinimum(minus, span) };
}

/** The limit at a normalized arc position, taking the tighter of the two samples around it. */
export function reachLimitAt(limit: ReachLimit, s: number, sign: number): number {
  const values = sign > 0 ? limit.plus : limit.minus;
  const n = values.length;
  if (n === 0) return Infinity;
  const i = Math.floor((((s % 1) + 1) % 1) * n);
  return Math.min(values[i % n], values[(i + 1) % n]);
}

/** The half width a ribbon can have without folding: pinched through a hairpin, untouched elsewhere. */
export function limitHalfWidth(halfWidth: HalfWidth, limit: ReachLimit): HalfWidth {
  return (s: number) => {
    const requested = halfWidthAt(halfWidth, s);
    const room =
      Math.min(reachLimitAt(limit, s, 1), reachLimitAt(limit, s, -1)) - RIBBON_MARGIN_M;
    return Math.min(requested, Math.max(room, MIN_HALF_WIDTH_M));
  };
}

