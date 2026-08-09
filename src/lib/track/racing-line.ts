import * as THREE from "three";
import { sampleCurvature } from "@/lib/track/track-curvature";
import { halfWidthAt, type HalfWidth } from "@/lib/track/track-geometry";

/** The line the cars drive: lateral offsets from the centerline, one per sample. */
export interface RacingLine {
  /** Lateral offset in meters at sample i; positive is toward `across`. */
  offsets: number[];
  samples: number;
  totalLength: number;
}

/** How much of the available half width the line may use. */
const USABLE_FRACTION = 0.55;
/** Kept clear between the car's own edge and the track edge, in meters. */
const EDGE_MARGIN_M = 0.6;
/** Half the car's width, in meters. */
const CAR_HALF_WIDTH_M = 1;
/** Curvature at which the line commits to the full offset, in 1/m. */
const FULL_OFFSET_CURVATURE = 1 / 120;
/** Distance over which the line eases out and back, in meters. */
const EASE_LENGTH_M = 70;

export function buildRacingLine(
  curve: THREE.CatmullRomCurve3,
  samples: number,
  halfWidth: HalfWidth,
): RacingLine | null {
  // Wider smoothing than the kerbs use: the line responds to a corner as a whole.
  const profile = sampleCurvature(curve, samples, 12);
  if (!profile) return null;

  const { ds, totalLength, curvature } = profile;
  const n = profile.samples;

  const target = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const k = curvature[i];
    const hw = halfWidthAt(halfWidth, i / n);
    const room = Math.max(
      0,
      hw * USABLE_FRACTION - CAR_HALF_WIDTH_M - EDGE_MARGIN_M,
    );
    const amount = Math.min(1, Math.abs(k) / FULL_OFFSET_CURVATURE);
    // `across` is tangent × up, so a left-hand turn apexes on the -across side.
    target[i] = -Math.sign(k) * amount * room;
  }

  // Both directions, or the line drifts the way the single pass was run.
  const alpha = 1 - Math.exp(-ds / EASE_LENGTH_M);
  const offsets = target.slice();
  for (let pass = 0; pass < 2; pass++) {
    let value = offsets[n - 1];
    for (let i = 0; i < n; i++) {
      value += (offsets[i] - value) * alpha;
      offsets[i] = value;
    }
    value = offsets[0];
    for (let i = n - 1; i >= 0; i--) {
      value += (offsets[i] - value) * alpha;
      offsets[i] = value;
    }
  }

  return { offsets, samples: n, totalLength };
}

/** Lateral offset at normalized arc position s, interpolated. */
export function racingLineOffsetAt(line: RacingLine, s: number): number {
  const { offsets, samples } = line;
  const x = wrap01(s) * samples;
  const i = Math.floor(x);
  const t = x - i;
  const a = offsets[i % samples];
  const b = offsets[(i + 1) % samples];
  return a + (b - a) * t;
}

function wrap01(s: number): number {
  const r = s % 1;
  return r < 0 ? r + 1 : r;
}
