"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import dynamic from "next/dynamic";
import { RefreshCw, Flag, X } from "lucide-react";
import CircuitSidebar from "@/components/circuit-sidebar";
import TrackOverlay from "@/components/track-overlay";
import TrackSidePanel from "@/components/track-side-panel";
import ErrorBanner from "@/components/error-banner";
import MobileMenu from "@/components/mobile-menu";
import MobileInfoSheet from "@/components/mobile-info-sheet";
import MobileLayersSheet from "@/components/mobile-layers-sheet";
import SettingsMenu from "@/components/settings-menu";
import { useAppPref } from "@/components/app-pref-provider";
import { type CircuitProperties } from "@/lib/f1-circuits";
import { useCircuits } from "@/hooks/use-circuts";
import { useTrackData } from "@/hooks/use-track-data";
import type { CameraPreset } from "@/components/track-viewer";
import type { StartFinishPlacement } from "@/lib/start-finish";
import type { TrackViewMode, TrackMarkers } from "@/lib/track-markers";
import { fetchTrackMarkers } from "@/lib/track-markers";
import type { EnvironmentBundle } from "@/lib/environment-types";
import { fetchEnvironmentBundle } from "@/lib/environment-loader";
import type { TrackWidthProfile } from "@/lib/track-width";
import { fetchTrackWidthProfile } from "@/lib/track-width";

// Three.js scene must be client-only — no SSR for WebGL.
const TrackViewer = dynamic(() => import("@/components/track-viewer"), {
  ssr: false,
  loading: () => {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        Loading Three.js…
      </div>
    );
  },
});

interface F1TrackAppProps {
  startFinishCalibration?: boolean;
}

function subscribeUrlState(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function getClientUrlSnapshot() {
  return window.location.search;
}

function getServerUrlSnapshot() {
  return "";
}

function notifyUrlStateSubscribers() {
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function isCameraPreset(value: string | null): value is CameraPreset {
  return value === "top" || value === "iso" || value === "side";
}

function parseWidthParam(value: string | null): number | null {
  if (!value) return null;
  const width = Number(value);
  if (!Number.isFinite(width)) return null;
  return Math.max(3, Math.min(15, Math.round(width)));
}

export default function F1TrackApp({
  startFinishCalibration = false,
}: F1TrackAppProps) {
  const { t, resolvedTheme } = useAppPref();
  const [error, setError] = useState<string | null>(null);
  const { circuits, selectedId, loadingIndex, onSelect } =
    useCircuits(setError);
  const urlSearch = useSyncExternalStore(
    subscribeUrlState,
    getClientUrlSnapshot,
    getServerUrlSnapshot,
  );
  const urlParams = useMemo(() => new URLSearchParams(urlSearch), [urlSearch]);
  const { geojson, loadingTrack, elevations, loadingElevations } = useTrackData(
    selectedId,
    setError,
  );
  const [autoRotate, setAutoRotate] = useState(true);
  const [trackWidth, setTrackWidth] = useState(7);
  const [elevationEnabled, setElevationEnabled] = useState(true);
  // Real per-point track width (TUMFTM). null = no profile for this circuit,
  // undefined = still loading.
  const [widthProfile, setWidthProfile] =
    useState<TrackWidthProfile | null | undefined>(undefined);
  const urlRealWidth = urlParams.get("realwidth");
  const [realWidthEnabled, setRealWidthEnabled] = useState<boolean>(
    () => urlRealWidth === "1",
  );
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset | null>(null);
  const [startFinishPlacement, setStartFinishPlacement] =
    useState<StartFinishPlacement | null>(null);
  const [footerExpanded, setFooterExpanded] = useState(false);
  const [footerDismissed, setFooterDismissed] = useState(false);
  const urlSectors = urlParams.get("sectors");
  const [viewMode, setViewMode] = useState<TrackViewMode>(() =>
    urlRealWidth === "1" || urlSectors === "0" ? "normal" : "sectors",
  );
  const [markers, setMarkers] = useState<TrackMarkers | null>(null);
  // Environment diorama — Monaco MVP3. ?environment=1 opts in; null means
  // "no bundle for this circuit", undefined means "still checking".
  const urlEnvironment = urlParams.get("environment");
  const [environmentEnabled, setEnvironmentEnabled] = useState<boolean>(
    () => urlEnvironment === "1",
  );
  const [environmentBundle, setEnvironmentBundle] =
    useState<EnvironmentBundle | null | undefined>(undefined);
  // Terrain toggle (?terrain=1 / ?terrain=0). Defaults to ON when env is on.
  const urlTerrain = urlParams.get("terrain");
  const [environmentTerrain, setEnvironmentTerrain] = useState<boolean>(
    () => urlTerrain !== "0",
  );
  const didApplyInitialTrack = useRef(false);
  const didApplyInitialWidth = useRef(false);
  const didApplyInitialElevation = useRef(false);
  const didApplyInitialCamera = useRef(false);
  const didApplyInitialSectors = useRef(false);
  const didApplyInitialEnvironment = useRef(false);
  const didApplyInitialTerrain = useRef(false);
  const didApplyInitialRealWidth = useRef(false);

  const urlTrack = urlParams.get("track");
  const urlWidth = parseWidthParam(urlParams.get("width"));
  const urlElevation = urlParams.get("elevation");
  const urlCamera = urlParams.get("camera");

  // Load track markers when selected track changes
  useEffect(() => {
    if (!selectedId) {
      const timer = window.setTimeout(() => setMarkers(null), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    fetchTrackMarkers(selectedId).then((m) => {
      if (!cancelled) setMarkers(m);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Load environment bundle for the selected circuit. Only Monaco (mc-1929)
  // ships a pre-generated diorama at MVP3; other circuits resolve to null
  // and the toggle hides itself.
  useEffect(() => {
    if (!selectedId) {
      const timer = window.setTimeout(() => setEnvironmentBundle(null), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    const timer = window.setTimeout(() => setEnvironmentBundle(undefined), 0);
    fetchEnvironmentBundle(selectedId).then((bundle) => {
      if (!cancelled) setEnvironmentBundle(bundle);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedId]);

  // Load the real-width profile (TUMFTM) for the selected circuit. Only ~20
  // modern layouts ship a profile; the rest resolve to null and the toggle
  // hides itself.
  useEffect(() => {
    if (!selectedId) {
      const timer = window.setTimeout(() => setWidthProfile(null), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    const timer = window.setTimeout(() => setWidthProfile(undefined), 0);
    fetchTrackWidthProfile(selectedId).then((profile) => {
      if (!cancelled) setWidthProfile(profile);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedId]);

  // Auto-disable environment when the selected circuit has no bundle.
  useEffect(() => {
    if (environmentBundle === null && environmentEnabled) {
      const timer = window.setTimeout(() => setEnvironmentEnabled(false), 0);
      return () => window.clearTimeout(timer);
    }
  }, [environmentBundle, environmentEnabled]);

  // Reset view mode only when markers explicitly confirm unavailability
  // (null = still loading, not yet unavailable)
  const prevMarkersRef = useRef<TrackMarkers | null>(null);
  useEffect(() => {
    // Only reset if markers were loaded and have no sectors
    if (viewMode === "sectors" && prevMarkersRef.current === undefined) {
      // markers was loaded but had no sectors — we already handled
    }
    if (
      viewMode === "sectors" &&
      markers !== null &&
      !markers.sectors?.length
    ) {
      const timer = window.setTimeout(() => setViewMode("normal"), 0);
      return () => window.clearTimeout(timer);
    }
    prevMarkersRef.current = markers;
  }, [markers, viewMode]);

  useEffect(() => {
    if (didApplyInitialWidth.current) return;
    if (urlWidth == null || urlWidth === trackWidth) {
      didApplyInitialWidth.current = true;
      return;
    }
    didApplyInitialWidth.current = true;
    const timer = window.setTimeout(() => setTrackWidth(urlWidth), 0);
    return () => window.clearTimeout(timer);
  }, [trackWidth, urlWidth]);

  useEffect(() => {
    if (didApplyInitialElevation.current) return;
    if (urlElevation !== "0" && urlElevation !== "1") {
      didApplyInitialElevation.current = true;
      return;
    }
    const next = urlElevation === "1";
    if (next === elevationEnabled) {
      didApplyInitialElevation.current = true;
      return;
    }
    didApplyInitialElevation.current = true;
    const timer = window.setTimeout(() => setElevationEnabled(next), 0);
    return () => window.clearTimeout(timer);
  }, [elevationEnabled, urlElevation]);

  useEffect(() => {
    if (didApplyInitialCamera.current) return;
    if (!isCameraPreset(urlCamera)) {
      didApplyInitialCamera.current = true;
      return;
    }
    if (urlCamera === cameraPreset) {
      didApplyInitialCamera.current = true;
      return;
    }
    didApplyInitialCamera.current = true;
    const timer = window.setTimeout(() => setCameraPreset(urlCamera), 0);
    return () => window.clearTimeout(timer);
  }, [cameraPreset, urlCamera]);

  // Width and sector visualization are mutually exclusive. Explicit width mode
  // wins if an old/shared URL happens to contain both flags.
  useEffect(() => {
    if (didApplyInitialSectors.current) return;
    const urlSectorsNow = new URLSearchParams(window.location.search).get(
      "sectors",
    );
    const urlRealWidthNow = new URLSearchParams(window.location.search).get(
      "realwidth",
    );
    const targetMode: TrackViewMode =
      urlRealWidthNow === "1" || urlSectorsNow === "0"
        ? "normal"
        : "sectors";
    if (targetMode === viewMode) {
      didApplyInitialSectors.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      setViewMode(targetMode);
      didApplyInitialSectors.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [viewMode]);

  // Hydrate environment toggle from URL (?environment=1).
  useEffect(() => {
    if (didApplyInitialEnvironment.current) return;
    const urlEnv = new URLSearchParams(window.location.search).get(
      "environment",
    );
    if (urlEnv !== "0" && urlEnv !== "1") {
      didApplyInitialEnvironment.current = true;
      return;
    }
    const next = urlEnv === "1";
    if (next === environmentEnabled) {
      didApplyInitialEnvironment.current = true;
      return;
    }
    didApplyInitialEnvironment.current = true;
    const timer = window.setTimeout(() => setEnvironmentEnabled(next), 0);
    return () => window.clearTimeout(timer);
  }, [environmentEnabled]);

  // Hydrate terrain toggle from URL (?terrain=0 disables it, default ON).
  useEffect(() => {
    if (didApplyInitialTerrain.current) return;
    const urlT = new URLSearchParams(window.location.search).get("terrain");
    if (urlT !== "0" && urlT !== "1") {
      didApplyInitialTerrain.current = true;
      return;
    }
    const next = urlT === "1";
    if (next === environmentTerrain) {
      didApplyInitialTerrain.current = true;
      return;
    }
    didApplyInitialTerrain.current = true;
    const timer = window.setTimeout(() => setEnvironmentTerrain(next), 0);
    return () => window.clearTimeout(timer);
  }, [environmentTerrain]);

  // Hydrate real-width toggle from URL. It is opt-in because sector view is
  // the default visualization and the two modes are mutually exclusive.
  useEffect(() => {
    if (didApplyInitialRealWidth.current) return;
    const urlRw = new URLSearchParams(window.location.search).get("realwidth");
    if (urlRw !== "0" && urlRw !== "1") {
      didApplyInitialRealWidth.current = true;
      return;
    }
    const next = urlRw === "1";
    if (next === realWidthEnabled) {
      didApplyInitialRealWidth.current = true;
      return;
    }
    didApplyInitialRealWidth.current = true;
    const timer = window.setTimeout(() => setRealWidthEnabled(next), 0);
    return () => window.clearTimeout(timer);
  }, [realWidthEnabled]);

  useEffect(() => {
    if (didApplyInitialTrack.current) return;
    if (!circuits.length) return;
    if (!urlTrack || selectedId === urlTrack) {
      didApplyInitialTrack.current = true;
      return;
    }
    if (!circuits.some((circuit) => circuit.id === urlTrack)) {
      didApplyInitialTrack.current = true;
      return;
    }
    didApplyInitialTrack.current = true;
    const timer = window.setTimeout(() => onSelect(urlTrack), 0);
    return () => window.clearTimeout(timer);
  }, [circuits, onSelect, selectedId, urlTrack]);

  useEffect(() => {
    if (typeof window === "undefined" || !selectedId) return;
    // Don't write URL until initial hydration of all params is done
    if (!didApplyInitialSectors.current) return;
    if (!didApplyInitialEnvironment.current) return;
    if (!didApplyInitialTerrain.current) return;
    if (!didApplyInitialRealWidth.current) return;
    if (
      !didApplyInitialTrack.current &&
      urlTrack &&
      selectedId !== urlTrack &&
      circuits.some((circuit) => circuit.id === urlTrack)
    ) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    params.set("track", selectedId);
    params.set("width", String(trackWidth));
    params.set("elevation", elevationEnabled ? "1" : "0");
    if (cameraPreset && cameraPreset !== "reset") {
      params.set("camera", cameraPreset);
    } else {
      params.delete("camera");
    }
    params.set("sectors", viewMode === "sectors" ? "1" : "0");
    // Only persist environment flag when a bundle exists for this circuit —
    // avoids polluting the URL with ?environment=0 for the 39 other tracks.
    if (environmentBundle) {
      params.set("environment", environmentEnabled ? "1" : "0");
      // Persist terrain flag only when environment is enabled.
      if (environmentEnabled) {
        params.set("terrain", environmentTerrain ? "1" : "0");
      } else {
        params.delete("terrain");
      }
    } else {
      params.delete("environment");
      params.delete("terrain");
    }
    // Persist the real-width flag only when a profile exists for this circuit.
    if (widthProfile) {
      params.set("realwidth", realWidthEnabled ? "1" : "0");
    } else {
      params.delete("realwidth");
    }

    const nextSearch = `?${params.toString()}`;
    if (nextSearch === window.location.search) return;

    window.history.replaceState(null, "", nextSearch);
    notifyUrlStateSubscribers();
  }, [cameraPreset, circuits, elevationEnabled, environmentBundle, environmentEnabled, environmentTerrain, realWidthEnabled, selectedId, trackWidth, urlTrack, viewMode, widthProfile]);

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      setMobileListOpen(false);
    },
    [onSelect],
  );

  const handleCameraPreset = useCallback((preset: CameraPreset) => {
    setCameraPreset(preset);
  }, []);

  const handleViewModeChange = useCallback((next: TrackViewMode) => {
    setViewMode(next);
    if (next === "sectors") setRealWidthEnabled(false);
  }, []);

  const handleRealWidthChange = useCallback((enabled: boolean) => {
    setRealWidthEnabled(enabled);
    if (enabled) setViewMode("normal");
  }, []);

  const properties: CircuitProperties | null =
    geojson?.features[0]?.properties ?? null;
  const pointCount = geojson?.features[0]?.geometry.coordinates.length;
  const sectorsAvailable = !!markers?.sectors?.length;
  const realWidthAvailable = !!widthProfile;
  const terrainModeActive =
    !!environmentBundle && environmentEnabled && environmentTerrain;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/80 px-3 backdrop-blur md:px-4">
        <div className="flex items-center gap-2 md:gap-3">
          <MobileMenu
            circuits={circuits}
            selectedId={selectedId}
            loadingIndex={loadingIndex}
            onSelect={handleSelect}
            open={mobileListOpen}
            onOpenChange={setMobileListOpen}
          />

          <div className="flex items-center gap-2">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-md bg-linear-to-br from-red-600 to-orange-600 shadow-[0_0_20px_rgba(225,6,0,0.4)]">
              <Flag className="h-4 w-4 text-white" />
            </div>
            <div className="leading-none">
              <div className="text-sm font-bold tracking-tight">
                {t.appName}
              </div>
              <div className="hidden text-[10px] uppercase tracking-wider text-muted-foreground sm:block">
                {t.appTagline}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 md:gap-3">
          <SettingsMenu />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)_320px]">
        <aside className="hidden min-h-0 border-r border-border bg-sidebar/50 md:block">
          <CircuitSidebar
            circuits={circuits}
            selectedId={selectedId}
            loadingIndex={loadingIndex}
            onSelect={handleSelect}
          />
        </aside>

        <main className="relative min-h-0 bg-background">
          {error && <ErrorBanner error={error} />}
          {geojson ? (
            <TrackViewer
              geojson={geojson}
              elevations={elevationEnabled ? elevations : null}
              trackWidth={trackWidth}
              autoRotate={autoRotate}
              resolvedTheme={resolvedTheme}
              cameraPreset={cameraPreset}
              startFinishCalibration={startFinishCalibration}
              onStartFinishPlacement={setStartFinishPlacement}
              viewMode={viewMode}
              markers={markers}
              environmentBundle={
                terrainModeActive ? environmentBundle ?? null : null
              }
              environmentTerrain={environmentTerrain}
              widthProfile={widthProfile ?? null}
              realWidthEnabled={realWidthEnabled}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              {loadingTrack ? t.loadingTrack : t.selectTrack}
            </div>
          )}

          <TrackOverlay
            properties={properties}
            loadingElevations={loadingElevations}
            startFinishStatus={startFinishPlacement?.source ?? null}
            viewMode={viewMode}
            markers={markers}
            environmentActive={terrainModeActive}
          />

          {properties && (
            <MobileLayersSheet
              autoRotate={autoRotate}
              setAutoRotate={setAutoRotate}
              elevationEnabled={elevationEnabled}
              setElevationEnabled={setElevationEnabled}
              trackWidth={trackWidth}
              setTrackWidth={setTrackWidth}
              onCameraPreset={handleCameraPreset}
              viewMode={viewMode}
              setViewMode={handleViewModeChange}
              sectorsAvailable={sectorsAvailable}
              environmentAvailable={!!environmentBundle}
              environmentEnabled={environmentEnabled}
              setEnvironmentEnabled={setEnvironmentEnabled}
              environmentTerrain={environmentTerrain}
              setEnvironmentTerrain={setEnvironmentTerrain}
              realWidthAvailable={realWidthAvailable}
              realWidthEnabled={realWidthEnabled}
              setRealWidthEnabled={handleRealWidthChange}
              meanWidthMeters={widthProfile?.meanWidthMeters ?? null}
              minWidthMeters={widthProfile?.minWidthMeters ?? null}
              maxWidthMeters={widthProfile?.maxWidthMeters ?? null}
            />
          )}

          <MobileInfoSheet
            properties={properties}
            loadingTrack={loadingTrack}
            pointCount={pointCount}
            elevations={elevations}
            elevationEnabled={elevationEnabled && !terrainModeActive}
            markers={markers}
            viewMode={viewMode}
            trackWidth={trackWidth}
            realWidthAvailable={realWidthAvailable}
            realWidthEnabled={realWidthEnabled}
            meanWidthMeters={widthProfile?.meanWidthMeters ?? null}
            minWidthMeters={widthProfile?.minWidthMeters ?? null}
            maxWidthMeters={widthProfile?.maxWidthMeters ?? null}
            open={mobileInfoOpen}
            onOpenChange={setMobileInfoOpen}
          />
        </main>

        <aside className="hidden min-h-0 border-l border-border bg-sidebar/50 md:block">
          <TrackSidePanel
            properties={properties}
            loading={loadingTrack}
            pointCount={pointCount}
            elevations={elevations}
            elevationEnabled={elevationEnabled}
            markers={markers}
            viewMode={viewMode}
            autoRotate={autoRotate}
            setAutoRotate={setAutoRotate}
            setElevationEnabled={setElevationEnabled}
            trackWidth={trackWidth}
            setTrackWidth={setTrackWidth}
            onCameraPreset={handleCameraPreset}
            setViewMode={handleViewModeChange}
            sectorsAvailable={sectorsAvailable}
            environmentAvailable={!!environmentBundle}
            environmentEnabled={environmentEnabled}
            setEnvironmentEnabled={setEnvironmentEnabled}
            environmentTerrain={environmentTerrain}
            setEnvironmentTerrain={setEnvironmentTerrain}
            realWidthAvailable={realWidthAvailable}
            realWidthEnabled={realWidthEnabled}
            setRealWidthEnabled={handleRealWidthChange}
            meanWidthMeters={widthProfile?.meanWidthMeters ?? null}
            minWidthMeters={widthProfile?.minWidthMeters ?? null}
            maxWidthMeters={widthProfile?.maxWidthMeters ?? null}
          />
        </aside>
      </div>

      {!footerDismissed && (
        <footer className="shrink-0 border-t border-border bg-background/80 text-[10px] text-muted-foreground backdrop-blur">
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (window.innerWidth < 768) {
                setFooterExpanded((expanded) => !expanded);
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (window.innerWidth < 768) {
                setFooterExpanded((expanded) => !expanded);
              }
            }}
            className="grid w-full grid-cols-[1fr_auto] gap-3 px-4 py-2 text-left"
          >
            <span className="min-w-0">
              <span className="font-semibold text-foreground/80">
                {t.disclaimerTitle}:
              </span>{" "}
              <span
                className={
                  footerExpanded
                    ? "whitespace-normal"
                    : "line-clamp-1 md:line-clamp-none"
                }
              >
                {t.disclaimerBody}
              </span>
              <span
                className={
                  footerExpanded
                    ? "mt-1 block whitespace-normal text-muted-foreground/80"
                    : "mt-1 hidden whitespace-normal text-muted-foreground/80 md:block"
                }
              >
                <span className="font-medium text-foreground/70">
                  {t.dataSourcesTitle}:
                </span>{" "}
                bacinger/f1-circuits (MIT) · Open-Meteo (CC-BY 4.0) · Jolpica
                (AGPL-3.0) · TUMFTM/racetrack-database (LGPL-3.0) ·
                OpenStreetMap (ODbL)
              </span>
            </span>
            <button
              type="button"
              aria-label="Hide disclaimer"
              onClick={(event) => {
                event.stopPropagation();
                setFooterDismissed(true);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
