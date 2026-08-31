import { useEffect, useState } from "react";
import type { TrackMarkers } from "@/lib/track/track-markers";
import { fetchTrackMarkers } from "@/lib/track/track-markers";
import type { EnvironmentBundle } from "@/lib/env/environment-types";
import { fetchEnvironmentBundle, hasEnvironment } from "@/lib/env/environment-loader";
import type { CityManifest } from "@/lib/env/city-loader";
import { fetchCityManifest } from "@/lib/env/city-loader";
import type { TrackWidthProfile } from "@/lib/track/track-width";
import { fetchTrackWidthProfile } from "@/lib/track/track-width";

/** Everything a rendered circuit needs beyond its centerline. */
export interface CircuitScene {
  markers: TrackMarkers | null;
  widthProfile: TrackWidthProfile | null | undefined;
  environmentBundle: EnvironmentBundle | null | undefined;
  environmentAvailable: boolean | undefined;
  /** Present when the circuit has a baked city; it replaces the diorama (D17). */
  cityManifest: CityManifest | null | undefined;
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
  const [cityManifest, setCityManifest] = useState<CityManifest | null | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!circuitId) {
      const timer = window.setTimeout(() => setCityManifest(null), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    const timer = window.setTimeout(() => setCityManifest(undefined), 0);
    fetchCityManifest(circuitId).then((manifest) => {
      if (!cancelled) setCityManifest(manifest);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [circuitId]);

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
    // A baked city makes the diorama's 2 MB of JSON dead weight (D17).
    if (cityManifest) {
      const timer = window.setTimeout(() => setEnvironmentAvailable(false), 0);
      return () => window.clearTimeout(timer);
    }
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
  }, [cityManifest, circuitId]);

  useEffect(() => {
    if (!circuitId || !environmentEnabled || cityManifest) {
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
  }, [cityManifest, circuitId, environmentEnabled]);

  return { markers, widthProfile, environmentBundle, environmentAvailable, cityManifest };
}
