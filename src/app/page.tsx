"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { ChevronRight, RefreshCw, RotateCw, Flag, Mountain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import CircuitList from "@/components/circuit-list";
import TrackInfo from "@/components/track-info";
import SettingsMenu from "@/components/settings-menu";
import { useAppPref } from "@/components/app-pref-provider";
import {
  fetchCircuitIndex,
  fetchCircuitGeoJson,
  type CircuitLocation,
  type CircuitGeoJSON,
  type CircuitProperties,
} from "@/lib/f1-circuits";
import { fetchElevations } from "@/lib/geo-utils";

// Three.js scene must be client-only — no SSR for WebGL.
const TrackViewer = dynamic(() => import("@/components/track-viewer"), {
  ssr: false,
  loading: () => {
    // Can't use hooks here; the parent passes the translated string via a
    // prop on <TrackViewerLoaderFallback> if we wanted to. For now, English
    // fallback is fine because the actual Canvas replaces it in <100ms.
    return (
      <div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        Loading Three.js…
      </div>
    );
  },
});

export default function Home() {
  const { t, resolvedTheme } = useAppPref();
  const [circuits, setCircuits] = useState<CircuitLocation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [geojson, setGeojson] = useState<CircuitGeoJSON | null>(null);
  const [loadingIndex, setLoadingIndex] = useState(true);
  const [loadingTrack, setLoadingTrack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [trackWidth, setTrackWidth] = useState(7);
  const [elevations, setElevations] = useState<number[] | null>(null);
  const [loadingElevations, setLoadingElevations] = useState(false);
  const [elevationEnabled, setElevationEnabled] = useState(true);
  const [elevationScale, setElevationScale] = useState(3);

  useEffect(() => {
    let cancelled = false;
    fetchCircuitIndex()
      .then((list) => {
        if (cancelled) return;
        list.sort((a, b) => a.name.localeCompare(b.name));
        setCircuits(list);
        const initial =
          list.find((c) => c.id === "mc-1929") ?? list[0] ?? null;
        if (initial) setSelectedId(initial.id);
      })
      .catch((e) => {
        if (!cancelled) setError(`${t.errLoadCircuits}: ${String(e)}`);
      })
      .finally(() => !cancelled && setLoadingIndex(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingTrack(true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingElevations(true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);

    fetchCircuitGeoJson(selectedId)
      .then((g) => {
        if (cancelled) return;
        setGeojson(g);
        const coords = g.features[0]?.geometry.coordinates ?? [];
        return fetchElevations(coords);
      })
      .then((e) => {
        if (cancelled) return;
        setElevations(e);
      })
      .catch((e) => {
        if (!cancelled) setError(`${t.errLoadTrack} ${selectedId}: ${String(e)}`);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingTrack(false);
        setLoadingElevations(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const handleSelect = useCallback((id: string) => setSelectedId(id), []);

  const handleReload = useCallback(() => {
    if (selectedId) setSelectedId(null);
    requestAnimationFrame(() => setSelectedId(selectedId));
  }, [selectedId]);

  const properties: CircuitProperties | null =
    geojson?.features[0]?.properties ?? null;
  const pointCount = geojson?.features[0]?.geometry.coordinates.length;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* === Top bar === */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-red-600 to-orange-600 shadow-[0_0_20px_rgba(225,6,0,0.4)]">
              <Flag className="h-4 w-4 text-white" />
            </div>
            <div className="leading-none">
              <div className="text-sm font-bold tracking-tight">
                {t.appName}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {t.appTagline}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-3 text-xs text-muted-foreground md:flex">
            <div className="flex items-center gap-2">
              <Switch
                id="autorotate"
                checked={autoRotate}
                onCheckedChange={setAutoRotate}
              />
              <Label htmlFor="autorotate" className="cursor-pointer">
                <RotateCw className="mr-1 inline h-3 w-3" />
                {t.autoRotate}
              </Label>
            </div>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2">
              <Switch
                id="elevation"
                checked={elevationEnabled}
                onCheckedChange={setElevationEnabled}
              />
              <Label htmlFor="elevation" className="cursor-pointer">
                <Mountain className="mr-1 inline h-3 w-3" />
                {t.elevations}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="elevscale" className="text-muted-foreground">
                ×
              </Label>
              <input
                id="elevscale"
                type="range"
                min={1}
                max={8}
                step={1}
                value={elevationScale}
                onChange={(e) => setElevationScale(Number(e.target.value))}
                className="h-1 w-20 cursor-pointer accent-[#e10600]"
              />
              <span className="w-6 tabular-nums text-foreground">
                {elevationScale}
              </span>
            </div>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex items-center gap-2">
              <Label htmlFor="width" className="text-muted-foreground">
                {t.trackWidth}
              </Label>
              <input
                id="width"
                type="range"
                min={3}
                max={15}
                step={1}
                value={trackWidth}
                onChange={(e) => setTrackWidth(Number(e.target.value))}
                className="h-1 w-20 cursor-pointer accent-[#e10600]"
              />
              <span className="w-10 tabular-nums text-foreground">
                {trackWidth}{t.unitM}
              </span>
            </div>
          </div>
          <Separator orientation="vertical" className="h-5" />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReload}
            disabled={!selectedId || loadingTrack}
            className="text-muted-foreground hover:text-foreground"
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${loadingTrack ? "animate-spin" : ""}`}
            />
            {t.btnReload}
          </Button>
          <SettingsMenu />
        </div>
      </header>

      {/* === Main 3-column layout === */}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)_320px]">
        {/* Left: circuit list */}
        <aside className="hidden min-h-0 border-r border-border bg-sidebar/50 md:block">
          {loadingIndex ? (
            <div className="space-y-2 p-4">
              <div className="h-3 w-16 animate-pulse rounded bg-muted" />
              <div className="h-9 w-full animate-pulse rounded bg-muted" />
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="h-12 w-full animate-pulse rounded bg-muted/60"
                />
              ))}
              <div className="text-[11px] text-muted-foreground">
                {t.loadingCircuits}
              </div>
            </div>
          ) : (
            <CircuitList
              circuits={circuits}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
          )}
        </aside>

        {/* Center: 3D viewer */}
        <main className="relative min-h-0 bg-background">
          {error && (
            <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-destructive/60 bg-destructive/15 px-4 py-2 text-xs text-destructive backdrop-blur">
              {error}
            </div>
          )}
          {geojson ? (
            <TrackViewer
              key={`${selectedId}-${trackWidth}-${elevationEnabled}-${elevationScale}-${elevations?.length ?? 0}-${resolvedTheme}`}
              geojson={geojson}
              elevations={elevationEnabled ? elevations : null}
              elevationScale={elevationScale}
              trackWidth={trackWidth}
              autoRotate={autoRotate}
              resolvedTheme={resolvedTheme}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              {loadingTrack ? t.loadingTrack : t.selectTrack}
            </div>
          )}

          {properties && (
            <div className="pointer-events-none absolute bottom-4 left-4 z-10">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-[0.2em] text-primary/80">
                <ChevronRight className="h-3 w-3" />
                {t.nowViewing}
              </div>
              <div className="mt-0.5 text-2xl font-bold text-foreground drop-shadow-lg">
                {properties.Name}
              </div>
              <div className="text-xs text-muted-foreground">
                {properties.Location} · {(properties.length / 1000).toFixed(3)}{" "}
                {t.unitKm} · {t.opened.toLowerCase()} {properties.opened}
              </div>
              {loadingElevations && (
                <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-500/80">
                  <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                  {t.loadingElevations}
                </div>
              )}
            </div>
          )}

          <div className="pointer-events-none absolute bottom-4 right-4 z-10 rounded-md border border-border/80 bg-background/70 px-3 py-2 text-[10px] text-muted-foreground backdrop-blur">
            <div>
              <span className="text-foreground">{t.controlsLMB.split(" — ")[0]}</span>
              {" — "}
              {t.controlsLMB.split(" — ")[1]}
            </div>
            <div>
              <span className="text-foreground">{t.controlsRMB.split(" — ")[0]}</span>
              {" — "}
              {t.controlsRMB.split(" — ")[1]}
            </div>
            <div>
              <span className="text-foreground">{t.controlsWheel.split(" — ")[0]}</span>
              {" — "}
              {t.controlsWheel.split(" — ")[1]}
            </div>
          </div>
        </main>

        {/* Right: track info */}
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

      {/* === Footer disclaimer === */}
      <footer className="shrink-0 border-t border-border bg-background/60 px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span className="font-semibold text-foreground/80">
            {t.disclaimerTitle}:
          </span>
          <span className="max-w-[80vw] truncate md:max-w-none md:whitespace-normal">
            {t.disclaimerBody}
          </span>
          <Separator orientation="vertical" className="hidden h-3 md:block" />
          <span className="hidden md:inline">
            {t.dataSourcesTitle}:
          </span>
          <span className="hidden md:inline">
            bacinger/f1-circuits (MIT) · Open-Meteo (CC-BY 4.0) · OpenF1 · Jolpica (AGPL-3.0) · TUMFTM/racetrack-database (LGPL-3.0)
          </span>
        </div>
      </footer>
    </div>
  );
}
