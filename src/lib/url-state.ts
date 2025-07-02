import { create } from "zustand";
import type { CameraPreset } from "@/components/track-viewer";
import type { TrackViewMode } from "@/lib/track-markers";

function isCameraPreset(value: string | null): value is CameraPreset {
  return value === "top" || value === "iso" || value === "side";
}

function parseWidthParam(value: string | null): number | null {
  if (!value) return null;
  const width = Number(value);
  if (!Number.isFinite(width)) return null;
  return Math.max(3, Math.min(15, Math.round(width)));
}

function readUrlParams() {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search);
  return {
    track: p.get("track"),
    width: parseWidthParam(p.get("width")),
    elevation: p.get("elevation"),
    camera: p.get("camera"),
    sectors: p.get("sectors"),
    environment: p.get("environment"),
    terrain: p.get("terrain"),
    realwidth: p.get("realwidth"),
  };
}

interface UrlState {
  track: string | null;
  trackWidth: number;
  elevationEnabled: boolean;
  cameraPreset: CameraPreset | null;
  viewMode: TrackViewMode;
  environmentEnabled: boolean;
  environmentTerrain: boolean;
  realWidthEnabled: boolean;
  hydrated: boolean;

  setTrack: (id: string) => void;
  setTrackWidth: (w: number) => void;
  setElevationEnabled: (v: boolean) => void;
  setCameraPreset: (p: CameraPreset | null) => void;
  setViewMode: (m: TrackViewMode) => void;
  setEnvironmentEnabled: (v: boolean) => void;
  setEnvironmentTerrain: (v: boolean) => void;
  setRealWidthEnabled: (v: boolean) => void;
  hydrate: (circuits: { id: string }[]) => void;
  /** Write the current state to the URL (replaceState). */
  syncUrl: (opts: {
    environmentBundleAvailable: boolean;
    widthProfileAvailable: boolean;
  }) => void;
}

export const useUrlState = create<UrlState>((set, get) => ({
  track: null,
  trackWidth: 7,
  elevationEnabled: true,
  cameraPreset: null,
  viewMode: "sectors",
  environmentEnabled: false,
  environmentTerrain: true,
  realWidthEnabled: false,
  hydrated: false,

  setTrack: (id) => set({ track: id }),
  setTrackWidth: (w) => set({ trackWidth: w }),
  setElevationEnabled: (v) => set({ elevationEnabled: v }),
  setCameraPreset: (p) => set({ cameraPreset: p }),
  setViewMode: (m) => set({ viewMode: m }),
  setEnvironmentEnabled: (v) => set({ environmentEnabled: v }),
  setEnvironmentTerrain: (v) => set({ environmentTerrain: v }),
  setRealWidthEnabled: (v) => set({ realWidthEnabled: v }),

  hydrate: (circuits) => {
    const s = get();
    if (s.hydrated) return;

    const url = readUrlParams();
    if (!url) {
      set({ hydrated: true });
      return;
    }

    const patch: Partial<UrlState> = { hydrated: true };

    // Track
    if (url.track && circuits.some((c) => c.id === url.track)) {
      patch.track = url.track;
    }

    // Width
    if (url.width != null) {
      patch.trackWidth = url.width;
    }

    // Elevation
    if (url.elevation === "0" || url.elevation === "1") {
      patch.elevationEnabled = url.elevation === "1";
    }

    // Camera
    if (isCameraPreset(url.camera)) {
      patch.cameraPreset = url.camera;
    }

    // View mode — sectors default unless realwidth=1 or sectors=0
    if (url.realwidth === "1" || url.sectors === "0") {
      patch.viewMode = "normal";
    } else if (url.sectors === "1") {
      patch.viewMode = "sectors";
    }

    // Environment
    if (url.environment === "0" || url.environment === "1") {
      patch.environmentEnabled = url.environment === "1";
    }

    // Terrain — defaults to true unless explicitly "0"
    if (url.terrain === "0" || url.terrain === "1") {
      patch.environmentTerrain = url.terrain === "1";
    }

    // Real width
    if (url.realwidth === "0" || url.realwidth === "1") {
      patch.realWidthEnabled = url.realwidth === "1";
    }

    set(patch);
  },

  syncUrl: ({ environmentBundleAvailable, widthProfileAvailable }) => {
    const s = get();
    if (!s.hydrated || typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);

    if (s.track) params.set("track", s.track);
    params.set("width", String(s.trackWidth));
    params.set("elevation", s.elevationEnabled ? "1" : "0");

    if (s.cameraPreset && s.cameraPreset !== "reset") {
      params.set("camera", s.cameraPreset);
    } else {
      params.delete("camera");
    }

    params.set("sectors", s.viewMode === "sectors" ? "1" : "0");

    if (environmentBundleAvailable) {
      params.set("environment", s.environmentEnabled ? "1" : "0");
      if (s.environmentEnabled) {
        params.set("terrain", s.environmentTerrain ? "1" : "0");
      } else {
        params.delete("terrain");
      }
    } else {
      params.delete("environment");
      params.delete("terrain");
    }

    if (widthProfileAvailable) {
      params.set("realwidth", s.realWidthEnabled ? "1" : "0");
    } else {
      params.delete("realwidth");
    }

    const nextSearch = `?${params.toString()}`;
    if (nextSearch === window.location.search) return;

    window.history.replaceState(null, "", nextSearch);
    window.dispatchEvent(new PopStateEvent("popstate"));
  },
}));
