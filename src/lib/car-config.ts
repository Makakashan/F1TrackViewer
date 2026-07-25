/**
 * Physical dimensions of a car, in meters.
 *
 * The scene is rendered at 1:1 metric scale (see geo-utils.ts — lon/lat are
 * projected straight to meters and REAL_ELEVATION_SCALE is 1), so these are
 * real-world figures used directly as Three.js units. Values approximate a
 * current-generation F1 car.
 *
 * Loaded models are normalized to CAR_LENGTH rather than trusted: assets
 * arrive authored in metres, centimetres or arbitrary units, and a car that
 * is silently a hundred times too large is a confusing thing to debug.
 */

export const CAR_LENGTH = 5.6;
export const CAR_WIDTH = 2.0;
export const CAR_HALF_WIDTH = CAR_WIDTH / 2;

/** Tyre radius — 18" rim plus sidewall. */
export const WHEEL_RADIUS = 0.36;

/** Front-to-rear axle distance. */
export const WHEELBASE = 3.6;

/**
 * Nose-to-tail spacing when cars are lined up, in metres.
 *
 * A real grid uses eight metres between rows; this is the same idea applied to
 * a queue, and it is only used for static formations like the admin fleet
 * preview and a pre-race grid.
 */
export const GRID_SPACING = 8;
