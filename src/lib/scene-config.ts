/**
 * Shared constants, helpers, and theme colors for the Three.js track scene.
 */

export const TRACK_SURFACE_RAISE = 1.1;
export const TRACK_OVERLAY_RAISE = TRACK_SURFACE_RAISE + 0.18;
export const TRACK_RENDER_ORDER = 100;
export const TRACK_OVERLAY_RENDER_ORDER = TRACK_RENDER_ORDER + 1;
export const TERRAIN_TRACK_OFFSET = 6;
export const TERRAIN_TRACK_CLEARANCE_SAMPLE_RADIUS_M = 46;
export const TERRAIN_TRACK_WALL_DEPTH = TERRAIN_TRACK_OFFSET + TRACK_SURFACE_RAISE;
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
    trackColor: "#c10500",
    trackEmissive: "#c10500",
    trackEmissiveIntensity: 0.12,
    outlineColor: isDark ? "#0a0a0d" : "#161a21",
    groundColor: isDark ? "#0a0a0d" : "#fbfcfe",
    ringColor1: isDark ? "#1f1f24" : "#eef1f6",
    ringColor2: isDark ? "#16161a" : "#f5f7fb",
    markerColor: isDark ? "#f5f5f5" : "#151820",
    sectorEmissiveIntensity: isDark ? 0.15 : 0.035,
    splitLineColor: isDark ? "#ffffff" : "#222936",
  };
}

export function getSceneBackground(resolvedTheme: "light" | "dark") {
  return {
    bgGradient:
      resolvedTheme === "dark"
        ? "radial-gradient(circle at 50% 42%, rgba(44, 49, 62, 0.55) 0%, rgba(13, 15, 21, 0.92) 34%, #030407 74%, #010103 100%)"
        : "radial-gradient(circle at 50% 42%, rgba(52, 58, 70, 0.38) 0%, rgba(13, 15, 21, 0.96) 48%, #030407 100%)",
    sceneBackgroundColor:
      resolvedTheme === "dark" ? "#030407" : "#05070B",
  };
}
