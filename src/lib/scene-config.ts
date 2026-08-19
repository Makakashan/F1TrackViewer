/** Shared constants, helpers, and theme colors for the Three.js track scene. */

export const TRACK_SURFACE_RAISE = 1.1;
export const TRACK_OVERLAY_RAISE = TRACK_SURFACE_RAISE + 0.18;
/** Painted markings sit on the asphalt: just enough clearance to beat depth precision. */
export const TRACK_PAINT_RAISE = TRACK_SURFACE_RAISE + 0.02;
export const TRACK_RENDER_ORDER = 100;
export const TRACK_OVERLAY_RENDER_ORDER = TRACK_RENDER_ORDER + 1;
/**
 * The apron is under the ribbon, so it is drawn before it.
 *
 * The whole stack used to be ordered by polygon offset instead. That is a depth
 * bias scaled by the polygon's own slope, so the ribbon on a hillside seen at a
 * grazing angle was pulled toward the camera by an amount that grows with
 * distance — far enough to come out through the building in front of it at the
 * Fairmont hairpin. Height and draw order say the same thing and say it in world
 * space, where a building either is in front or is not.
 */
export const TRACK_APRON_RENDER_ORDER = TRACK_RENDER_ORDER - 1;
/** Solid things standing on the track: cars, gantry, start lights. */
export const TRACK_PROP_RENDER_ORDER = TRACK_OVERLAY_RENDER_ORDER + 1;
export const TERRAIN_TRACK_OFFSET = 4.5;
/** How far the track's side wall is buried in the ground it reaches. */
export const TERRAIN_TRACK_WALL_DIG_M = 1.5;
/** Shortest the wall may get, so a road on flat ground still has an edge. */
export const TERRAIN_TRACK_MIN_WALL_M = 1.2;
// GeoJSON straights can span 400 m between two points.
export const TERRAIN_TRACK_MAX_SEGMENT_M = 40;
// Wide enough to erase DEM cell steps (per-vertex wobble drops ~58%).
export const TERRAIN_TRACK_SMOOTH_RADIUS_M = 120;
export const START_FINISH_STORAGE_KEY = "f1tv:start-finish-overrides:v1";

export function disposeGeometry(value: unknown) {
  const disposable = value as { dispose?: unknown } | null | undefined;
  if (typeof disposable?.dispose === "function") {
    disposable.dispose();
  }
}

export function canCreateWebGLContext(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!context) return false;
    const loseContext = (
      context as WebGLRenderingContext | WebGL2RenderingContext
    ).getExtension("WEBGL_lose_context");
    loseContext?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export interface SceneColors {
  trackColor: string;
  trackEmissive: string;
  trackEmissiveIntensity: number;
  outlineColor: string;
  groundColor: string;
  ringColor1: string;
  ringColor2: string;
  markerColor: string;
  sectorEmissiveIntensity: number;
  splitLineColor: string;
}

export function getSceneColors(isDark: boolean): SceneColors {
  return {
    trackColor: "#e10600",
    trackEmissive: "#e10600",
    trackEmissiveIntensity: isDark ? 0.12 : 0.3,
    outlineColor: isDark ? "#0a0a0d" : "#1a1a1a",
    groundColor: isDark ? "#0a0a0d" : "#fbfcfe",
    ringColor1: isDark ? "#1f1f24" : "#eef1f6",
    ringColor2: isDark ? "#16161a" : "#f5f7fb",
    markerColor: isDark ? "#f5f5f5" : "#151820",
    sectorEmissiveIntensity: isDark ? 0.15 : 0.035,
    splitLineColor: isDark ? "#ffffff" : "#222936",
  };
}

export function getSceneBackground(resolvedTheme: "light" | "dark") {
  if (resolvedTheme === "dark") {
    return {
      bgGradient: "#030407",
      sceneBackgroundColor: "#030407",
    };
  }
  return {
    bgGradient: "#D0D0D2",
    sceneBackgroundColor: "#D0D0D2",
  };
}
