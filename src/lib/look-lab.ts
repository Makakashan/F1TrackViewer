import { create } from "zustand";
import { readPref, writePref } from "@/lib/local-pref";

/**
 * Knobs for the scene-look spike (docs/scene-look-plan.md). The panel that turns
 * them only mounts in development, so a production build keeps today's look.
 */
export interface LookSettings {
  /** The A/B switch: the new look, or the scene as it was. */
  enabled: boolean;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  sunIntensity: number;
  skyIntensity: number;
  exposure: number;
  shadowSoftness: number;
  shadowNormalBias: number;
  heliHeightM: number;
  heliBackM: number;
  heliLateralM: number;
  heliFovDeg: number;
  asphalt: boolean;
  rubber: boolean;
  barriers: boolean;
  fences: boolean;
  ground: boolean;
  /** Race mode draws a baked city whatever `environment` says; this takes it away, in A and B alike. */
  city: boolean;
}

export const LOOK_DEFAULTS: LookSettings = {
  enabled: process.env.NODE_ENV === "development",
  sunAzimuthDeg: 225,
  sunElevationDeg: 42,
  sunIntensity: 3.2,
  skyIntensity: 1.3,
  exposure: 1,
  shadowSoftness: 2,
  shadowNormalBias: 0.04,
  heliHeightM: 70,
  heliBackM: 40,
  heliLateralM: 22,
  heliFovDeg: 30,
  asphalt: true,
  rubber: true,
  barriers: true,
  fences: true,
  ground: true,
  city: true,
};

const STORAGE_KEY = "f1tv:lookLab:v1";

interface LookLabState extends LookSettings {
  set: (patch: Partial<LookSettings>) => void;
  reset: () => void;
  /** Read after mount rather than at import, or the server render and the first client render disagree. */
  load: () => void;
}

function settingsOf(state: LookLabState): LookSettings {
  const settings = { ...LOOK_DEFAULTS };
  for (const key of Object.keys(LOOK_DEFAULTS) as (keyof LookSettings)[]) {
    (settings as Record<string, unknown>)[key] = state[key];
  }
  return settings;
}

export const useLookLab = create<LookLabState>((set, get) => ({
  ...LOOK_DEFAULTS,
  set: (patch) => {
    set(patch);
    writePref(STORAGE_KEY, settingsOf(get()));
  },
  reset: () => {
    set(LOOK_DEFAULTS);
    writePref(STORAGE_KEY, LOOK_DEFAULTS);
  },
  load: () => {
    set({ ...LOOK_DEFAULTS, ...readPref<Partial<LookSettings>>(STORAGE_KEY, {}) });
  },
}));

export function lookSettingsJson(): string {
  return JSON.stringify(settingsOf(useLookLab.getState()), null, 2);
}
