import { useEffect, useState } from "react";
import type { TrackMarkers } from "@/lib/track/track-markers";
import { fetchTrackMarkers } from "@/lib/track/track-markers";
import type { EnvironmentBundle } from "@/lib/env/environment-types";
import { fetchEnvironmentBundle, hasEnvironment } from "@/lib/env/environment-loader";
import type { TrackWidthProfile } from "@/lib/track/track-width";
import { fetchTrackWidthProfile } from "@/lib/track/track-width";

/**
 * Everything a rendered circuit needs beyond its centerline: sector markers,
 * the real width profile, and the environment diorama.
 *
 * Both shells — the viewer and race mode — need exactly this set, loaded with
 * exactly these rules (the environment manifest is checked cheaply for every
 * circuit; the multi-megabyte bundle only downloads once the caller opts in).
 * Keeping it in one hook is what stops the two shells from drifting apart on,
 * say, which of them remembers to drop the old bundle when the track changes.
 *
 * `undefined` means "still loading", `null` means "this circuit has none".
 */
export interface CircuitScene {
  markers: TrackMarkers | null;
  widthProfile: TrackWidthProfile | null | undefined;
  environmentBundle: EnvironmentBundle | null | undefined;
  environmentAvailable: boolean | undefined;
}

export function useCircuitScene(
  circuitId: string | null,
  environmentEnabled: boolean,
): CircuitScene {
  const [markers, setMarkers] = useState<TrackMarkers | null>(null);
  const [widthProfile, setWidthProfile] = useState<
    TrackWidthProfile | null | undefined
  >(undefined);
  const [environmentBundle, setEnvironmentBundle] = useState<
    EnvironmentBundle | null | undefined
  >(undefined);
  const [environmentAvailable, setEnvironmentAvailable] = useState<
    boolean | undefined
  >(undefined);

  useEffect(() => {
    if (!circuitId) {
      const timer = window.setTimeout(() => setMarkers(null), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    fetchTrackMarkers(circuitId).then((m) => {
      if (!cancelled) setMarkers(m);
    });
    return () => {
      cancelled = true;
    };
  }, [circuitId]);

  useEffect(() => {
    if (!circuitId) {
      const timer = window.setTimeout(() => setWidthProfile(null), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    const timer = window.setTimeout(() => setWidthProfile(undefined), 0);
    fetchTrackWidthProfile(circuitId).then((profile) => {
      if (!cancelled) setWidthProfile(profile);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [circuitId]);

  // Manifest-only check (~1 KB). Runs regardless of the toggle so the UI knows
  // whether to offer 3D mode at all.
  useEffect(() => {
    if (!circuitId) {
      const timer = window.setTimeout(() => setEnvironmentAvailable(undefined), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    const timer = window.setTimeout(() => setEnvironmentAvailable(undefined), 0);
    hasEnvironment(circuitId).then((available) => {
      if (!cancelled) setEnvironmentAvailable(available);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [circuitId]);

  useEffect(() => {
    if (!circuitId || !environmentEnabled) {
      const timer = window.setTimeout(() => setEnvironmentBundle(undefined), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    const timer = window.setTimeout(() => setEnvironmentBundle(undefined), 0);
    fetchEnvironmentBundle(circuitId).then((bundle) => {
      if (!cancelled) setEnvironmentBundle(bundle);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [circuitId, environmentEnabled]);

  return { markers, widthProfile, environmentBundle, environmentAvailable };
}
