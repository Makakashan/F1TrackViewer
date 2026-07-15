"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Globe2, RefreshCw, Flag, X } from "lucide-react";
import TrackOverlay from "@/components/track-overlay";
import TrackSidePanel from "@/components/track-side-panel";
import ErrorBanner from "@/components/error-banner";
import MobileInfoSheet from "@/components/mobile-info-sheet";
import MobileLayersSheet from "@/components/mobile-layers-sheet";
import SettingsMenu from "@/components/settings-menu";
import { Button } from "@/components/ui/button";
import { useAppPref } from "@/components/app-pref-provider";
import { type CircuitProperties } from "@/lib/f1-circuits";
import { useCircuits } from "@/hooks/use-circuits";
import { useTrackData } from "@/hooks/use-track-data";
import type { StartFinishPlacement } from "@/lib/start-finish";
import type { TrackMarkers, TrackViewMode } from "@/lib/track-markers";
import { fetchTrackMarkers } from "@/lib/track-markers";
import type { EnvironmentBundle } from "@/lib/environment-types";
import { fetchEnvironmentBundle, hasEnvironment } from "@/lib/environment-loader";
import type { TrackWidthProfile } from "@/lib/track-width";
import { fetchTrackWidthProfile } from "@/lib/track-width";
import { useUrlState } from "@/lib/url-state";

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

const DISCLAIMER_DISMISSED_STORAGE_KEY = "f1tv-disclaimer-dismissed";

export default function F1TrackApp({
  startFinishCalibration = false,
}: F1TrackAppProps) {
  const { t, resolvedTheme } = useAppPref();
  const [error, setError] = useState<string | null>(null);
  const { circuits, selectedId, onSelect } = useCircuits(setError);
  const {
    track: urlTrack,
    trackWidth,
    elevationEnabled,
    cameraPreset,
    viewMode,
    environmentEnabled,
    environmentTerrain,
    realWidthEnabled,
    qualityMode,
    hydrated,
    setTrack: setUrlTrack,
    setTrackWidth: setUrlTrackWidth,
    setElevationEnabled: setUrlElevationEnabled,
    setCameraPreset: setUrlCameraPreset,
    setViewMode: setUrlViewMode,
    setEnvironmentEnabled: setUrlEnvironmentEnabled,
    setEnvironmentTerrain: setUrlEnvironmentTerrain,
    setRealWidthEnabled: setUrlRealWidthEnabled,
    setQualityMode: setUrlQualityMode,
    hydrate,
    syncUrl,
  } = useUrlState();

  const { geojson, loadingTrack, elevations, loadingElevations } = useTrackData(
    selectedId,
    setError,
  );
  const [autoRotate, setAutoRotate] = useState(true);
  // Real per-point track width (TUMFTM). null = no profile for this circuit,
  // undefined = still loading.
  const [widthProfile, setWidthProfile] =
    useState<TrackWidthProfile | null | undefined>(undefined);
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const [startFinishPlacement, setStartFinishPlacement] =
    useState<StartFinishPlacement | null>(null);
  const [footerExpanded, setFooterExpanded] = useState(false);
  const [footerDismissed, setFooterDismissed] = useState(true);
  const [markers, setMarkers] = useState<TrackMarkers | null>(null);
  // Environment diorama. ?environment=1 opts in; null means
  // "no bundle for this circuit", undefined means "still checking".
  const [environmentBundle, setEnvironmentBundle] =
    useState<EnvironmentBundle | null | undefined>(undefined);
  // Cheap manifest-only check (~1KB) so the toggle can be gated and the URL
  // can persist environment=0 without downloading the full multi-MB bundle
  // (buildings/roads/landuse) for circuits the user never opts into.
  const [environmentAvailable, setEnvironmentAvailable] =
    useState<boolean | undefined>(undefined);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setFooterDismissed(
          localStorage.getItem(DISCLAIMER_DISMISSED_STORAGE_KEY) === "1",
        );
      } catch {
        setFooterDismissed(false);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // ─── Hydrate URL state on mount ──────────────────────────────────
  const didHydrate = useRef(false);
  useEffect(() => {
    if (didHydrate.current) return;
    didHydrate.current = true;
    hydrate(circuits);
  }, [circuits, hydrate]);

  // ─── Sync URL when state changes (after hydration) ───────────────
  useEffect(() => {
    if (!hydrated || !selectedId) return;
    syncUrl({
      environmentBundleAvailable: !!environmentAvailable,
      widthProfileAvailable: !!widthProfile,
    });
  }, [
    hydrated,
    selectedId,
    trackWidth,
    elevationEnabled,
    cameraPreset,
    viewMode,
    environmentEnabled,
    environmentTerrain,
    realWidthEnabled,
    qualityMode,
    environmentAvailable,
    widthProfile,
    syncUrl,
  ]);

  // ─── Apply URL track selection to useCircuits ────────────────────
  const didApplyUrlTrack = useRef(false);
  useEffect(() => {
    if (didApplyUrlTrack.current) return;
    if (!circuits.length || !hydrated) return;
    didApplyUrlTrack.current = true;
    if (!urlTrack || selectedId === urlTrack) return;
    if (!circuits.some((c) => c.id === urlTrack)) return;
    const timer = window.setTimeout(() => onSelect(urlTrack), 0);
    return () => window.clearTimeout(timer);
  }, [circuits, hydrated, onSelect, selectedId, urlTrack]);

  // ─── Load track markers when selected track changes ──────────────
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

  // ─── Check environment availability for the selected circuit ────
  // Cheap manifest-only check — runs regardless of the toggle so the UI
  // knows whether to offer 3D mode at all.
  useEffect(() => {
    if (!selectedId) {
      const timer = window.setTimeout(() => setEnvironmentAvailable(undefined), 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    const timer = window.setTimeout(() => setEnvironmentAvailable(undefined), 0);
    hasEnvironment(selectedId).then((available) => {
      if (!cancelled) setEnvironmentAvailable(available);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedId]);

  // ─── Load the full environment bundle — only once the user opts in ─
  // Buildings/roads/landuse can be several MB per circuit, so this stays
  // lazy: it never downloads unless environmentEnabled is actually true.
  useEffect(() => {
    if (!selectedId || !environmentEnabled) {
      const timer = window.setTimeout(() => setEnvironmentBundle(undefined), 0);
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
  }, [selectedId, environmentEnabled]);

  // ─── Load the real-width profile (TUMFTM) ────────────────────────
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

  // ─── Auto-disable environment when the selected circuit has no bundle ─
  useEffect(() => {
    if (selectedId && environmentAvailable === false && environmentEnabled) {
      const timer = window.setTimeout(() => setUrlEnvironmentEnabled(false), 0);
      return () => window.clearTimeout(timer);
    }
  }, [environmentAvailable, environmentEnabled, selectedId, setUrlEnvironmentEnabled]);

  // ─── Reset view mode when markers confirm no sectors ─────────────
  useEffect(() => {
    if (
      viewMode === "sectors" &&
      markers !== null &&
      !markers.sectors?.length
    ) {
      const timer = window.setTimeout(() => setUrlViewMode("normal"), 0);
      return () => window.clearTimeout(timer);
    }
  }, [markers, viewMode, setUrlViewMode]);

  // ─── Mutual exclusion: sectors ↔ real width ──────────────────────
  const handleViewModeChange = useCallback(
    (next: TrackViewMode) => {
      setUrlViewMode(next);
      if (next === "sectors") setUrlRealWidthEnabled(false);
    },
    [setUrlViewMode, setUrlRealWidthEnabled],
  );

  const handleRealWidthChange = useCallback(
    (enabled: boolean) => {
      setUrlRealWidthEnabled(enabled);
      if (enabled) setUrlViewMode("normal");
    },
    [setUrlRealWidthEnabled, setUrlViewMode],
  );

  const handleBackToGlobe = useCallback(() => {
    window.location.href = window.location.pathname || "/";
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
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={handleBackToGlobe}
          >
            <Globe2 className="h-4 w-4" />
            Earth
          </Button>
          <SettingsMenu />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px]">
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
              qualityMode={qualityMode}
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
            onOpenCircuit={() => setMobileInfoOpen(true)}
          />

          {properties && (
            <MobileLayersSheet
              autoRotate={autoRotate}
              setAutoRotate={setAutoRotate}
              elevationEnabled={elevationEnabled}
              setElevationEnabled={setUrlElevationEnabled}
              trackWidth={trackWidth}
              setTrackWidth={setUrlTrackWidth}
              onCameraPreset={setUrlCameraPreset}
              viewMode={viewMode}
              setViewMode={handleViewModeChange}
              sectorsAvailable={sectorsAvailable}
              environmentAvailable={!!environmentAvailable}
              environmentEnabled={environmentEnabled}
              setEnvironmentEnabled={setUrlEnvironmentEnabled}
              environmentTerrain={environmentTerrain}
              setEnvironmentTerrain={setUrlEnvironmentTerrain}
              realWidthAvailable={realWidthAvailable}
              realWidthEnabled={realWidthEnabled}
              setRealWidthEnabled={handleRealWidthChange}
              meanWidthMeters={widthProfile?.meanWidthMeters ?? null}
              minWidthMeters={widthProfile?.minWidthMeters ?? null}
              maxWidthMeters={widthProfile?.maxWidthMeters ?? null}
              qualityMode={qualityMode}
              setQualityMode={setUrlQualityMode}
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
            showTrigger={false}
          />
        </main>

        <aside className="hidden min-h-0 border-l border-border bg-sidebar/70 shadow-[-24px_0_80px_rgba(0,0,0,0.22)] backdrop-blur-xl md:block">
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
            setElevationEnabled={setUrlElevationEnabled}
            trackWidth={trackWidth}
            setTrackWidth={setUrlTrackWidth}
            onCameraPreset={setUrlCameraPreset}
            setViewMode={handleViewModeChange}
            sectorsAvailable={sectorsAvailable}
            environmentAvailable={!!environmentAvailable}
            environmentEnabled={environmentEnabled}
            setEnvironmentEnabled={setUrlEnvironmentEnabled}
            environmentTerrain={environmentTerrain}
            setEnvironmentTerrain={setUrlEnvironmentTerrain}
            realWidthAvailable={realWidthAvailable}
            realWidthEnabled={realWidthEnabled}
            setRealWidthEnabled={handleRealWidthChange}
            meanWidthMeters={widthProfile?.meanWidthMeters ?? null}
            minWidthMeters={widthProfile?.minWidthMeters ?? null}
            maxWidthMeters={widthProfile?.maxWidthMeters ?? null}
            qualityMode={qualityMode}
            setQualityMode={setUrlQualityMode}
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
                try {
                  localStorage.setItem(DISCLAIMER_DISMISSED_STORAGE_KEY, "1");
                } catch {
                  // Ignore storage failures; the current session still hides it.
                }
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
