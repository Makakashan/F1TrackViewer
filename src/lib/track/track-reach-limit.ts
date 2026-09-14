import * as THREE from "three";
import { halfWidthAt, type HalfWidth } from "@/lib/track/track-geometry";

/**
 * How far from the centreline anything may reach on each side: on the inside of
 * a bend, before its edge folds back over itself, and toward another leg of the
 * lap, before it lands on that leg. The ribbon, the apron, the kerbs and the
 * barrier all read this one answer.
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

  // Facing another leg, each side gets half the gap.
  const legs = sampleLegGaps(curve, n);
  for (let i = 0; i < n; i++) {
    plus[i] = Math.min(plus[i], legs.plus[i] / 2);
    minus[i] = Math.min(minus[i], legs.minus[i] / 2);
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

/** The half width a ribbon can have without folding or landing on another leg; untouched elsewhere. */
export function limitHalfWidth(halfWidth: HalfWidth, limit: ReachLimit): HalfWidth {
  return (s: number) => {
    const requested = halfWidthAt(halfWidth, s);
    const room =
      Math.min(reachLimitAt(limit, s, 1), reachLimitAt(limit, s, -1)) - RIBBON_MARGIN_M;
    return Math.min(requested, Math.max(room, MIN_HALF_WIDTH_M));
  };
}

/** Closer than this in plan, two legs of a lap cross on a bridge rather than share a verge. */
const CROSSING_M = 3;
/** Another leg further away than this needs no limit. */
const LEG_SEARCH_M = 30;
/** Nearer than this along the lap, a point belongs to the same stretch of road. */
const LEG_MIN_ALONG_M = 30;
/** And it must be this many times further along the lap than in plan, or it is the same bend. */
const LEG_ALONG_RATIO = 2;

export interface LegGaps {
  samples: number;
  /** Distance in plan to another leg of the lap on the +side at sample i; Infinity where there is none. */
  plus: Float32Array;
  minus: Float32Array;
}

/** Where another leg of the lap runs alongside, and on which side. Crossings are left out. */
export function sampleLegGaps(curve: THREE.CatmullRomCurve3, samples: number): LegGaps {
  const n = samples;
  const plus = new Float32Array(n).fill(Infinity);
  const minus = new Float32Array(n).fill(Infinity);
  const total = curve.getLength();
  if (n < 8 || !(total > 0)) return { samples: n, plus, minus };

  const ds = total / n;
  const up = new THREE.Vector3(0, 1, 0);
  const points: THREE.Vector3[] = [];
  const sides: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    points.push(curve.getPointAt(i / n));
    sides.push(new THREE.Vector3().crossVectors(curve.getTangentAt(i / n), up).normalize());
  }

  const nearest = new Float32Array(n).fill(Infinity);
  const partner = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const along = Math.min(Math.abs(i - j), n - Math.abs(i - j)) * ds;
      if (along < LEG_MIN_ALONG_M) continue;
      const d = Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
      if (d > LEG_SEARCH_M || along < LEG_ALONG_RATIO * d || d >= nearest[i]) continue;
      nearest[i] = d;
      partner[i] = j;
    }
  }

  // A run alongside another leg that touches it somewhere is a crossing, and a bridge needs no pinch.
  for (let i = 0; i < n; ) {
    if (!Number.isFinite(nearest[i])) {
      i++;
      continue;
    }
    let end = i;
    let closest = Infinity;
    while (end < n && Number.isFinite(nearest[end])) closest = Math.min(closest, nearest[end++]);
    if (closest >= CROSSING_M) {
      for (let k = i; k < end; k++) {
        const other = points[partner[k]];
        const facing = (other.x - points[k].x) * sides[k].x + (other.z - points[k].z) * sides[k].z;
        (facing > 0 ? plus : minus)[k] = nearest[k];
      }
    }
    i = end;
  }
  return { samples: n, plus, minus };
}
