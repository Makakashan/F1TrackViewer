"use client";

import { useState, useCallback } from "react";
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

export default function F1TrackApp({
  startFinishCalibration = false,
}: F1TrackAppProps) {
  const { t, resolvedTheme } = useAppPref();
  const [error, setError] = useState<string | null>(null);
  const { circuits, selectedId, loadingIndex, onSelect } =
    useCircuits(setError);
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

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      setMobileListOpen(false);
    },
    [onSelect],
  );

  const handleCameraPreset = useCallback((preset: CameraPreset) => {
    setCameraPreset(preset);
    setTimeout(() => setCameraPreset(null), 50);
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
              key={`${selectedId}-${trackWidth}-${elevationEnabled}-${elevations?.length ?? 0}-${resolvedTheme}-${startFinishCalibration}`}
              geojson={geojson}
              elevations={elevationEnabled ? elevations : null}
              trackWidth={trackWidth}
              autoRotate={autoRotate}
              resolvedTheme={resolvedTheme}
              cameraPreset={cameraPreset}
              startFinishCalibration={startFinishCalibration}
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
            bacinger/f1-circuits (MIT) · Open-Meteo (CC-BY 4.0) · OpenF1 ·
            Jolpica (AGPL-3.0) · TUMFTM/racetrack-database (LGPL-3.0)
          </span>
        </div>
      </footer>
    </div>
  );
}
