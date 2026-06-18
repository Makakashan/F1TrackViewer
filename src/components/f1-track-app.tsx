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
import { RefreshCw, Flag } from "lucide-react";
import { Separator } from "@/components/ui/separator";
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
  const didApplyInitialTrack = useRef(false);
  const didApplyInitialWidth = useRef(false);
  const didApplyInitialElevation = useRef(false);
  const didApplyInitialCamera = useRef(false);

  const urlTrack = urlParams.get("track");
  const urlWidth = parseWidthParam(urlParams.get("width"));
  const urlElevation = urlParams.get("elevation");
  const urlCamera = urlParams.get("camera");

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

    const nextSearch = `?${params.toString()}`;
    if (nextSearch === window.location.search) return;

    window.history.replaceState(null, "", nextSearch);
    notifyUrlStateSubscribers();
  }, [cameraPreset, circuits, elevationEnabled, selectedId, trackWidth, urlTrack]);

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
          />
        </aside>
      </div>

      <footer className="shrink-0 border-t border-border bg-background/60 px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span className="font-semibold text-foreground/80">
            {t.disclaimerTitle}:
          </span>
          <span className="max-w-[80vw] truncate md:max-w-none md:whitespace-normal">
            {t.disclaimerBody}
          </span>
          <Separator orientation="vertical" className="hidden h-3 md:block" />
          <span className="hidden md:inline">{t.dataSourcesTitle}:</span>
          <span className="hidden md:inline">
            bacinger/f1-circuits (MIT) · Open-Meteo (CC-BY 4.0) ·
            Jolpica (AGPL-3.0) · TUMFTM/racetrack-database (LGPL-3.0)
          </span>
        </div>
      </footer>
    </div>
  );
}
