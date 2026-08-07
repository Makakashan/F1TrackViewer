import * as THREE from "three";
import { sampleCurvature } from "./track-curvature";
import { apronRoomAt, type ApronRoom } from "./track-apron";
import type { HalfWidth } from "./track-geometry";

/**
 * Kerbs — the red/white striped strips lining the inside of every corner.
 *
 * Circuit GeoJSON carries no kerb data, so they are derived from the geometry
 * itself: sample the centerline curvature, call anything tighter than
 * `maxCornerRadiusMeters` a corner, and lay a strip along the inner edge of
 * each corner run. That reproduces the real layout closely enough at circuit
 * scale, and works for all 31 circuits without a per-track table.
 */

/**
 * Kerb red and white.
 *
 * The deep red this used to carry was chosen when kerbs were drawn over the
 * schematic's red ribbon, where a true kerb red disappeared into the road. They
 * are a race-view feature now and the surface under them is asphalt, so the red
 * can be the red it is in life — at the old value the stripes read as a faint
 * dotted line from any distance.
 */
const KERB_RED = new THREE.Color("#cc1120");
const KERB_WHITE = new THREE.Color("#f2f4f7");

export interface KerbOptions {
  /** A sample is "in a corner" when its radius drops below this. */
  maxCornerRadiusMeters?: number;
  /** Lateral width of the strip, measured outward from the track edge. */
  widthMeters?: number;
  /**
   * How much paved verge each sample has. The kerb never reaches past it, so
   * it cannot end up lying on grass or inside a building.
   */
  room?: ApronRoom;
  /** Arc length of one red or white block. */
  stripeMeters?: number;
  /**
   * Share of the strip's width to lay on the outside of a corner, where a
   * circuit's exit kerb goes. Zero draws the apex kerb only.
   */
  outerWidthShare?: number;
  /** Corner runs are grown by this much at each end, as real kerbs are. */
  runPaddingMeters?: number;
  /** Distance over which the strip widens from nothing to full at each end. */
  taperMeters?: number;
  /** A run shorter than this is curvature noise, not a corner. */
  minRunMeters?: number;
  /**
   * A corner already in progress only ends once the radius opens past this.
   * Well above `maxCornerRadiusMeters` on purpose — see resolveCornerSides.
   */
  exitRadiusMeters?: number;
  /** Height of the strip's outer lip above its inner edge — kerbs are ramped. */
  liftMeters?: number;
}

const DEFAULTS = {
  // 260 m was loose enough to catch the gentle bends along a "straight" and
  // scatter two-block kerb fragments down them; a real corner is far tighter.
  maxCornerRadiusMeters: 170,
  // A real kerb runs about two meters. It cost racing surface when it was cut
  // out of the ribbon; lying on the apron it costs nothing, so it can be the
  // width it actually is.
  widthMeters: 1.9,
  // Real kerb blocks run about a meter. This is now independent of the curve
  // sampling, so the number is what actually reaches the screen.
  stripeMeters: 1,
  // Off: real circuits do carry exit kerbs, but not at every corner and not
  // for the whole length of one, and a strip down the outside of every turn
  // reads as a painted border rather than as kerbing.
  outerWidthShare: 0,
  runPaddingMeters: 10,
  taperMeters: 14,
  // 25 m dropped 59 corners across the calendar — chicanes and the short
  // direction changes at the end of a straight, all of them kerbed in life.
  // The radius threshold already rejects the gentle bends, so a run this
  // short under it is a corner, not noise.
  minRunMeters: 12,
  exitRadiusMeters: 420,
  liftMeters: 0.07,
} satisfies Required<Omit<KerbOptions, "room">>;

function halfWidthAt(halfWidth: HalfWidth, s: number): number {
  return typeof halfWidth === "function" ? halfWidth(s) : halfWidth;
}

function wrap01(value: number): number {
  return ((value % 1) + 1) % 1;
}

/**
 * Mark which side of the track is the inside of a corner, 0 on a straight.
 *
 * Uses hysteresis rather than one threshold. Real corners are not
 * constant-radius: through a complex like Becketts the curvature repeatedly
 * dips under any single threshold, which chopped one corner into several runs
 * that each tapered to nothing and back — the kerb pulsed. Entering a corner
 * takes `enter` curvature, but leaving it takes a much gentler `exit`, so the
 * kerb stays on through the dips and only ends where the track really
 * straightens.
 */
function resolveCornerSides(
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

interface KerbRun {
  start: number;
  count: number;
  /** Which side of the centerline this stretch of kerb belongs to. */
  sign: 1 | -1;
}

/**
 * Contiguous index ranges sharing the same non-zero value in `state`, over a
 * circular array. Runs are split where the turn direction flips, so an S-bend
 * gets one kerb per direction instead of a single strip stuck on one edge
 * through both halves. A run straddling index 0 is returned as one range whose
 * start is near the end of the array — callers must read indices modulo n.
 */
function circularRuns(state: number[]): KerbRun[] {
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

  function scan(from: number): KerbRun[] {
    const runs: KerbRun[] = [];
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

/**
 * Build the kerb strips for a track. Returns null when the circuit has no
 * corner tight enough to qualify, so callers can skip the mesh entirely.
 *
 * `raise` is the Y offset above the centerline, matching the track surface.
 */
export function buildKerbGeometry(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  raise: number,
  samples: number,
  options: KerbOptions = {},
): THREE.BufferGeometry | null {
  const {
    maxCornerRadiusMeters,
    widthMeters,
    stripeMeters,
    runPaddingMeters,
    taperMeters,
    minRunMeters,
    exitRadiusMeters,
    liftMeters,
    outerWidthShare,
    room,
  } = { ...DEFAULTS, ...options };

  const n = samples;
  if (n < 8) return null;

  const totalLength = curve.getLength();
  const ds = totalLength / n;
  if (!(ds > 0)) return null;

  const profile = sampleCurvature(curve, n);
  if (!profile) return null;
  const { tangents, curvature } = profile;

  // side = tangent × up, so a turn toward -side reads as a negative cross
  // product and the inner edge lies at sign(curvature) * halfWidth.
  const cornerSide = resolveCornerSides(
    curvature,
    1 / maxCornerRadiusMeters,
    1 / exitRadiusMeters,
  );

  const padSamples = Math.round(runPaddingMeters / ds);
  const minRunSamples = Math.max(2, Math.round(minRunMeters / ds));

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();

  const point = new THREE.Vector3();
  const sideVector = new THREE.Vector3();

  // Vertices are emitted per quad rather than shared between them so each
  // stripe keeps a single flat color instead of gradient-blending into its
  // neighbour.
  function pushVertex(distance: number, offset: number, lift: number) {
    const u = wrap01(distance / totalLength);
    point.copy(curve.getPointAt(u));
    sideVector.crossVectors(curve.getTangentAt(u), up);
    if (sideVector.lengthSq() < 1e-6) sideVector.set(1, 0, 0);
    sideVector.normalize();
    positions.push(
      point.x + sideVector.x * offset,
      point.y + raise + lift,
      point.z + sideVector.z * offset,
    );
    normals.push(0, 1, 0);
    colors.push(color.r, color.g, color.b);
  }

  for (const { start, count, sign: innerSign } of circularRuns(cornerSide)) {
    if (count < minRunSamples) continue;

    // Work in arc length from here on. Emitting one quad per curve sample
    // would clamp the stripe length to the sample spacing — 4 m at Monaco —
    // and the pattern would come out in blocks several times too long.
    // Snapped to the stripe grid at both ends so no block is left clipped
    // short — a half-length block next to full ones reads as a mistake.
    const runStart =
      Math.floor(((start - padSamples) * ds) / stripeMeters) * stripeMeters;
    const rawEnd = runStart + Math.min(totalLength, (count + padSamples * 2) * ds);
    const runEnd = Math.ceil(rawEnd / stripeMeters) * stripeMeters;

    /** 0 at both ends of the run, 1 once past the taper. */
    const taperAt = (distance: number) =>
      THREE.MathUtils.smoothstep(
        Math.min(distance - runStart, runEnd - distance) / taperMeters,
        0,
        1,
      );

    // Stripe boundaries sit on a global grid rather than at the run's start,
    // so the pattern stays put when a threshold changes the run's extent.
    const firstStripe = Math.floor(runStart / stripeMeters);
    const lastStripe = Math.ceil(runEnd / stripeMeters);

    // A corner is kerbed on both sides. The apex kerb is the one this used to
    // draw; the one facing it across the road is what a driver actually looks
    // at for most of a lap, and leaving it out is why the circuit read as
    // having no kerbs at all from inside the car.
    for (const side of [innerSign, -innerSign as 1 | -1]) {
      const inner = side === innerSign;
      const sideWidth = inner ? widthMeters : widthMeters * outerWidthShare;
      if (sideWidth < 0.05) continue;

      for (let stripe = firstStripe; stripe < lastStripe; stripe++) {
        const d0 = Math.max(stripe * stripeMeters, runStart);
        const d1 = Math.min((stripe + 1) * stripeMeters, runEnd);
        if (d1 - d0 < 1e-3) continue;

        const taper0 = taperAt(d0);
        const taper1 = taperAt(d1);
        if (taper0 <= 0 && taper1 <= 0) continue;

        color.copy(stripe % 2 === 0 ? KERB_RED : KERB_WHITE);

        // The kerb is bolted to the outside of the road, not carved out of it.
        // Its inner edge is the white line and it reaches outward across the
        // apron — which is why the apron has to exist first, and why the strip
        // is clamped to whatever room that sample actually has.
        const s0 = wrap01(d0 / totalLength);
        const s1 = wrap01(d1 / totalLength);
        const edge0 = halfWidthAt(halfWidth, s0) * side;
        const edge1 = halfWidthAt(halfWidth, s1) * side;
        const room0 = room ? apronRoomAt(room, s0, side) : sideWidth;
        const room1 = room ? apronRoomAt(room, s1, side) : sideWidth;
        const reach0 = Math.min(sideWidth, room0) * taper0;
        const reach1 = Math.min(sideWidth, room1) * taper1;
        // Nothing to lay this stretch on: the kerb ends where the paving does.
        if (reach0 < 0.05 && reach1 < 0.05) continue;
        const outer0 = edge0 + reach0 * side;
        const outer1 = edge1 + reach1 * side;

        // Kerbs ramp upward away from the racing line, so the raised lip is
        // the outer side. The lift tapers with the width — a full-height lip
        // that stops dead would read as a step in the road.
        const lift0 = liftMeters * (reach0 / Math.max(sideWidth, 1e-6));
        const lift1 = liftMeters * (reach1 / Math.max(sideWidth, 1e-6));

        // Wound so the strip faces up on either edge.
        if (side > 0) {
          pushVertex(d0, edge0, 0);
          pushVertex(d1, edge1, 0);
          pushVertex(d0, outer0, lift0);
          pushVertex(d0, outer0, lift0);
          pushVertex(d1, edge1, 0);
          pushVertex(d1, outer1, lift1);
        } else {
          pushVertex(d0, edge0, 0);
          pushVertex(d0, outer0, lift0);
          pushVertex(d1, edge1, 0);
          pushVertex(d0, outer0, lift0);
          pushVertex(d1, outer1, lift1);
          pushVertex(d1, edge1, 0);
        }
      }
    }
  }

  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The continuous white line down both edges of the track.
 *
 * Without it the kerbs are the only marking on the surface and read as decals
 * dropped onto a plain ribbon; with it they land at the end of a line that
 * runs the whole lap, which is what makes them look like part of the road.
 */
export function buildTrackEdgeLineGeometry(
  curve: THREE.CatmullRomCurve3,
  halfWidth: HalfWidth,
  raise: number,
  samples: number,
  lineWidthMeters = 0.18,
): THREE.BufferGeometry {
  const n = samples;
  const pts = curve.getSpacedPoints(n);
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();

  const positions: number[] = [];
  const normals: number[] = [];

  const sideVectors: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    side.crossVectors(curve.getTangentAt((i % n) / n), up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    sideVectors.push(side.clone().normalize());
  }

  function pushVertex(i: number, offset: number) {
    const p = pts[i];
    const v = sideVectors[i];
    positions.push(p.x + v.x * offset, p.y + raise, p.z + v.z * offset);
    normals.push(0, 1, 0);
  }

  for (const edgeSign of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const j = i + 1;
      const o0 = halfWidthAt(halfWidth, i / n) * edgeSign;
      const o1 = halfWidthAt(halfWidth, j / n) * edgeSign;
      // Pulled just inside the edge: sitting exactly on it leaves the line
      // half-hanging off the ribbon wherever the width profile narrows.
      const outer0 = o0 - lineWidthMeters * 0.25 * edgeSign;
      const outer1 = o1 - lineWidthMeters * 0.25 * edgeSign;
      const inner0 = outer0 - lineWidthMeters * edgeSign;
      const inner1 = outer1 - lineWidthMeters * edgeSign;

      if (edgeSign > 0) {
        pushVertex(i, inner0);
        pushVertex(j, inner1);
        pushVertex(i, outer0);
        pushVertex(i, outer0);
        pushVertex(j, inner1);
        pushVertex(j, outer1);
      } else {
        pushVertex(i, inner0);
        pushVertex(i, outer0);
        pushVertex(j, inner1);
        pushVertex(i, outer0);
        pushVertex(j, outer1);
        pushVertex(j, inner1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
