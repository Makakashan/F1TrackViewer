/**
 * Physical dimensions of a current-generation F1 car, in meters — which are
 * also Three.js units, since the scene is 1:1 metric. Loaded models are
 * normalized to CAR_LENGTH rather than trusted to be authored in meters.
 */

export const CAR_LENGTH = 5.6;
export const CAR_WIDTH = 2.0;
export const CAR_HALF_WIDTH = CAR_WIDTH / 2;

/** Tyre radius — 18" rim plus sidewall. */
export const WHEEL_RADIUS = 0.36;

/** Front-to-rear axle distance. */
export const WHEELBASE = 3.6;

/** Nose-to-tail spacing for static formations, matching a real grid's rows. */
export const GRID_SPACING = 8;
