import { useEffect, useState } from "react";
import type { TrackMarkers } from "@/lib/track/track-markers";
import { fetchTrackMarkers } from "@/lib/track/track-markers";
import type { EnvironmentBundle } from "@/lib/env/environment-types";
import { fetchEnvironmentBundle, hasEnvironment } from "@/lib/env/environment-loader";
import type { TrackWidthProfile } from "@/lib/track/track-width";
import { fetchTrackWidthProfile } from "@/lib/track/track-width";

/** Everything a rendered circuit needs beyond its centerline. */
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

  // Manifest-only check (~1 KB).
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
