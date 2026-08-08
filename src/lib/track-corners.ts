/**
 * Where a circuit's corners are, derived from the centerline.
 *
 * Kerbs asked this first and the apron asks it now: a kerb belongs to a corner,
 * and so does the run-off it lies on. Two copies of "is this a corner" drift —
 * the apron would pave a bend the kerb declined to stripe, or stop short of one
 * it did — so both read the same answer from here.
 */

/** Radius below which a sample counts as entering a corner. */
export const CORNER_ENTER_RADIUS_M = 170;

/**
 * Radius a corner already in progress must open past before it ends.
 *
 * Well above the entry threshold on purpose — see the hysteresis note on
 * `resolveCornerSides`.
 */
export const CORNER_EXIT_RADIUS_M = 420;

/** A run shorter than this is curvature noise, not a corner. */
export const CORNER_MIN_RUN_M = 12;

export interface CornerRun {
  start: number;
  count: number;
  /** Which side of the centerline is the inside of this corner. */
  sign: 1 | -1;
}

/**
 * Mark which side of the track is the inside of a corner, 0 on a straight.
 *
 * Uses hysteresis rather than one threshold. Real corners are not
 * constant-radius: through a complex like Becketts the curvature repeatedly
 * dips under any single threshold, which chopped one corner into several runs
 * that each tapered to nothing and back — the kerb pulsed. Entering a corner
 * takes `enter` curvature, but leaving it takes a much gentler `exit`, so the
 * corner stays on through the dips and only ends where the track really
 * straightens.
 */
export function resolveCornerSides(
  curvature: number[],
  enter: number,
  exit: number,
): number[] {
  const n = curvature.length;
  const sides = new Array<number>(n).fill(0);

  // Start where the track is straightest, so the walk never begins mid-corner
  // and carries a stale state around the wrap.
  let origin = 0;
  for (let i = 1; i < n; i++) {
    if (Math.abs(curvature[i]) < Math.abs(curvature[origin])) origin = i;
  }

  let active = 0;
  for (let step = 0; step < n; step++) {
    const i = (origin + step) % n;
    const magnitude = Math.abs(curvature[i]);
    const sign = Math.sign(curvature[i]);

    if (active === 0) {
      if (magnitude > enter) active = sign;
    } else if (sign !== active && magnitude > enter) {
      // A genuine change of direction: the next corner starts here.
      active = sign;
    } else if (magnitude < exit) {
      active = 0;
    }

    sides[i] = active;
  }

  return sides;
}

/**
 * Contiguous index ranges sharing the same non-zero value in `state`, over a
 * circular array. Runs are split where the turn direction flips, so an S-bend
 * gets one corner per direction instead of a single range stuck on one edge
 * through both halves. A run straddling index 0 is returned as one range whose
 * start is near the end of the array — callers must read indices modulo n.
 */
export function circularRuns(state: number[]): CornerRun[] {
  const n = state.length;
  if (n === 0) return [];

  const origin = state.indexOf(0);
  // No zero anywhere: the whole loop is one continuous turn (an oval), unless
  // the direction flips somewhere, in which case a flip point serves as the
  // seam instead.
  if (origin < 0) {
    const flip = state.findIndex((v, i) => v !== state[(i - 1 + n) % n]);
    if (flip < 0) return [{ start: 0, count: n, sign: state[0] > 0 ? 1 : -1 }];
    return scan(flip);
  }
  return scan(origin);

  function scan(from: number): CornerRun[] {
    const runs: CornerRun[] = [];
    let start = -1;
    let current = 0;

    for (let step = 0; step <= n; step++) {
      const i = (from + step) % n;
      const value = step < n ? state[i] : 0;
      if (value !== current && start >= 0) {
        runs.push({
          start,
          count: (i - start + n) % n,
          sign: current > 0 ? 1 : -1,
        });
        start = -1;
      }
      if (value !== 0 && start < 0) start = i;
      current = value;
    }

    return runs;
  }
}
