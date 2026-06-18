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
import TrackInfo from "@/components/track-info";
import TrackControls from "@/components/track-controls";
import TrackOverlay from "@/components/track-overlay";
import ErrorBanner from "@/components/error-banner";
import MobileMenu from "@/components/mobile-menu";
import MobileInfoSheet from "@/components/mobile-info-sheet";
import { useAppPref } from "@/components/app-pref-provider";
import { type CircuitProperties } from "@/lib/f1-circuits";
import { useCircuits } from "@/hooks/use-circuts";
import { useTrackData } from "@/hooks/use-track-data";
import type { CameraPreset } from "@/components/track-viewer";
import type { StartFinishPlacement } from "@/lib/start-finish";
import type { TrackViewMode, TrackMarkers } from "@/lib/track-markers";
import { fetchTrackMarkers } from "@/lib/track-markers";

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
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset | null>(null);
  const [startFinishPlacement, setStartFinishPlacement] =
    useState<StartFinishPlacement | null>(null);
  const [footerExpanded, setFooterExpanded] = useState(false);
  const [footerDismissed, setFooterDismissed] = useState(false);
  const urlSectors = urlParams.get("sectors");
  const [viewMode, setViewMode] = useState<TrackViewMode>(() =>
    urlSectors === "1" ? "sectors" : "normal",
  );
  const [markers, setMarkers] = useState<TrackMarkers | null>(null);
  const didApplyInitialTrack = useRef(false);
  const didApplyInitialWidth = useRef(false);
  const didApplyInitialElevation = useRef(false);
  const didApplyInitialCamera = useRef(false);
  const didApplyInitialSectors = useRef(false);

  const urlTrack = urlParams.get("track");
  const urlWidth = parseWidthParam(urlParams.get("width"));
  const urlElevation = urlParams.get("elevation");
  const urlCamera = urlParams.get("camera");

  // Load track markers when selected track changes
  useEffect(() => {
    if (!selectedId) {
      setMarkers(null);
      return;
    }
    let cancelled = false;
    fetchTrackMarkers(selectedId).then((m) => {
      if (!cancelled) setMarkers(m);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Reset view mode only when markers explicitly confirm unavailability
  // (null = still loading, not yet unavailable)
  const prevMarkersRef = useRef<TrackMarkers | null>(null);
  useEffect(() => {
    // Only reset if markers were loaded and have no sectors
    if (viewMode === "sectors" && prevMarkersRef.current === undefined) {
      // markers was loaded but had no sectors — we already handled
    }
    if (viewMode === "sectors" && markers !== null && !markers.sectors?.length) {
      setViewMode("normal");
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

  // Hydrate viewMode from URL ?sectors=1
  useEffect(() => {
    if (didApplyInitialSectors.current) return;
    const urlSectorsNow = new URLSearchParams(window.location.search).get("sectors");
    const targetMode: TrackViewMode = urlSectorsNow === "1" ? "sectors" : "normal";
    if (targetMode === viewMode) {
      didApplyInitialSectors.current = true;
      return;
    }
    didApplyInitialSectors.current = true;
    const timer = window.setTimeout(() => setViewMode(targetMode), 0);
    return () => window.clearTimeout(timer);
  }, [viewMode]);

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
    if (viewMode === "sectors") {
      params.set("sectors", "1");
    } else {
      params.delete("sectors");
    }

    const nextSearch = `?${params.toString()}`;
    if (nextSearch === window.location.search) return;

    window.history.replaceState(null, "", nextSearch);
    notifyUrlStateSubscribers();
  }, [cameraPreset, circuits, elevationEnabled, selectedId, trackWidth, urlTrack, viewMode]);

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

  const properties: CircuitProperties | null =
    geojson?.features[0]?.properties ?? null;
  const pointCount = geojson?.features[0]?.geometry.coordinates.length;
  const sectorsAvailable = !!markers?.sectors?.length;

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
          <TrackControls
            autoRotate={autoRotate}
            setAutoRotate={setAutoRotate}
            elevationEnabled={elevationEnabled}
            setElevationEnabled={setElevationEnabled}
            trackWidth={trackWidth}
            setTrackWidth={setTrackWidth}
            onCameraPreset={handleCameraPreset}
            viewMode={viewMode}
            setViewMode={setViewMode}
            sectorsAvailable={sectorsAvailable}
          />
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
          />

          <MobileInfoSheet
            properties={properties}
            loadingTrack={loadingTrack}
            pointCount={pointCount}
            elevations={elevations}
            elevationEnabled={elevationEnabled}
            open={mobileInfoOpen}
            onOpenChange={setMobileInfoOpen}
          />
        </main>

        <aside className="hidden min-h-0 border-l border-border bg-sidebar/50 md:block">
          <TrackInfo
            properties={properties}
            loading={loadingTrack}
            pointCount={pointCount}
            elevations={elevations}
            elevationEnabled={elevationEnabled}
            markers={markers}
            viewMode={viewMode}
          />
        </aside>
      </div>

      {!footerDismissed && (
        <footer className="shrink-0 border-t border-border bg-background/80 text-[10px] text-muted-foreground backdrop-blur">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setFooterExpanded((expanded) => !expanded)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setFooterExpanded((expanded) => !expanded);
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
                (AGPL-3.0) · TUMFTM/racetrack-database (LGPL-3.0)
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
