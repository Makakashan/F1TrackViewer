import type { TrackOverrides } from "@/lib/track/track-overrides";
import cmc_1929 from "./mc-1929.json";

/** Written by the track editor's development endpoint: one import per circuit with corrections. */
export const TRACK_OVERRIDES: Record<string, TrackOverrides> = {
  "mc-1929": cmc_1929 as TrackOverrides,
};
